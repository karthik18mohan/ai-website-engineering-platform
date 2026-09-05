#!/usr/local/bin/node

import { createHash } from 'node:crypto'
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

import {
  runnerBrokerRequestV1Schema,
  type RunnerBrokerExecuteRequestV1,
} from './broker-protocol.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1, vercelRunnerImageSpecDigest } from './image-policy.js'

const CONTROL_FILE_PATTERN = /^\/home\/runner\/\.platform-control\/[a-f0-9-]{36}\.json$/u
const MAX_CONTROL_BYTES = 262_144
const MAX_BUNDLE_BYTES = 1_073_741_824
const MAX_CAPTURED_OUTPUT_BYTES = 16_777_216
const MONITOR_INTERVAL_MS = 100
const EMPTY_DIGEST = createHash('sha256').digest('hex')

async function main(): Promise<void> {
  if (process.argv[2] === '--self-check') {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: '1',
        imageSpecDigest: vercelRunnerImageSpecDigest(),
        nodeVersion: process.versions.node,
        platform: process.platform,
        brokerPath: VERCEL_RUNNER_IMAGE_SPEC_V1.commandBrokerPath,
      })}\n`,
    )
    return
  }

  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('The runner broker must start as root inside the Linux runner image.')
  }

  const controlPath = process.argv[2]
  if (controlPath === undefined || !CONTROL_FILE_PATTERN.test(controlPath)) {
    throw new Error('Broker control path is invalid.')
  }

  const controlStat = await lstat(controlPath)
  if (
    !controlStat.isFile() ||
    controlStat.isSymbolicLink() ||
    controlStat.uid !== VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.uid ||
    (controlStat.mode & 0o022) !== 0 ||
    controlStat.size > MAX_CONTROL_BYTES
  ) {
    throw new Error('Broker control file ownership, mode, type, or size is invalid.')
  }

  const request = runnerBrokerRequestV1Schema.parse(JSON.parse(await readFile(controlPath, 'utf8')))
  await unlink(controlPath)

  const result =
    request.action === 'checkout' ? await checkout(request) : await executeCommand(request)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function checkout(
  request: Extract<ReturnType<typeof runnerBrokerRequestV1Schema.parse>, { action: 'checkout' }>,
) {
  if (
    request.bundlePath !== `${VERCEL_RUNNER_IMAGE_SPEC_V1.controlRoot}/${request.requestId}.bundle`
  ) {
    return checkoutFailure(request.requestId, 'CHECKOUT_FAILED')
  }
  const bundleStat = await lstat(request.bundlePath)
  if (
    !bundleStat.isFile() ||
    bundleStat.isSymbolicLink() ||
    bundleStat.uid !== VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.uid ||
    (bundleStat.mode & 0o022) !== 0 ||
    bundleStat.size > MAX_BUNDLE_BYTES
  ) {
    return checkoutFailure(request.requestId, 'CHECKOUT_FAILED')
  }

  if ((await digestFile(request.bundlePath)) !== request.bundleDigest) {
    await unlink(request.bundlePath).catch(() => undefined)
    return checkoutFailure(request.requestId, 'BUNDLE_DIGEST_MISMATCH')
  }

  const workspaceRoot = VERCEL_RUNNER_IMAGE_SPEC_V1.workspaceRoot
  const stagedBundle = '/workspace/.platform-checkout.bundle'
  await rm(workspaceRoot, { force: true, recursive: true })
  await mkdir(dirname(workspaceRoot), { recursive: true })
  await copyFile(request.bundlePath, stagedBundle)
  await unlink(request.bundlePath)
  await chown(
    stagedBundle,
    VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.uid,
    VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.gid,
  )
  await chmod(stagedBundle, 0o400)
  await chown(
    dirname(workspaceRoot),
    VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.uid,
    VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.gid,
  )
  dropPrivileges()

  try {
    const clone = await run(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--no-checkout',
        '--no-hardlinks',
        stagedBundle,
        workspaceRoot,
      ],
      '/workspace',
      300_000,
    )
    if (clone.exitCode !== 0) return checkoutFailure(request.requestId, 'CHECKOUT_FAILED')

    const checkoutResult = await run(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', '--force', request.baseCommit],
      workspaceRoot,
      120_000,
    )
    if (checkoutResult.exitCode !== 0) return checkoutFailure(request.requestId, 'CHECKOUT_FAILED')

    const [head, status, tree] = await Promise.all([
      run('/usr/bin/git', ['rev-parse', 'HEAD'], workspaceRoot, 30_000),
      run(
        '/usr/bin/git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        workspaceRoot,
        30_000,
      ),
      run('/usr/bin/git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], workspaceRoot, 30_000),
    ])
    const commit = head.stdout.toString('utf8').trim()
    const clean = status.stdout.length === 0
    if (
      head.exitCode !== 0 ||
      status.exitCode !== 0 ||
      tree.exitCode !== 0 ||
      commit !== request.baseCommit ||
      !clean
    ) {
      return checkoutFailure(request.requestId, 'CHECKOUT_FAILED')
    }

    return {
      schemaVersion: '1' as const,
      requestId: request.requestId,
      action: 'checkout' as const,
      status: 'succeeded' as const,
      commit,
      treeDigest: createHash('sha256').update(tree.stdout).digest('hex'),
      detached: true,
      clean: true,
    }
  } finally {
    await unlink(stagedBundle).catch(() => undefined)
  }
}

async function executeCommand(request: RunnerBrokerExecuteRequestV1) {
  const imageLimits = VERCEL_RUNNER_IMAGE_SPEC_V1.controls
  if (
    request.timeoutMs > imageLimits.maxTimeoutMs ||
    request.limits.maxProcesses > imageLimits.maxProcesses ||
    request.limits.maxFiles > imageLimits.maxFiles ||
    request.limits.maxBytes > imageLimits.maxBytes
  ) {
    return executeFailure(request, 'COMMAND_NOT_ALLOWED')
  }
  const commandPath = VERCEL_RUNNER_IMAGE_SPEC_V1.commandPaths.find(
    ({ executable }) => executable === request.executable,
  )?.path
  if (commandPath === undefined) return executeFailure(request, 'COMMAND_NOT_ALLOWED')

  const workspaceRoot = VERCEL_RUNNER_IMAGE_SPEC_V1.workspaceRoot
  const cwd = resolve(workspaceRoot, request.workingDirectory)
  if (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}${sep}`)) {
    return executeFailure(request, 'COMMAND_NOT_ALLOWED')
  }
  dropPrivileges()

  const initialMeasure = await measureWorkspace(workspaceRoot)
  if (
    initialMeasure.files > request.limits.maxFiles ||
    initialMeasure.bytes > request.limits.maxBytes
  ) {
    return executeFailure(request, 'FILESYSTEM_LIMIT_EXCEEDED')
  }

  const startedAt = Date.now()
  let limitFailure:
    'FILESYSTEM_LIMIT_EXCEEDED' | 'OUTPUT_LIMIT_EXCEEDED' | 'TIME_LIMIT_EXCEEDED' | undefined
  const child = spawn(
    '/usr/bin/prlimit',
    [
      `--nproc=${request.limits.maxProcesses}:${request.limits.maxProcesses}`,
      '--',
      commandPath,
      ...request.arguments,
    ],
    {
      cwd,
      detached: true,
      env: {
        CI: '1',
        HOME: '/home/runner',
        LANG: 'C.UTF-8',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        npm_config_ignore_scripts: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const outputLimit = Math.min(request.limits.maxBytes, MAX_CAPTURED_OUTPUT_BYTES)
  let capturedOutputBytes = 0
  const capture = (target: Buffer[], chunk: Buffer) => {
    capturedOutputBytes += chunk.length
    if (capturedOutputBytes > outputLimit) {
      limitFailure = 'OUTPUT_LIMIT_EXCEEDED'
      killProcessGroup(child.pid)
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
  child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk))

  const timer = setTimeout(() => {
    limitFailure = 'TIME_LIMIT_EXCEEDED'
    killProcessGroup(child.pid)
  }, request.timeoutMs)
  const monitor = setInterval(() => {
    void measureWorkspace(workspaceRoot)
      .then(({ files, bytes }) => {
        if (files > request.limits.maxFiles || bytes > request.limits.maxBytes) {
          limitFailure = 'FILESYSTEM_LIMIT_EXCEEDED'
          killProcessGroup(child.pid)
        }
      })
      .catch(() => {
        limitFailure = 'FILESYSTEM_LIMIT_EXCEEDED'
        killProcessGroup(child.pid)
      })
  }, MONITOR_INTERVAL_MS)

  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => resolveExit(code ?? (signal === null ? 1 : 128)))
  }).finally(() => {
    clearTimeout(timer)
    clearInterval(monitor)
  })

  const stdoutBuffer = Buffer.concat(stdout)
  const stderrBuffer = Buffer.concat(stderr)
  if (limitFailure !== undefined) return executeFailure(request, limitFailure)

  const artifactEvidence =
    exitCode === 0 ? await captureArtifacts(request, workspaceRoot) : ([] as const)
  if (artifactEvidence === undefined) {
    return {
      schemaVersion: '1' as const,
      requestId: request.requestId,
      action: 'execute' as const,
      status: 'failed' as const,
      failureCode: 'ARTIFACT_CAPTURE_FAILED' as const,
      exitCode,
      durationMs: Date.now() - startedAt,
      stdoutDigest: digestBuffer(stdoutBuffer),
      stderrDigest: digestBuffer(stderrBuffer),
      stdoutBytes: stdoutBuffer.length,
      stderrBytes: stderrBuffer.length,
      artifacts: [],
    }
  }

  return {
    schemaVersion: '1' as const,
    requestId: request.requestId,
    action: 'execute' as const,
    status: exitCode === 0 ? ('succeeded' as const) : ('failed' as const),
    failureCode: exitCode === 0 ? undefined : ('COMMAND_FAILED' as const),
    exitCode,
    durationMs: Date.now() - startedAt,
    stdoutDigest: digestBuffer(stdoutBuffer),
    stderrDigest: digestBuffer(stderrBuffer),
    stdoutBytes: stdoutBuffer.length,
    stderrBytes: stderrBuffer.length,
    artifacts: artifactEvidence,
  }
}

