import { createHash } from 'node:crypto'

export const VERCEL_RUNNER_IMAGE_SPEC_V1 = {
  schemaVersion: '1',
  baseImage:
    'node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34',
  nodeVersion: '22.16.0',
  architecture: 'linux/amd64',
  runnerUser: { name: 'runner', uid: 10_001, gid: 10_001 },
  workspaceRoot: '/workspace/repository',
  controlRoot: '/home/runner/.platform-control',
  commandBrokerPath: '/opt/ai-website-platform/bin/runner-exec',
  approvedRegistries: ['https://registry.npmjs.org'],
  commandPaths: [
    { executable: 'node', path: '/usr/local/bin/node' },
    { executable: 'npm', path: '/usr/local/bin/npm' },
  ],
  packages: ['ca-certificates', 'git', 'tini', 'util-linux'],
  controls: {
    nonRootExecution: true,
    sudoAbsent: true,
    productionSecretsAbsent: true,
    shellCommandsDenied: true,
    installScriptsDeniedByDefault: true,
    maxTimeoutMs: 600_000,
    maxProcesses: 256,
    maxFiles: 100_000,
    maxBytes: 4_294_967_296,
  },
} as const

export function vercelRunnerImageSpecDigest(): string {
  return createHash('sha256').update(canonicalJson(VERCEL_RUNNER_IMAGE_SPEC_V1)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
