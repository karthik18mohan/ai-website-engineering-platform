import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export const platformAliases = {
  '@platform/contracts': fromRoot('./packages/contracts/src/index.ts'),
  '@platform/database': fromRoot('./packages/database/src/index.ts'),
  '@platform/domain': fromRoot('./packages/domain/src/index.ts'),
  '@platform/github-adapter': fromRoot('./packages/github-adapter/src/index.ts'),
  '@platform/observability': fromRoot('./packages/observability/src/index.ts'),
  '@platform/provider-framework': fromRoot('./packages/provider-framework/src/index.ts'),
  '@platform/repository-intelligence': fromRoot('./packages/repository-intelligence/src/index.ts'),
  '@platform/vercel-sandbox-runner': fromRoot('./packages/vercel-sandbox-runner/src/index.ts'),
}

export default defineConfig({
  resolve: { alias: platformAliases },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
    exclude: ['**/.next/**', '**/.turbo/**', '**/dist/**', '**/node_modules/**'],
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
    restoreMocks: true,
  },
})
