# M08 durability benchmark report

**Evaluation timestamp:** 2026-09-05 17:06 +05:30 (Asia/Calcutta)
**Scope:** non-production evaluation only  
**Production selection:** not approved; this report does not select an engine

## Controlled infrastructure

- GitHub App `ai-website-nonprod`: App ID `4626913`, installation ID
  `154456584`, repository ID `1303930605`. Live read-only API evidence confirms
  the repository is private, the installation selects repositories rather than
  all organization repositories, Push is the sole subscribed event, and App
  permissions are Metadata read and Contents read with no Pull requests access.
- Artifact backend: Vercel Private Blob, Preview/non-production only. The adapter
  uses project OIDC/private access and application-owned authorization; clients
  receive `protected-artifact://` references rather than Blob URLs.
- Temporal Cloud: namespace `ai-website-platform-nonprod.k9p3k`, endpoint
  `ai-website-platform-nonprod.k9p3k.tmprl.cloud:7233`, region `asia-south1`,
  retention 7 days, `TEMPORAL_API_KEY` secret reference, USD 50/month evaluation
  target. No production SLA dependency is approved.
- Workflow: stable `4.8.3` and SDK 5 beta `5.0.0-beta.42` are isolated on separate
  benchmark branches. SDK 5 remains beta/non-production and neither branch is
  merged into the application branch.

## Result summary

| Area                           | Temporal Cloud / SDK 1.22.0                                                                                                      | Workflow 4.8.3                                                                                         | Workflow 5.0.0-beta.42                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Outcome                        | **Suitable for further evaluation**; no production selection                                                                     | **Suitable for further evaluation**                                                                    | **Suitable for further evaluation**, beta/non-production                   |
| Environment                    | Temporal Cloud non-production namespace plus official time-skipping test server                                                  | Local Workflow Vitest runtime and guarded Vercel Preview                                               | Local Workflow Vitest runtime and guarded Vercel Preview                   |
| Basic / parallel / payload     | Pass live, including a 1,048,576-byte deterministic payload                                                                      | Pass locally; 1,024-byte basic Preview run completed                                                   | Pass locally; 1,024-byte basic Preview run completed                       |
| Transient retry / recovery     | Pass live; recovery occurred on attempt 2                                                                                        | Pass; recovery occurred on attempt 2                                                                   | Pass; recovery occurred on attempt 2                                       |
| Durable pause / resume         | 60-second durable sleep and external approval signal pass live                                                                   | Sleep and approval hook pass locally                                                                   | Sleep and approval hook pass locally                                       |
| Permanent failure              | Pass live; terminal `FAILED` observed for a non-retryable failure                                                                | Pass; fatal failure observed                                                                           | Pass; fatal failure observed                                               |
| Cancellation                   | Pass live; `RUNNING` became `CANCELLED`                                                                                          | Pass locally                                                                                           | Pass locally                                                               |
| Replay / interruption evidence | Duplicate start returned replay evidence; a running approval workflow completed after the worker was stopped/restarted           | Local runtime tests pass; managed runtime interruption remains unobserved                              | Local runtime tests pass; managed runtime interruption remains unobserved  |
| Preview evidence               | Live Cloud worker/CLI matrix completed on 2026-09-05                                                                             | READY Preview `f5vqrvhb6`; run `wrun_01M08Q5AB98E6WVHTWFQGNP7P7` completed                             | READY Preview `exhmk5ete`; run `wrun_41M08QDP2X0GR7BW7ARMC71DA3` completed |
| Latency                        | Single-sample CLI wall times: retry 7,607 ms, parallel 9,748 ms, 1 MiB payload 11,417 ms, approval 12,011 ms; not a distribution | End-to-end Preview latency distribution not captured; inconclusive                                     | End-to-end Preview latency distribution not captured; inconclusive         |
| Retries                        | Deterministic attempt count recorded                                                                                             | Deterministic attempt count recorded                                                                   | Deterministic attempt count recorded                                       |
| Auditability / observability   | Workflow IDs, run IDs, activity attempts and typed failures are available; Cloud UI evidence blocked                             | Run IDs, statuses, step attempts and results available                                                 | Same, subject to beta behavior changes                                     |
| Developer complexity           | Separate worker, activities, workflow, client/CLI and Cloud operations                                                           | Next.js routes plus workflow/step functions                                                            | Same integration shape as stable in this benchmark                         |
| Operational complexity         | Highest of the three: separately operated worker and Cloud namespace                                                             | Managed Vercel runtime; guarded routes and hooks                                                       | Managed runtime plus beta upgrade/change risk                              |
| Failure semantics              | Explicit retryable/non-retryable application failures and cancellation                                                           | `RetryableError`, `FatalError`, hooks and run cancellation                                             | Same tested surface in beta.42                                             |
| Idempotency                    | Deterministic workflow IDs; duplicate-start policy is explicit in the CLI                                                        | Vercel run IDs and deterministic benchmark run keys; duplicate privileged effects were not live-tested | Same limitation                                                            |
| Cost                           | Live usage occurred, but no defensible billing allocation was available; USD 50/month target remains                             | No defensible per-run cost captured                                                                    | No defensible per-run cost captured                                        |

