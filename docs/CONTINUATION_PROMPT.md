# Continuation Prompt

Continue the AI Website Engineering Platform in
`C:\Users\HP\Desktop\ai-website-engineering-platform` on branch
`codex/m08-isolated-runner`.

Read `AGENTS.md`, the authoritative SRS PDF, `docs/IMPLEMENTATION_PLAN.md`,
`docs/IMPLEMENTATION_STATUS.md`, `docs/DECISIONS.md`,
`docs/SESSION_HANDOFF.md`, and `docs/M08_DURABILITY_BENCHMARK_REPORT.md`, then
inspect Git/worktree/Vercel state. Do not redo completed infrastructure or the
external-readiness audit.

## Exact checkpoint

- M01-M07 are complete. M08 remains in progress; production selection and
  production deployment are not authorized.
- Main implementation commit `adf03ad` contains protected Private Blob artifacts
  and migration `0009`, Temporal SDK 1.22.0 benchmark code/tests, the raw GitHub
  webhook route, live VCR/Sandbox benchmark support, and the benchmark report.
- Isolated Workflow commits are pushed: stable `b2a2e6389adbef2914d3a08f83c8761907820876`
  on `benchmark/workflow-stable` and beta `e2f9fb1993187b66b9154dc98d77d3571445faed`
  on `benchmark/workflow-beta5`. Never merge either benchmark branch into main.
- Stable and beta local Workflow tests passed 4/4 and builds 11/11. Guarded
  Preview basic runs completed on deployment suffixes `f5vqrvhb6` and
  `exhmk5ete`. SDK 5 beta is evaluation-only.
- Private VCR image digest is
  `sha256:cfc9b64d4b5ccc2d7a88981157d19a7428825055bc37ff312a8dd40aa0fca67f`,
  linux/amd64, 110.5 MB. Live Sandbox evidence: 1,041 ms startup, 717 ms command,
  2,384 ms teardown, UID 10001, deny-all network, forced failure exit 1.
- GitHub read-only verification passed for private repository ID `1303930605`,
  App ID `4626913`, installation ID `154456584`, selected-repository scope,
  Push-only event, Contents/Metadata read and no Pull requests permission.
- Main validation passed: typecheck/build 12/12, unit 82, contract 58,
  integration 85 with one live PostgreSQL skip, migrations 20,
  browser/accessibility 4, secret scan 233, high dependency threshold passed.
  Four moderate development `esbuild` advisories remain; do not force-fix them.

## 2026-09-05 checkpoint and next work

The Temporal credential blocker is resolved locally. Live Cloud basic, retry,
parallel, 1 MiB payload, approval, 60-second timer, permanent-failure,
cancellation, duplicate-start and exact-process worker interruption/restart
scenarios reached their expected outcomes. The worker is stopped. A minimal
launcher fix selects the TypeScript workflow source during `tsx` execution and
the compiled JavaScript workflow after build. Do not repeat this matrix merely
to confirm the credential.

1. Obtain an explicitly disposable PostgreSQL benchmark URL and run a benchmark
   record through the live OIDC-backed Private
   Blob adapter to prove private put/read/delete/GC composition without exposing a
   Blob URL or token.
2. Obtain repeated common-workload latency/cost and managed-runtime interruption
   evidence for both finalists. Preserve the USD 50/month Temporal target.
3. Update ADR-007 only after those common gates are comparable. Do not select a
   production engine unless project policy and complete evidence permit it.
4. Validate, commit stable checkpoints, append the external local-only change
   log, push `codex/m08-isolated-runner`, and monitor PR #8 CI. Never merge it.
