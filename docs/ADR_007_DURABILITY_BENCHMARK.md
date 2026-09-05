# ADR-007 Durability Benchmark

## Control status

- **Benchmark revision:** 1
- **Evidence date:** 2026-08-16
- **Decision status:** Incomplete - no production engine selected
- **Milestones:** M08 evidence dependency; final selection and full operational acceptance in M19
- **Candidates:** existing PostgreSQL-backed platform ledger, Temporal, Vercel Workflow

This record evaluates the mandatory gates in ADR-007. A product page or local fixture is evidence of capability shape, not production acceptance. A candidate passes a gate only after the common repository-owned exercise is observed in an organization-approved non-production environment.

No package was installed and no provider account, workflow run, production resource, model, secret, domain, or deployment was changed for this revision.

## Evidence labels

| Label                | Meaning                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| **Observed local**   | Repository-owned executable evidence passed locally.                                                      |
| **Observed CI**      | Repository-owned evidence passed GitHub CI, including its disposable PostgreSQL service where applicable. |
| **Documented**       | Current official primary documentation describes the capability; this checkout has not exercised it.      |
| **Partial**          | Some required behavior exists, but the complete ADR-007 gate is not satisfied.                            |
| **Open**             | Evidence or an organization decision is missing.                                                          |
| **Does not satisfy** | The current candidate shape cannot pass the gate without material new capability.                         |

## Comparative gate matrix

