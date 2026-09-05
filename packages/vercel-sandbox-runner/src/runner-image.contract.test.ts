import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  runnerBrokerCheckoutRequestV1Schema,
  runnerBrokerExecuteRequestV1Schema,
  runnerBrokerResultV1Schema,
} from './broker-protocol.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1, vercelRunnerImageSpecDigest } from './image-policy.js'

const id = (value: string) => `00000000-0000-4000-8000-${value.padStart(12, '0')}`

describe('Vercel runner image and broker contract', () => {
  it('pins the reviewed image specification and absolute command paths', () => {
    expect(vercelRunnerImageSpecDigest()).toBe(
      '5039c6256a2e531a6e68ffa09ac862ced57551bd638996c101e12e61f4d9053d',
    )
    expect(VERCEL_RUNNER_IMAGE_SPEC_V1.commandPaths).toEqual([
      { executable: 'node', path: '/usr/local/bin/node' },
      { executable: 'npm', path: '/usr/local/bin/npm' },
    ])
    expect(VERCEL_RUNNER_IMAGE_SPEC_V1.controls).toMatchObject({
      maxTimeoutMs: 600_000,
      maxProcesses: 256,
      maxFiles: 100_000,
      maxBytes: 4_294_967_296,
    })
  })

  it('defines a digest-pinned, non-root image without credential build inputs', async () => {
    const containerfile = await readFile(new URL('../image/Containerfile', import.meta.url), 'utf8')
    const base = VERCEL_RUNNER_IMAGE_SPEC_V1.baseImage

    expect(
      containerfile.match(new RegExp(base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')),
    ).toHaveLength(2)
    expect(containerfile).toContain('USER runner:runner')
    expect(containerfile).toContain('test ! -e /usr/bin/sudo')
    expect(containerfile).toContain('/opt/ai-website-platform/bin/runner-exec --self-check')
    expect(containerfile).not.toMatch(/VERCEL_(?:TOKEN|OIDC_TOKEN|TEAM_ID|PROJECT_ID)/u)
    expect(containerfile).not.toMatch(/\b(?:ARG|ENV)\s+.*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu)
  })

  it('accepts only isolated staging paths and exact commits', () => {
    const request = {
      schemaVersion: '1',
      action: 'checkout',
      requestId: id('1'),
      bundlePath: `/home/runner/.platform-control/${id('1')}.bundle`,
      bundleDigest: 'a'.repeat(64),
      baseCommit: 'b'.repeat(40),
    }
    expect(runnerBrokerCheckoutRequestV1Schema.parse(request)).toEqual(request)
    expect(() =>
      runnerBrokerCheckoutRequestV1Schema.parse({
        ...request,
        bundlePath: '/workspace/repository/untrusted.bundle',
      }),
    ).toThrow()
  })

  it('rejects traversal, shell executables, and install-script relaxation', () => {
    const request = {
      schemaVersion: '1',
      action: 'execute',
      requestId: id('2'),
      commandId: id('3'),
      tool: 'npm-test',
      executable: 'npm',
      arguments: ['test'],
      workingDirectory: '.',
      timeoutMs: 60_000,
      limits: { maxProcesses: 64, maxFiles: 10_000, maxBytes: 100_000_000 },
      artifacts: { expectedPaths: ['reports/result.json'], maxCount: 10, maxBytes: 1_000_000 },
      installScripts: 'denied',
    }
    expect(runnerBrokerExecuteRequestV1Schema.parse(request)).toEqual(request)
    expect(() =>
      runnerBrokerExecuteRequestV1Schema.parse({ ...request, workingDirectory: '../host' }),
    ).toThrow()
    expect(() =>
      runnerBrokerExecuteRequestV1Schema.parse({ ...request, executable: '/bin/sh' }),
    ).toThrow()
    expect(() =>
      runnerBrokerExecuteRequestV1Schema.parse({ ...request, installScripts: 'allowlist' }),
    ).toThrow()
  })

  it('requires complete success or failure evidence at the broker boundary', () => {
    const checkoutResult = {
      schemaVersion: '1',
      action: 'checkout',
      requestId: id('4'),
      status: 'succeeded',
      commit: 'b'.repeat(40),
      treeDigest: 'c'.repeat(64),
      detached: true,
      clean: true,
    }
    expect(runnerBrokerResultV1Schema.parse(checkoutResult)).toEqual(checkoutResult)
    expect(() =>
      runnerBrokerResultV1Schema.parse({ ...checkoutResult, treeDigest: undefined }),
    ).toThrow()

    const rejectedExecution = {
      schemaVersion: '1',
      action: 'execute',
      requestId: id('5'),
      status: 'rejected',
      failureCode: 'COMMAND_NOT_ALLOWED',
    }
    expect(runnerBrokerResultV1Schema.parse(rejectedExecution)).toEqual(rejectedExecution)
    expect(() =>
      runnerBrokerResultV1Schema.parse({ ...rejectedExecution, failureCode: undefined }),
    ).toThrow()

    const successfulExecution = {
      schemaVersion: '1',
      action: 'execute',
      requestId: id('6'),
      status: 'succeeded',
      exitCode: 0,
      durationMs: 20,
      stdoutDigest: 'd'.repeat(64),
      stderrDigest: 'e'.repeat(64),
      stdoutBytes: 10,
      stderrBytes: 0,
      artifacts: [{ path: 'reports/result.json', digest: 'f'.repeat(64), sizeBytes: 120 }],
    }
    expect(runnerBrokerResultV1Schema.parse(successfulExecution)).toEqual(successfulExecution)
    expect(() =>
      runnerBrokerResultV1Schema.parse({ ...successfulExecution, artifacts: undefined }),
    ).toThrow()
  })
})
