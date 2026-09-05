import { DefaultLogger, Runtime } from '@temporalio/worker'

import {
  loadTemporalBenchmarkCloudConfig,
  runTemporalBenchmarkWorker,
} from './temporal-benchmark-runtime.js'

Runtime.install({
  logger: new DefaultLogger('INFO', ({ level, message, meta, timestampNanos }) => {
    const safeMetadata = { ...(meta ?? {}) }
    delete safeMetadata['taskToken']
    process.stderr.write(
      `${JSON.stringify({ level, message, metadata: safeMetadata, timestampNanos: timestampNanos.toString() })}\n`,
    )
  }),
})

await runTemporalBenchmarkWorker(loadTemporalBenchmarkCloudConfig())