| ADR-007 gate                                       | Existing PostgreSQL-backed ledger                                                                                                                                                                                                  | Temporal                                                                                                                                                                                                                                                         | Vercel Workflow                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL compatibility and transaction semantics | **Observed local/CI, partial.** Tenant-scoped enqueue, conditional claims, attempts, and runner state use PostgreSQL transactions. It does not provide a general workflow transaction or atomic commit with every external effect. | **Documented, open.** Self-hosted Temporal supports PostgreSQL persistence, but its service database is separate from platform business transactions. An outbox or equivalent boundary still requires proof. Temporal Cloud manages its own persistence.         | **Open.** Managed workflow persistence is provider-owned. Steps can use the platform database, but atomicity between application PostgreSQL and workflow history requires an explicit outbox/idempotency design and exercise.                                                             |
| Durable timers and human approval waits            | **Does not satisfy.** The ledger has only bounded retry availability timestamps; it has no general durable timer or resumable approval wait.                                                                                       | **Documented.** Durable timers and message passing through Signals/Updates support long waits and human decisions. No platform fixture has been run.                                                                                                             | **Documented.** `sleep` and typed hooks suspend and resume workflows without active compute. No platform fixture has been run.                                                                                                                                                            |
| Cancellation and compensation                      | **Partial.** M08 has deterministic runner cancellation and cleanup, but no platform workflow cancellation propagation or compensation stack. Expired uncertain leases intentionally stop terminally.                               | **Documented, open.** Workflow/activity cancellation and cleanup are supported. Compensation remains application logic and must pass the common ordered-compensation and uncertain-effect exercises.                                                             | **Open.** Run cancellation is documented. Durable in-flight `AbortSignal` propagation was announced for Workflow SDK 5 beta on 2026-06-16 and remains on the beta channel while the observed stable package is 4.6.0; an approved stable capability and compensation exercise are absent. |
| Deterministic replay and safe code evolution       | **Does not satisfy.** Idempotency and completed-result replay exist, but there is no deterministic event-history replay engine or workflow code-version compatibility mechanism.                                                   | **Documented.** Event-history replay, deterministic workflow constraints, replay testing, reset, and worker/workflow versioning are first-class concepts. Repository and deployment evidence are absent.                                                         | **Documented, open.** The provider documents event-log recovery and atomic versioning where running workflows remain on their original version. Repository replay and upgrade fixtures are absent.                                                                                        |
| Duplicate and out-of-order delivery                | **Partial.** Dispatch idempotency and provider callback duplicate/out-of-order handling are tested, but coverage is not engine-wide and uncertain active effects are not replayed.                                                 | **Open.** Temporal provides stable workflow identity and message APIs, but platform-specific message idempotency, authorization freshness, and out-of-order policy still require the common fixture.                                                             | **Open.** Workflow steps recover at durable boundaries, but platform-specific hook/webhook duplicate and ordering behavior still requires schema, authorization, and idempotency fixtures.                                                                                                |
| Safe local development                             | **Observed local, partial.** PGlite exercises persistence without credentials. PGlite setup is resource-sensitive under parallel migration tests and is not production equivalence.                                                | **Documented, open.** The TypeScript SDK provides a local development service and testing package. No dependency is installed in this checkout.                                                                                                                  | **Documented, open.** Workflow provides local tooling and a Vitest integration. Any in-memory local backend must remain explicitly non-production and must not become a server fallback.                                                                                                  |
| Worker isolation and scaling                       | **Partial.** Conditional claims and a non-overlapping pump are tested, but multi-worker scaling, kill/restart, locks, and provider outage behavior are not live-tested.                                                            | **Documented, open.** Workers scale separately from the Temporal Service. The current TypeScript worker requires authentic Node.js features and therefore needs an approved separately hosted worker topology rather than an assumed Vercel Function deployment. | **Documented, open.** Managed queues, functions, persistence, and scaling align directly with Vercel, but organization region, concurrency, isolation, outage, and quota evidence are missing.                                                                                            |
| TypeScript support                                 | **Observed local/CI.** The current implementation is strict TypeScript.                                                                                                                                                            | **Documented.** The official TypeScript SDK supports Node.js 20, 22, and 24; worker features require authentic Node.js.                                                                                                                                          | **Documented.** Workflow is TypeScript-native and integrates with Next.js/Vercel. No approved version is pinned in this repository.                                                                                                                                                       |
| Vercel/control-plane topology compatibility        | **Partial.** The worker is separately deployable, but its production hosting and database topology are unselected.                                                                                                                 | **Open.** A Vercel control-plane client plus a separately hosted Temporal worker/service is feasible in shape, but network identity, regions, egress, service ownership, and deployment lifecycle are unproven.                                                  | **Documented, open.** This is the closest managed topology fit because workflow deployment, persistence, queues, and observability are native to Vercel. Data terms, environment separation, package approval, and live acceptance remain open.                                           |
| Observability                                      | **Partial.** Append-only attempts and safe failure codes exist; end-to-end traces, dashboards, alerts, retention, and redaction exercises do not.                                                                                  | **Documented, open.** Event history, Visibility, Web UI, and metrics are available. Platform correlation, redaction, dashboards, and alert routing are untested.                                                                                                 | **Documented, open.** Run/step event history and dashboard observability are built in. Required retention, drains, correlation, redaction, dashboards, and alerts are untested.                                                                                                           |
| Operational burden                                 | **Does not satisfy as the full engine.** Completing and operating all missing workflow semantics would create a large custom reliability surface. It remains acceptable as the narrow M08 dispatch ledger.                         | **Open.** Temporal Cloud reduces service operation but retains separately operated workers; self-hosting adds database, upgrades, scaling, visibility, backup, and on-call ownership.                                                                            | **Documented, open.** Managed Vercel operation is the lowest infrastructure burden in shape, but incident, export, retention, backup/recovery, and support/SLA fit require organization review.                                                                                           |
| Licensing and cost                                 | **Open.** Cost is the selected PostgreSQL, worker-hosting, engineering, and on-call burden; no production estimate exists.                                                                                                         | **Documented, open.** The server and TypeScript SDK are MIT-licensed; Temporal Cloud is consumption-based with plan/support charges. An organization quote and workload estimate are absent.                                                                     | **Documented, open.** Published Vercel pricing includes workflow steps and storage. An organization plan, regions, retention, support, and representative workload estimate are absent.                                                                                                   |

## Interim finding

1. The existing PostgreSQL-backed ledger is retained as the narrow M08 privileged runner-dispatch component. It is **not** a viable sole production workflow engine in its current shape and must not be expanded ad hoc to imitate a complete durable-execution platform.
2. Temporal and Vercel Workflow remain the live benchmark finalists.
3. Vercel Workflow has the strongest control-plane topology and managed-operations fit, but its stable cancellation/compensation story and organization data/retention/support fit are not yet accepted.
4. Temporal has the strongest documented replay, cancellation, worker, and long-running workflow model, but it introduces a separate service/worker topology and higher integration/operations burden that must be measured.
5. No winner is selected. ADR-007 remains **Deferred** until both finalists run the same conformance workload and the organization approves the provider, data, region, support, retention, and cost terms.

## Common live benchmark workload

Each finalist must execute the same versioned, provider-neutral fixture. Results must be stored as protected evidence bound to the exact repository commit, candidate/version, configuration digest, organization/project/run, and UTC timestamps.