## Protected artifact evidence

The new `@platform/vercel-blob-artifacts` package enforces the path
`tenants/{tenantId}/projects/{projectId}/runs/{runId}/artifacts/{artifactId}`,
private access, tenant/project authorization, SHA-256 verification, a 16 MiB
limit, an explicit MIME allowlist, deletion state and bounded garbage collection.
Retention is ephemeral 24 hours, benchmark 7 days, standard 30 days, or pinned
without automatic deletion. PostgreSQL migration `0009_m08_protected_artifacts`
keeps identity/integrity metadata immutable after creation and permits only the
first deletion mark. Tests pass for cross-tenant and cross-project denial,
digest mismatch, size/MIME rejection, expired-object collection, pinned-object
preservation and normal put/read/delete.

## Sandbox/VCR evidence

- Private repository: `sandbox-benchmark` in the linked non-production project.
- Image: `sandbox-benchmark@sha256:cfc9b64d4b5ccc2d7a88981157d19a7428825055bc37ff312a8dd40aa0fca67f`.
- Architecture and size: linux/amd64, 110.5 MB.
- Build/push time: 88.692 seconds after the dependency-aware Containerfile fix.
- Live startup: 1,041 ms; deterministic command: 717 ms; teardown: 2,384 ms.
- Security behavior: UID 10001, deny-all network policy, no credentials or env
  files in the image context, expected success exit 0 and forced failure exit 1.

## Temporal Cloud evidence

The 2026-09-05 live matrix used deterministic synthetic inputs and the isolated
`m08-durability-benchmark-v1` task queue. Basic, parallel, transient retry,
1 MiB payload, approval, durable sleep, permanent failure and cancellation
reached their expected terminal states. Retry evidence recorded attempts 1 and 2. Duplicate start of the deterministic workflow ID returned replay evidence.
A running approval workflow remained `RUNNING` while worker PID 6476 was stopped,
then reached `COMPLETED` after a new worker process connected and the approval
signal was delivered. The worker was stopped after the matrix. The timings above
include CLI process startup and network round trips and are single observations,
so they are not comparative latency distributions or defensible cost evidence.

The live launch also found and corrected a development-entrypoint defect: the
TypeScript launcher now uses the source workflow entrypoint when compiled output
is absent, while production builds retain the compiled JavaScript entrypoint.

## Validation evidence

- Main repository: formatting and lint passed; typecheck/build passed for 12/12
  packages; unit 15 files / 82 tests; contract 11 files / 58 tests; integration
  22 files / 85 tests with one live PostgreSQL file/test skipped; migration
  compatibility 6 files / 20 tests; browser/accessibility 4 tests; secret scan
  232 text files; dependency gate passed with four known moderate development
  `esbuild` advisories and no high/critical exit failure.
- The 2026-09-05 checkpoint rerun passed the same 12/12 typecheck/build, 82 unit,
  58 contract, 85 integration plus one skipped, serialized 20 migration, 4
  browser/accessibility and 233-file secret-scan gates. Parallel PGlite setup
  reproduced five known resource-sensitive hook timeouts; the prescribed
  single-worker rerun passed 20/20. Compatible dependency updates removed newly
  reported high-severity Browserslist/fast-uri findings, and Fastify was patched
  from 5.10.0 to 5.12.3. The high-threshold audit passes with only the four known
  moderate development esbuild advisories; no forced repair was used.
- Workflow stable and beta, separately: formatting/lint/typecheck/build passed;
  each Workflow integration suite passed 1 file / 4 tests. Remote Preview builds
  completed and the guarded basic scenario completed on each version.
- GitHub webhook route verifies the exact raw body/signature boundary and the
  adapter handles Push, Installation and Installation repositories events with
  replay-safe delivery handling.

## Limitations and manual actions

1. Run a repeated common workload against both finalists to obtain statistical
   latency and cost evidence, plus managed-runtime interruption where supported.
   Existing Workflow Preview evidence proves deployment and a basic run, not a
   production durability decision.
2. Exercise the live Private Blob adapter through the fully composed worker after
   a disposable benchmark run exists in PostgreSQL. Local authorization,
   integrity, retention and migration evidence is complete; production runner
   dispatch remains fail-closed until its concrete providers are injected. No
   disposable local PostgreSQL URL is currently configured.
3. Workflow stable reports 21 dependency advisories (6 moderate, 15 high) and
   beta reports 18 (4 moderate, 14 high) in their isolated dependency trees.
   These require upstream/workspace-specific review; no forced audit fix was run.

No candidate is declared a production winner. A follow-up ADR may use “suitable
for further evaluation”, “not suitable”, “blocked”, or “inconclusive” only after
the remaining common live workload and organization approval gates are observed.