async function captureArtifacts(
  request: RunnerBrokerExecuteRequestV1,
  workspaceRoot: string,
): Promise<readonly { path: string; digest: string; sizeBytes: number }[] | undefined> {
  if (request.artifacts.expectedPaths.length > request.artifacts.maxCount) return undefined
  const root = await realpath(workspaceRoot)
  const evidence: { path: string; digest: string; sizeBytes: number }[] = []
  let totalBytes = 0
  try {
    for (const relativePath of request.artifacts.expectedPaths) {
      const candidate = resolve(workspaceRoot, relativePath)
      const resolved = await realpath(candidate)
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return undefined
      const before = await lstat(resolved)
      if (!before.isFile() || before.isSymbolicLink()) return undefined
      totalBytes += before.size
      if (totalBytes > request.artifacts.maxBytes) return undefined
      const artifactDigest = await digestFile(resolved)
      const after = await lstat(resolved)
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return undefined
      }
      evidence.push({ path: relativePath, digest: artifactDigest, sizeBytes: before.size })
    }
    return evidence
  } catch {
    return undefined
  }
}

function digestBuffer(value: Buffer): string {
  return value.length === 0 ? EMPTY_DIGEST : createHash('sha256').update(value).digest('hex')
}

async function run(command: string, args: readonly string[], cwd: string, timeoutMs: number) {
  const child = spawn(command, [...args], {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/home/runner',
      LANG: 'C.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code) => resolveExit(code ?? 1))
  }).finally(() => clearTimeout(timer))
  return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}

