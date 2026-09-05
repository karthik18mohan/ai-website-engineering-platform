import { performance } from 'node:perf_hooks'

import { Sandbox } from '@vercel/sandbox'

const image = process.argv[2]
if (image === undefined || !/^sandbox-benchmark@sha256:[a-f0-9]{64}$/u.test(image)) {
  throw new Error('Expected a digest-pinned sandbox-benchmark image reference.')
}
if (process.env['VERCEL_ENV'] !== 'preview') {
  throw new Error('Live Sandbox benchmarking is restricted to Vercel Preview.')
}

const startedAt = performance.now()
const sandbox = await Sandbox.create({
  image,
  name: `m08-image-${Date.now()}`,
  networkPolicy: 'deny-all',
  persistent: false,
  ports: [],
  resources: { vcpus: 2 },
  timeout: 60_000,
  env: {},
  tags: { purpose: 'm08-nonproduction-benchmark' },
})
const startupMs = performance.now() - startedAt

try {
  const commandStartedAt = performance.now()
  const identity = await sandbox.runCommand({ cmd: '/usr/bin/id', args: ['-u'] })
  const commandMs = performance.now() - commandStartedAt
  const identityOutput = (await identity.stdout()).trim()

  const failure = await sandbox.runCommand({ cmd: '/usr/bin/false', args: [] })
  if (identity.exitCode !== 0 || identityOutput !== '10001' || failure.exitCode === 0) {
    throw new Error('Sandbox image behavior did not match the reviewed non-root contract.')
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: '1',
      image,
      sandboxName: sandbox.name,
      startupMs: Math.round(startupMs),
      commandMs: Math.round(commandMs),
      commandExitCode: identity.exitCode,
      failureExitCode: failure.exitCode,
      nonRootUid: Number(identityOutput),
      networkPolicy: 'deny-all',
    })}\n`,
  )
} finally {
  const teardownStartedAt = performance.now()
  await sandbox.stop()
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: '1', teardownMs: Math.round(performance.now() - teardownStartedAt), status: 'stopped' })}\n`,
  )
}