### Functional sequence

1. Start with a stable workflow id and idempotency key; duplicate start must return the same logical run or a typed conflict without duplicate mutation.
2. Persist a deterministic plan and enter a durable timer.
3. Wait on a human approval message. Reject stale policy, plan revision, actor, tenant, and duplicate/out-of-order approval evidence.
4. Execute a credential-free idempotent activity, then inject one typed retryable failure and observe bounded backoff.
5. Execute a second activity, request cancellation while it is in flight, and prove cooperative cancellation plus cleanup.
6. Inject a later failure and run compensation in reverse order. Repeating recovery must not repeat an already recorded compensation.
7. Upgrade workflow code while the run is waiting. Existing runs must remain replay-compatible; new runs must use the new version.
8. Complete successfully or stop in a documented terminal/manual-reconciliation state. No test may manufacture success for an uncertain external effect.

### Failure injection

- Kill the worker before and after every durable boundary.
- Interrupt connectivity to the workflow service and to PostgreSQL independently.
- Deliver duplicate and out-of-order external messages.
- Expire authorization while a timer or approval wait is suspended.
- Race two workers and two cancellation requests.
- Exceed retry, execution, history/event, payload, and concurrency limits with bounded fixtures.
- Remove or corrupt protected evidence and require fail-closed behavior.

### Required measurements

- Recovery result, duplicate privileged-effect count, and terminal state for every injection point.
- Start, signal/hook, timer, cancellation, compensation, and recovery latency distributions.
- Workflow actions/steps, storage growth, network transfer, and projected monthly cost for the pilot load.
- Worker/service CPU and memory where customer-operated.
- Trace/log correlation completeness and evidence that protected payloads, credentials, source, and raw model prompts are absent.
- Operator actions, alert behavior, backup/restore/export capability, retention, and recovery-time evidence.

## Acceptance rule

A candidate is eligible for an accepted follow-up ADR only when:

- every mandatory gate is marked **Observed** in the same organization-approved non-production scope;
- the common workload and all failure injections pass without duplicate privileged effects;
- current authorization is rechecked after every durable wait and immediately before privileged mutation;
- data terms, regions, retention, backup/export, support/SLA, security, licensing, and cost are approved;
- the topology preserves a separately deployable worker boundary and has no production memory/local fallback;
- operational runbooks and rollback/migration guidance are exercised; and
- the follow-up ADR records the selected candidate/version/topology, rejected alternatives, migration path, residual risks, and M19 ownership.

## Primary sources reviewed

All product capability statements above are documentation-derived until the common workload is observed.

### Temporal

- Temporal Workflow Execution overview: https://docs.temporal.io/workflow-execution
- Temporal TypeScript cancellation: https://docs.temporal.io/develop/typescript/workflows/cancellation
- Temporal TypeScript message passing: https://docs.temporal.io/develop/typescript/workflows/message-passing
- Temporal TypeScript versioning: https://docs.temporal.io/develop/typescript/workflows/versioning
- Temporal TypeScript SDK repository and runtime requirements: https://github.com/temporalio/sdk-typescript
- Temporal PostgreSQL setup reference: https://github.com/temporalio/samples-server/blob/main/compose/scripts/setup-postgres.sh
- Temporal deployment/licensing overview: https://temporal.io/
- Temporal Cloud topology: https://temporal.io/cloud

### Vercel Workflow

- Vercel Workflows product and topology overview: https://vercel.com/workflows
- Workflow SDK documentation: https://useworkflow.dev
- Typed hook documentation: https://useworkflow.dev/docs/api-reference/workflow/define-hook
- In-flight cancellation beta announcement: https://vercel.com/changelog/workflow-sdk-now-supports-inflight-cancellation
- Stable and beta package channels: https://www.npmjs.com/package/workflow
- Workflow/managed-resource pricing: https://vercel.com/docs/limits
- Vercel observability: https://vercel.com/docs/observability

## Next action

Obtain organization approval for non-production Temporal Cloud and Vercel Workflow evaluation scopes, pin the approved SDK versions on separate benchmark branches, implement the common versioned fixture behind an isolated provider-neutral benchmark adapter, and record observed results. Application state and privileged authorization must continue through deterministic domain services. Do not replace the M08 PostgreSQL dispatch ledger or select the production engine merely from this documentation matrix.