async function digestFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(chunk as Uint8Array)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function measureWorkspace(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else {
        files += 1
        if (entry.isFile()) bytes += (await lstat(path)).size
      }
    }
  }
  return { files, bytes }
}

function dropPrivileges(): void {
  if (process.getuid?.() !== 0) return
  process.setgroups?.([])
  process.setgid?.(VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.gid)
  process.setuid?.(VERCEL_RUNNER_IMAGE_SPEC_V1.runnerUser.uid)
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The command may have exited between observation and cancellation.
  }
}

function checkoutFailure(
  requestId: string,
  failureCode: 'BUNDLE_DIGEST_MISMATCH' | 'CHECKOUT_FAILED',
) {
  return {
    schemaVersion: '1' as const,
    requestId,
    action: 'checkout' as const,
    status: 'failed' as const,
    failureCode,
  }
}

function executeFailure(
  request: RunnerBrokerExecuteRequestV1,
  failureCode:
    | 'COMMAND_NOT_ALLOWED'
    | 'FILESYSTEM_LIMIT_EXCEEDED'
    | 'OUTPUT_LIMIT_EXCEEDED'
    | 'TIME_LIMIT_EXCEEDED',
) {
  return {
    schemaVersion: '1' as const,
    requestId: request.requestId,
    action: 'execute' as const,
    status: 'rejected' as const,
    failureCode,
  }
}

void main().catch((error: unknown) => {
  void error
  process.stderr.write('runner broker rejected request\n')
  process.exitCode = 64
})
