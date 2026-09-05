# Architecture Decision Log

This file records decisions for the AI Website Engineering Platform. The authoritative specification is `docs/product/AI_Website_Engineering_Platform_SRS_v1.1_AI_Cost_Controller.pdf`. Decisions that merely select an allowed implementation do not supersede the SRS. Any future decision that changes a mandatory requirement must state that explicitly, identify the affected requirements, and obtain the required review.

Status values: **Accepted**, **Proposed**, **Deferred**, **Superseded**, **Rejected**.

## ADR-001 - npm workspaces for the TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-07-21
- **Milestone:** M01
- **Context:** The SRS recommends a TypeScript-first monorepo with shared contracts and provider adapters. The audited environment has Node.js/npm available; the foundation should avoid unnecessary orchestration dependencies.
- **Decision:** Use npm workspaces with pinned package-manager metadata and root scripts that coordinate apps, packages, tests, and migrations. Keep package boundaries explicit and forbid framework/provider dependencies in domain packages.
- **Alternatives considered:** pnpm workspaces, Yarn workspaces, Turborepo layered over a package manager.
- **Consequences:** Lowest bootstrap complexity and no additional package-manager prerequisite. Revisit build caching only when repository size and CI measurements justify it.

## ADR-002 - modular control-plane monolith with a separate worker boundary

- **Status:** Accepted
- **Date:** 2026-07-21
- **Milestone:** M01
- **Context:** SRS sections 5 and 16 recommend a modular monolith for control-plane APIs while untrusted execution runs separately. The product still requires durable state and independently scalable workers.
- **Decision:** Keep authentication, RBAC, project metadata, policy, run commands, provider coordination, and cost-control application services in one modular control-plane deployment initially. Define the worker as a separately deployable process/package with versioned commands/events and no implicit in-process authority. Isolated build workspaces remain a further boundary behind the runner interface.
- **Alternatives considered:** Independent service per domain from inception; a single process containing both API and untrusted execution.
- **Consequences:** Fewer initial operational failure modes while retaining extraction seams. Untrusted code never executes inside the web or API process.

## ADR-003 - PostgreSQL-compatible relational persistence through Drizzle

- **Status:** Accepted for the production profile; local execution prerequisite unresolved
- **Date:** 2026-07-21
- **Milestone:** M01
- **Context:** The SRS makes the relational database authoritative for orchestration metadata, approvals, memories, audit references, and costs, requires migrations and tenant scoping, and names PostgreSQL compatibility in the implementation objective. The environment audit did not find Docker, `psql`, or a local PostgreSQL service/toolchain.
- **Decision:** Target PostgreSQL and use Drizzle ORM/Drizzle Kit for typed schema definitions and forward migrations. Domain services depend on repository ports, not Drizzle. Every tenant-owned table carries organization/project scope as applicable; audit records are append-only by service and database controls. No fallback database is represented as production-equivalent.
- **Alternatives considered:** Prisma, Kysely plus a separate migration tool, raw SQL, SQLite as the primary local/production profile.
- **Consequences:** Database-backed integration and migration execution require a PostgreSQL endpoint or later installation of approved local tooling. Schema generation/static validation and repository-level tests can proceed first. Each migration must document purpose and recovery; non-local destructive reset is forbidden.

## ADR-004 - Fastify for the TypeScript control-plane API

- **Status:** Accepted
- **Date:** 2026-07-21
- **Milestone:** M01
- **Context:** The API requires clear lifecycle handling, structured logging, health endpoints, versioned validation, and a framework-independent domain. It must remain separately operable from the Next.js UI.
- **Decision:** Use Fastify for the API transport and composition root. Translate versioned contract schemas at the boundary and call application/domain services through ports. No domain rule may rely on Fastify request objects or plugins.
- **Alternatives considered:** Next.js route handlers as the entire control plane, Express, Hono, NestJS.
- **Consequences:** The control plane is independently testable/deployable and remains a modular monolith. It adds a dedicated app but avoids coupling long-running workflow commands to the web UI runtime.

## ADR-005 - Next.js App Router for the management application

- **Status:** Accepted
- **Date:** 2026-07-21
- **Milestone:** M01
- **Context:** The first production profile requires a Next.js management application and the SRS calls for an accessible project workspace, dashboards, history, deployments, settings, and audit views.
- **Decision:** Use Next.js App Router with strict TypeScript. UI code consumes typed API clients/application view models and never accesses the database directly. Accessibility targets WCAG 2.2 AA practices and keyboard-first workflows.
- **Alternatives considered:** Pages Router, a standalone Vite SPA, combining all control-plane behavior into Server Actions.
- **Consequences:** Server/client boundaries must be deliberate, and privileged changes continue through the control-plane API/policy boundary rather than UI-only checks.

## ADR-006 - provider-neutral ports and versioned adapters

- **Status:** Accepted
- **Date:** 2026-07-21
- **Milestones:** M03, M04, M12, M17
- **Context:** The SRS forbids direct model-provider calls outside the AI Cost Controller and requires replaceable Git, deployment, model, secrets, artifacts, and runner integrations.
- **Decision:** Define versioned contracts and domain-facing ports before vendor implementations. GitHub App, Vercel, and each LLM provider live in adapters. All model calls enter a single AI Cost Controller gateway that produces a routing decision, pricing version, estimate/budget decision, context manifest, usage record, and actual-cost reconciliation. Mock adapters must pass the same contract suite as real adapters.
- **Alternatives considered:** Vendor SDK types crossing application boundaries; direct provider calls from agents or UI; a generic untyped provider wrapper.
- **Consequences:** Some up-front contract work is required, but provider credentials and model IDs remain configuration rather than business logic. No adapter may advance workflow state on its own.

## ADR-007 - durable workflow engine selection follows an explicit benchmark

- **Status:** Deferred; port-first implementation is accepted
- **Date:** 2026-07-21
- **Milestones:** M01 design seam, decision required before M08/M19 production completion
- **Context:** The SRS requires durable state, retries, timeouts, compensation, approvals, cancellation, replay-safe events, and recovery after worker/process failure. Appendix B leaves engine and hosting topology open. Choosing an engine before confirming operational and deployment constraints would create avoidable lock-in.
- **Decision:** Define a provider-neutral orchestration port, deterministic run state machine, versioned commands/events, idempotency keys, and persistence semantics first. Do not call an in-memory queue durable. Benchmark viable engines/topologies before selecting the production implementation.
- **Benchmark gates:** PostgreSQL compatibility and transaction semantics; durable timers and human approval waits; cancellation and compensation; deterministic/replay behavior; duplicate/out-of-order delivery handling; local development without unsafe fallbacks; worker isolation/scaling; TypeScript support; Vercel/control-plane topology compatibility; observability; operational burden; licensing and cost.
- **Alternatives to benchmark:** Temporal, a PostgreSQL-backed workflow/queue implementation, and hosted TypeScript workflow products that satisfy the mandatory gates. Inclusion is evaluation, not approval.
- **Consequences:** M01 can implement contracts and state-machine tests. M08/M19 cannot be called production-complete until benchmark evidence, an accepted follow-up ADR, failure-injection tests, and operational runbooks exist.
- **M08 evidence checkpoint (2026-08-16):** The PostgreSQL-backed candidate now has local failure-injection evidence that queued work is claimable after reconstructing the worker adapter, a persisted retry wait remains unavailable until its durable timer is due after reconstruction, and an expired uncertain lease becomes terminal without handler replay. `docs/runbooks/m08-runner-dispatch-recovery.md` records the operator reconciliation path and forbids manual ledger mutation or automatic replay of uncertain privileged effects. This evidence evaluates only part of the PostgreSQL candidate; durable human waits, cancellation/compensation, complete observability/operations evidence, live crash/recovery, and the comparative engine benchmark remain open. ADR-007 therefore remains deferred.
- **Comparative benchmark checkpoint (2026-08-16):** `docs/ADR_007_DURABILITY_BENCHMARK.md` maps every gate across the existing PostgreSQL ledger, Temporal, and Vercel Workflow using repository evidence and current official primary documentation. The existing ledger is retained as the narrow M08 privileged-dispatch component but does not satisfy the platform-wide durable-engine gates because it lacks general human waits, compensation, and deterministic event-history replay. Temporal and Vercel Workflow remain live finalists. No winner or dependency is selected: both must pass the same provider-neutral failure-injection workload in an organization-approved non-production scope, and provider/data/region/retention/support/cost terms must be approved before a follow-up ADR can be accepted.

## ADR-008 - SRS version-header anomaly handling

- **Status:** Accepted as an interpretation record; product-owner confirmation pending
- **Date:** 2026-07-21
- **Context:** The filename, cover document-control table, and revision history identify SRS version 1.1 and describe the AI Cost Controller integration, but repeated page headers display v1.0.
- **Decision:** Treat the document-control/revision-history version 1.1 and its full contents as authoritative. Do not modify the source PDF. Record the anomaly as an external clarification item and do not omit AI Cost Controller requirements.
- **Consequences:** Implementation proceeds against v1.1 without waiting, while formal confirmation remains tracked.

## ADR-009 - Next.js production build uses webpack for M01

- **Status:** Accepted
- **Date:** 2026-07-22
- **Milestone:** M01
- **Context:** Next.js 16.2.11 defaults production builds to Turbopack. In this npm workspace, the web app can follow TypeScript source aliases into `packages/contracts/src`; Turbopack then fails to resolve ESM `.js` specifiers that TypeScript and Vitest resolve to `.ts` source files. The same app builds successfully with Next's webpack production builder.
- **Decision:** Use `next build --webpack` for the M01 production build while keeping `next dev --turbopack` for local development. Internal packages build with `tsc` and expose ESM output through package exports.
- **Alternatives considered:** Commit generated `.js` stubs into package source directories; remove ESM `.js` specifiers from TypeScript source; adopt a canary Next/Turbopack behavior; bundle all internal packages with tsup. These either weakened source hygiene, risked Node ESM runtime behavior, or failed in the Windows sandbox.
- **Consequences:** Production build is stable and reproducible on the current toolchain. Re-evaluate Turbopack once it handles this workspace ESM resolution path or the package build strategy changes.

## ADR-010 - M01 dependency-audit remediation and browser validation gate

- **Status:** Accepted
- **Date:** 2026-08-10
- **Milestone:** M01
- **Context:** The M01 dependency audit failed at `--audit-level=high` because Next.js 16.2.11 pulled vulnerable optional `sharp`/`postcss` metadata. The mandatory browser/accessibility verification gate also lacked a reproducible repository-owned harness, and the environment-provided `agent-browser` CLI was unavailable.
- **Decision:** Upgrade the web workspace and Next lint integration to Next.js 16.3.0, which resolves the high-severity `sharp`/`postcss` audit findings while preserving React 19.2.8. Add Playwright plus axe as a root dev-only browser/accessibility gate and run it through a small cross-platform script that starts the production-built web app, waits for `/api/health`, executes the tests, and terminates the exact spawned process tree.
- **Alternatives considered:** `npm audit fix --force`, which proposed breaking downgrades; a direct `sharp` override, which did not remove the nested vulnerable Next dependency; relying on the unavailable environment `agent-browser` CLI; recording a permanent audit exception.
- **Consequences:** `npm run security:deps` now exits 0 with only moderate `esbuild` advisories through `drizzle-kit`; browser/accessibility validation is reproducible locally and in CI. CI installs Chromium with `npx playwright install --with-deps chromium`.

## ADR-011 - M02 deny-by-default RBAC and retention-aware project lifecycle

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M02
- **Context:** The SRS requires explicit human roles, separately scoped service identities, distinct privileged permissions, tenant isolation, authorization at issue and delayed execution, append-only audit, and project deletion subject to retention. Delegated approvals and environment-specific production authority remain open production-policy decisions.
- **Decision:** Keep authorization and lifecycle rules in the framework-independent domain. Human role defaults are conservative: Owner receives all M02 permissions; Developer and Designer can read/request changes; Reviewer can read/approve; Viewer is read-only. Merge, promotion, secret, policy, member, and lifecycle permissions default to Owner until a later versioned policy explicitly delegates them. Service identities never inherit human roles and receive enumerated organization/project-scoped grants. Every project command appends an allowed or denied authorization event; successful mutations append a second event atomically with the project write. Delete becomes `deletion_pending` until the referenced policy retention window expires, or `deleted` immediately only when that window is zero. Delayed lifecycle commands re-read current membership/grants and may use `expectedUpdatedAt` to reject stale project state.
- **Alternatives considered:** Broad role defaults based on informal persona descriptions; treating service identities as users; immediate hard deletion; UI-only permission enforcement; coupling policy logic to Fastify or Drizzle.
- **Consequences:** Least privilege is the default and delegation must be explicit. M02 APIs remain provider-neutral and storage-independent at the domain boundary. Physical deletion processing after retention is deferred to later durable workflow/retention work and cannot erase audit history.

## ADR-012 - M03 provider-neutral boundaries and mandatory model gateway

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M03
- **Context:** The SRS requires replaceable Git, deployment, secrets, artifact, runner, orchestration, and model integrations; secrets referenced rather than persisted; authenticated, deduplicated, replay-safe callbacks; deterministic test doubles; and an AI Cost Controller decision before every model invocation.
- **Decision:** Define versioned provider schemas in `@platform/contracts` and framework-independent provider ports in `@platform/domain`. Export deterministic local mocks and callback safety primitives from `@platform/provider-framework`. Application code may invoke models only through `AiCostControllerPort`; the raw model adapter interface remains internal and unexported, with ESLint restrictions preventing application/domain imports of raw model SDKs or that internal module. The initial controller mock denies every request until the minimum M17 estimate, budget, routing, usage, and reconciliation path is implemented.
- **Alternatives considered:** Exposing raw model providers to application code; allowing vendor SDK types across domain boundaries; storing plaintext provider tokens; accepting unauthenticated callbacks; choosing production vendors before contract conformance exists.
- **Consequences:** M03 conformance remains deterministic and credential-free, provider outages are represented as typed results, and no live model invocation is possible through the public framework. Production adapters and the complete M17 controller remain later work; the minimum controller path must precede M06's first model-assisted behavior.

## ADR-013 - M04 installation-first GitHub onboarding remains read-only

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M04
- **Context:** GitHub onboarding must prove current project authority, selected-installation repository access, least privilege, exact repository identity/default branch/commit, credential non-disclosure, and authenticated replay-safe webhooks without prematurely authorizing the later Git write path.
- **Decision:** Introduce `repository:connect` as a distinct Owner-by-default permission rather than reusing `git:merge`. Initiation requires an active project, a current authorization decision, and an existing GitHub App credential reference. Persist only a ten-minute SHA-256 state digest bound to actor/tenant/project; consume it once and reauthorize completion. Mark readiness `ready` only when the selected installation reports matching IDs plus Metadata and Contents read access at an exact 40-character commit. Persist the opaque credential reference internally but omit it from API readiness responses. Keep `mutationEnabled=false` in contracts and database constraints. Authenticate GitHub raw webhook bytes with HMAC before resolving installation/repository identity to trusted tenant/project context; deduplicate deliveries before an application-owned refresh callback.
- **Alternatives considered:** Personal access tokens; user OAuth as repository authority; all-repository installations by default; trusting callback tenant/project parameters; storing raw setup state; returning secret references to clients; enabling pull-request or content mutation during onboarding.
- **Consequences:** Deterministic fixture onboarding can satisfy M04 contract evidence without credentials, while live-provider evidence requires the explicit owner setup in `docs/runbooks/github-app-onboarding.md`. M11 must perform a separate least-privilege review before any Git write scope is enabled. Lost access remains visible as `access_lost`; the platform never falls back to broader credentials.

## ADR-014 - M05 deterministic repository evidence precedes semantic retrieval

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M05
- **Context:** Repository context must be narrow, reproducible, tenant-isolated, commit-addressed, provenance-linked, token-bounded, and secret-safe. Semantic similarity can improve recall but cannot replace current source truth or deterministic dependency/symbol evidence.
- **Decision:** Key every index by organization, project, repository, immutable commit, and configuration digest. Normalize/sort provider file paths before hashing. Exclude generated, vendor, binary, oversized, policy, filename-secret, and content-secret candidates before metadata extraction. Derive language/category, framework/package manager/scripts, routes, exports/imports, symbols/components/stories/tests, configuration/instructions, ownership, and recent commit summaries deterministically. Use lexical path/content, symbol, dependency, instruction, and test evidence by default; expose semantic search only as an optional provider-neutral score port. Retrieval emits bounded excerpts through the artifact port and a manifest with source path, commit, content/configuration digests, score, and estimated tokens. Invalidation may remove only stale entries in the addressed tenant/project.
- **Alternatives considered:** Sending the full repository; semantic/vector retrieval as the first or only selector; cache keys without tenant/configuration scope; indexing ignored binaries/vendor/generated output; retaining detected secret content for later redaction; model-generated repository maps.
- **Consequences:** Golden fixture maps and retrieval manifests are deterministic and credential-free. Secret candidates never enter searchable documents or context artifacts. The included memory index store is a conformance/test adapter; a production durable index/artifact implementation remains provider configuration and must preserve the same scoped contracts. Retrieved repository instructions remain untrusted data and cannot supersede platform policy.

## ADR-015 - M06 immutable intake and reviewable requirement boundary

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M06
- **Context:** FR-004 and FR-005 require immutable prompt intake and typed, reviewable requirements while repository, web, image, and attachment text remain untrusted. The full AI Cost Controller is not yet available, so no live model-backed normalization may be implied or invoked.
- **Decision:** Persist the actor-attributed original prompt, mode, target, constraints, and explicitly trust-labeled attachment references as the immutable ChangeRequest. Re-scan attachment metadata through an application-supplied scanner before normalization. Accept Requirement role results only through a high-level domain port, schema-validate them, permit exactly one retry, and require complete estimate/budget/routing/pricing/usage evidence for any result labeled model-backed. Deterministic fixtures are labeled separately and cannot claim provider evidence. Human corrections create a new RequirementSpec revision and never overwrite the original prompt.
- **Alternatives considered:** Letting clients declare attachments clean; editing the original prompt during clarification; accepting prose-only requirements; allowing unmetered model calls before M17; silently retrying malformed output without a bound.
- **Consequences:** The initial M06 contract/domain slice is testable without credentials or model calls, all eight SRS modes share one strict schema, and later API/database/UI adapters must preserve revision and trust boundaries. Model-backed M06 acceptance remains blocked until the minimum M17 controller path exists.

## ADR-016 - M07 deterministic risk and immutable approval evidence

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M07
- **Context:** FR-006 and FR-007 require a versioned execution plan, deterministic risk classification, current project/environment policy, and an authorized approval pause before high-risk mutation. The SRS also prohibits model prose from controlling privileged transitions and forbids automatic relaxation after a security or policy failure.
- **Decision:** Treat planner output as typed advisory data, then derive risk class, required architecture/UI/security analyses, requested approval gates, and the initial execution gate through deterministic domain policy. Each required specialized analysis must be schema-valid and completed, contain role-specific evidence, and match the requirement, immutable base commit, and policy snapshot digest before the plan can leave `PLANNING`; malformed output receives one bounded retry, while incomplete AI Cost Controller evidence stops immediately. Persist immutable, revisioned plans with the exact policy snapshot and base commit. Persist runs behind the existing orchestrator-only state machine and enforce the same transition graph in PostgreSQL. Approval requests are tenant-scoped and idempotent; a pending request may receive one attributed approved/rejected decision, after which it is final. Stale plan revision, analysis binding, or policy-version evidence never opens the execution gate, separation of duties is explicit in the snapshot, and blocked policy results remain rejected even if supplied approval-shaped input.
- **Alternatives considered:** Letting a model assign authoritative risk; mutable in-place plans; UI-only approval checks; accepting stale approvals after plan/policy changes; permitting high-risk workspace preparation before approval; retrying or relaxing blocked policy results.
- **Consequences:** M07 can prove with deterministic fixtures that high-risk work reaches `AWAITING_APPROVAL` before any workspace callback. The initial policy matrix is conservative and provider-neutral; environment-specific production delegation remains an explicit production decision. API/store orchestration must append audit events for requested, allowed, denied, approved, rejected, and blocked outcomes without weakening the database constraints.

## ADR-017 - M08 runner contract and isolation claim boundary

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M08
- **Context:** FR-008 and NFR-005 require every mutating run to use an ephemeral, resource-limited workspace based on an immutable commit, while the threat model requires sandboxing, egress policy, command/tool allowlists, approved registries, install-script policy, tenant isolation, digest artifacts, cancellation, and cleanup. The M03 runner seam accepted a raw command string and its mock returned an exit code without checkout, profile, or isolation evidence; retaining that shape would create a bypass and overstate conformance.
- **Decision:** Supersede the raw runner command/result with one versioned lifecycle boundary: provision an immutable tenant/run/plan/base-commit workspace under an exact isolation profile; execute shell-free executable-plus-argv commands bound to the workspace and canonical profile digest; cancel idempotently; and destroy idempotently. Profiles explicitly snapshot image digest, CPU/memory/time/process/file limits, host-filesystem denial and writable roots, network deny/allowlist policy, command allowlist, approved registries and install-script policy, production-secret denial, and artifact limits. Deterministic domain policy rejects stale scope/commit/profile bindings, unlisted commands, excessive time, filesystem escape, and artifact-policy mismatch. The included `ConformanceRunnerFixture` never checks out code or starts a process, labels all evidence `conformance_fixture`/`simulated_conformance`, and refuses a `production_isolation` profile.
- **Alternatives considered:** Retaining a raw shell-command adapter; treating a host-process mock as isolation; choosing Docker, microVM, Kubernetes, or a hosted sandbox before owner/runtime approval; trusting caller-provided profile digests; replaying conflicting command IDs; allowing implicit network, host filesystem, install scripts, or production secrets.
- **Consequences:** M08 has a strict provider-neutral seam and malicious-input conformance evidence without executing untrusted code. A production isolation runtime, supported runner image/profile matrix, real immutable checkout, resource enforcement, artifact capture, and host-boundary security suite remain required before M08 completion. No production-isolation or runner-security acceptance claim may cite the conformance fixture.

## ADR-018 - M08 delayed runner authorization and durable evidence ownership

- **Status:** Accepted
- **Date:** 2026-08-11
- **Milestone:** M08
- **Context:** A queued plan may become stale before a worker provisions its workspace. The SRS requires authorization at command issue and delayed privileged execution, current approval/policy enforcement, durable run state, idempotent mutating commands, append-only audit, tenant isolation, and digest-addressed large evidence. Persisting argv or raw process output would also create an avoidable secret-retention path.
- **Decision:** Add a service-only `run:execute` permission that no human role receives by default. The framework-independent runner orchestration service re-reads the scoped service grant, exact queued run, current plan approvals, current policy version, repository readiness, repository identity, immutable base commit, and isolation-profile binding before calling `provision`. It schema-validates every runner response and alone owns deterministic run transitions for execution, cancellation, and cleanup. The separately deployable worker owns the PostgreSQL adapter. Workspace, command, artifact-reference, cancellation, and cleanup records use tenant-scoped foreign keys and replay digests; command persistence deliberately omits argv, environment, raw stdout/stderr, and secret values. Runner evidence is append-only, while workspace state may only move forward from ready to cancelled/destroyed.
- **Alternatives considered:** Reusing `change:request` for worker execution; granting human owners direct runner authority; trusting the approval state captured when work was queued; invoking the runner port directly from API code; storing raw process output in PostgreSQL; keeping lifecycle evidence only in memory; placing worker persistence behind control-plane application modules.
- **Consequences:** Delayed execution now fails closed on revoked service access, stale approval/policy/repository evidence, cross-tenant scope, and binding mismatch. Replays are durable without retaining command contents or raw output. The worker remains independently deployable and imports only shared contracts/domain/database packages. A production isolation adapter, approved image/profile matrix, real checkout and artifact providers, durable dispatch engine, and forbidden-host-resource acceptance suite remain required before M08 completion.

## ADR-019 - M08 Vercel Sandbox production-isolation adapter

- **Status:** Accepted for implementation; live provider acceptance pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** The production runner must provide a stronger boundary than a host process or ordinary container, enforce resource and deny-by-default network policy, use an immutable approved image, support cancellation and cleanup, and remain behind the provider-neutral runner lifecycle. The repository already targets Vercel for later preview deployment, but no Vercel project, OIDC identity, hardened runner image, or production credentials are configured in this checkout.
- **Decision:** Implement the first production adapter with the GA `@vercel/sandbox` SDK pinned to 3.0.0 and keep it in the separate `@platform/vercel-sandbox-runner` package. An approved versioned manifest must bind the runner profile to an exact custom-image SHA-256 digest and attest host-filesystem denial, absence of production secrets, absence of a `sudo` executable, the fixed command broker, process/file/byte controls, and install-script policy. Planner output is non-persistent, exposes no inbound ports or environment variables, permits only supported whole-vCPU values with the provider's fixed 2048 MiB-per-vCPU coupling, and maps network denial or an HTTPS-only domain allowlist. After creation, the adapter must compare provider-reported image, resources, timeout, persistence, status, expiry, and network policy against the authorized plan; it stops and rejects any mismatch. The reviewed image definition pins its base image index by digest and fixes profile ceilings in the image specification. The adapter may start only the fixed broker through the provider's explicit privileged-command mechanism; the broker validates fixed-path staging input, deletes the request before use, enforces limits no greater than the image ceilings, and permanently drops to the runner identity before repository or command execution.
- **Alternatives considered:** Self-managed Firecracker microVMs, which preserve control but add substantial image, kernel, network, scheduling, patching, and incident-response burden; Kubernetes/gVisor or ordinary containers, which require a separate hosting and hardening program and do not by themselves establish the required host-resource boundary; deferring all implementation until credentials and a live provider project exist, which would leave the validated provider-neutral seam without a production adapter shape.
- **Consequences:** The code now has a strict manifest/planning/creation-verification boundary, a reviewable immutable-checkout/command-broker image definition, and a fail-closed SDK transport without making a live provider call or claiming M08 completion. The transport accepts only a fresh five-minute digest-bound bundle and policy-revalidated workspace/profile/command, exposes neither repository credentials nor tool argv on the provider command line, and stops the sandbox on staging, invocation, or evidence failure. Vercel custom images and VCR are public beta as of this decision date, so organization approval and live compatibility evidence are mandatory. Live acceptance still requires an approved non-production project and region/data terms, OIDC or scoped credentials, an actually built and published hardened image digest, an approved caller-side Git bundle source, provider verification of privileged broker invocation and descendant cleanup, filesystem/disk enforcement, digest artifact capture, complete RunnerProvider/durable worker wiring, cancellation/cleanup exercises, and the forbidden-host-resource security suite. The SDK's domain network policy does not model per-destination ports, so the initial profile matrix accepts allowlisted destinations only when their contract ports are HTTPS 443; image and command-broker controls must enforce the same restriction.
- **Primary references reviewed:** Vercel Sandbox documentation (https://vercel.com/docs/sandbox), product isolation description (https://vercel.com/sandbox), egress firewall announcement (https://vercel.com/changelog/advanced-egress-firewall-filtering-for-vercel-sandbox), custom-image public-beta announcement (https://vercel.com/changelog/vercel-sandbox-now-support-custom-images), and VCR guide (https://vercel.com/kb/guide/how-to-use-vercel-container-registry), reviewed 2026-08-16.

## ADR-020 - M08 credential-free checkout source and runner lifecycle composition

- **Status:** Accepted for local composition; live provider and durable acceptance pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** The broker transport accepts a fresh Git bundle but intentionally has no repository credential authority, while `RunnerProviderPort` requires provision, execute, cancel, and destroy behavior. Composing GitHub acquisition directly into the Vercel adapter would leak vendor concerns across boundaries, and storing only live SDK handles in the existing worker database would falsely imply process-failure recovery. Artifact capture is also not implemented yet, so expected artifacts cannot be silently omitted.
- **Decision:** Add a versioned provider-neutral checkout-bundle contract and a domain bundle-source port. The GitHub adapter delegates acquisition to an injected client that must acquire and dispose approved short-lived installation access internally; it validates exact repository/commit binding, a maximum five-minute access lifetime, non-empty bounded content, and computes the bundle digest itself. Only the credential-free bundle crosses into the runner adapter. Compose the Vercel broker into a complete `RunnerProviderPort` lifecycle with approved-image planning, verified sandbox creation, immutable checkout evidence, tenant/run scoping, sequential and concurrent command replay protection, deterministic policy re-evaluation, typed result mapping, abort propagation, and fail-closed stop behavior. Keep live session ownership behind an injected store and label the supplied memory store process-local and non-durable. Reject commands requesting artifacts until a digest artifact collector is composed.
- **Alternatives considered:** Passing a GitHub token or authenticated URL into the sandbox; making the Vercel package depend directly on the GitHub adapter; treating an in-memory SDK handle as durable worker state; returning successful execution while dropping requested artifacts; allowing duplicate in-flight commands to execute more than once.
- **Consequences:** Local contract/integration evidence now exercises the complete provider method surface without credentials or live provider calls, and Git acquisition remains replaceable. A concrete organization-approved live GitHub installation bundle client, recoverable sandbox lookup/session storage, digest artifact collection, durable worker dispatch, published image digest, and live isolation/cancellation/cleanup suite remain mandatory before M08 completion. Current Vercel documentation recommends the Sandbox SDK and OIDC authentication and documents reconnecting through `Sandbox.get()`; durable composition must use a scoped provider identity and persist only recoverable provider/session identifiers, never credentials or raw command output.
- **Primary references reviewed:** Vercel Sandbox documentation (https://vercel.com/docs/sandbox) and reconnect guide (https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox), reviewed 2026-08-16.

## ADR-021 - M08 two-sided digest artifact capture

- **Status:** Accepted for local composition; live provider and artifact-store acceptance pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** The SRS requires digest-addressed artifacts, configurable retention, artifact-integrity controls, and durable protected evidence. Trusting only a command-produced path or only provider-returned bytes would leave a race or tampering gap, while persisting raw artifact bytes in command evidence would weaken the established retention and secret-minimization boundary.
- **Decision:** Carry only authorized, normalized file paths and profile count/byte limits into the fixed broker. After a successful command, the broker resolves each expected path beneath the immutable-checkout workspace, rejects missing/non-regular/symlinked/escaped/changed or excessive files, and returns ordered path/SHA-256/size attestations without raw content. The provider independently reads each attested path through the Sandbox SDK, recomputes byte count and SHA-256, and rejects any difference. Matching bytes are written through the tenant-scoped `ArtifactStorePort` with the command-authorized media type and retention class; the returned reference must match the computed digest and requested metadata before versioned runner evidence is emitted. Any broker, retrieval, digest, limit, or storage-reference mismatch fails closed and stops the sandbox. Command/database evidence retains only protected artifact references, digests, sizes, media types, and retention classes.
- **Alternatives considered:** Trusting caller-provided artifact paths without broker inspection; trusting broker digests without independently retrieving bytes; returning SDK buffers directly in runner results; persisting raw artifact content in PostgreSQL; silently omitting missing artifacts; allowing directory-root artifacts or paths that resolve through symlinks.
- **Consequences:** Local tests now prove successful retention-aware capture and teardown on cross-boundary digest mismatch without a live provider call. The two reads deliberately detect mutation between broker attestation and provider retrieval; they do not claim atomic filesystem snapshot semantics. Partial protected-store writes may become unreferenced if a later artifact fails and must be handled by the selected store's retention/garbage-collection policy. Live M08 acceptance still requires an approved artifact store, published runner image, live Sandbox retrieval, artifact-integrity exercises, recoverable session lookup, and durable dispatch.
- **Primary references reviewed:** Vercel Sandbox documentation (https://vercel.com/docs/sandbox) and Vercel's `readFileToBuffer()` file-retrieval announcement (https://vercel.com/changelog/simplified-file-retrieval-from-vercel-sandbox-environments), reviewed 2026-08-16.

## ADR-022 - M08 deterministic sandbox session recovery

- **Status:** Accepted for local composition; durable store and live recovery acceptance pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** The SRS requires durable run state across worker/process failure, idempotent command handling, explicit retry behavior, tenant isolation, and reauthorization of delayed privileged work. An SDK handle is process-local and cannot be the durable identity of an active sandbox. Provider lookup after a restart is asynchronous and can also race a concurrent replay unless command state is checked again after recovery.
- **Decision:** Persist credential-free recovery metadata as the complete authorized Vercel workspace plan plus the existing tenant/run/workspace/profile evidence, while treating the live SDK handle as optional and transient. Reconnect only by the deterministic name derived from organization, project, run, and provision idempotency through `Sandbox.get({ name, resume: true })`. Before lookup, re-parse the stored workspace and profile and prove their canonical profile digest, deterministic name, image, resources, and tenant/run tags still match. After lookup, re-run the complete provider session verifier and require the exact originally recorded expiry to remain unexpired. Provider lookup failure is retryable and preserves workspace state; any stored/provider evidence mismatch is non-retryable, stops the recovered sandbox, and marks the workspace destroyed. Execute rechecks completed and active command state after asynchronous recovery so a concurrent replay cannot start a second broker command.
- **Alternatives considered:** Persisting or serializing SDK handles; reconnecting by an unbound provider identifier; accepting mutable provider state after lookup; creating a replacement sandbox when lookup fails; treating lookup failure as terminal; adding a database column solely for the already deterministic provider name; claiming the existing in-memory store as durable.
- **Consequences:** Local process-restart fixtures now prove successful reattachment, full evidence revalidation, tampered stored-name rejection before provider access, changed-provider-image teardown, and single broker execution under a recovery race. This recovers only a still-active named sandbox; it does not resurrect an expired sandbox, make the supplied memory store durable, or provide durable worker dispatch. A worker-owned persistent session-store adapter and dispatch/retry integration remain mandatory before NFR-002 or M08 completion can be claimed.
- **Primary references reviewed:** Vercel Sandbox persistence announcement (https://vercel.com/changelog/sandbox-persistence-is-now-ga), reconnect guide (https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox), and duration/persistence guide (https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence), reviewed 2026-08-16. The installed `@vercel/sandbox` 3.0.0 type boundary is authoritative for the named `Sandbox.get` request used here.

## ADR-023 - M08 durable runner dispatch and safe retry ownership

- **Status:** Accepted for local composition; live worker/provider acceptance pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** The SRS requires run state to survive worker/process failure, mutating commands and consumers to be idempotent, and retry/compensation behavior to be explicit. The provider recovery seam can reconnect an active sandbox, but its supplied memory store and an in-process call do not durably preserve authorized session evidence or queued work. Persisting argv, source, raw logs, credentials, or an SDK handle would violate the established minimization and recovery boundaries. Automatically replaying work whose lease expired after dispatch could duplicate an unobserved external side effect.
- **Decision:** Add a worker-owned PostgreSQL `VercelRunnerSessionStore` adapter that persists only the schema-validated credential-free workspace plan, profile/workspace evidence, a stable identity digest, and completed command replay results; live SDK handles and active promises remain transient. Require tenant/project scope on every lookup and conflict-check all idempotent inserts. Add a tenant-scoped durable dispatch ledger whose payload is only a validated protected `ArtifactReference` plus safe actor/correlation/request-time context and a stable request digest. Claims use conditional state/attempt transitions and append-only attempt evidence. Retry only an observed typed retryable failure, with deterministic bounded exponential delay. Treat an expired running lease as terminal `WORKER_LEASE_EXPIRED` and do not invoke the handler again, because the prior side effect is uncertain. The worker runtime may pump one dispatch at a time and waits for an active poll during shutdown; actual protected-artifact retrieval and command interpretation remain outside this ledger.
- **Alternatives considered:** Serializing SDK handles; persisting raw command bodies or argv in the queue; keeping dispatch in memory; allowing unbounded or provider-specific retries; automatically re-executing expired leases; assuming an insert conflict is an idempotent replay without comparing the canonical digest; embedding protected artifact access into the generic queue.
- **Consequences:** Local PostgreSQL-compatible evidence now proves persistent session rehydration without a handle, completed replay recovery, tenant isolation, immutable identity/plan controls, idempotent durable enqueue, bounded observed-failure retry, successful retry completion, append-only attempts, and terminal expired-lease handling without handler invocation. This establishes durable storage and scheduling semantics but does not prove end-to-end execution after a real worker crash or live provider side effect. M08 still requires a protected artifact reader and validated dispatch handler composed into worker startup, an approved live GitHub bundle client and artifact store, a published image digest, and organization-approved live isolation/recovery/cancellation/cleanup evidence.

## ADR-024 - M08 protected runner command resolution and authority boundary

- **Status:** Accepted for local composition; protected-store/provider activation pending
- **Date:** 2026-08-16
- **Milestone:** M08
- **Context:** ADR-023 deliberately stores only a protected artifact reference in the durable queue. Resolving that opaque reference after a delay must not allow a substituted tenant, actor, command body, media class, or digest to reach the runner. The worker also cannot treat an artifact snapshot as authority: service access, approvals, policy, repository state, workspace state, and command policy must be evaluated by deterministic orchestration at execution time. No organization-approved protected artifact provider is selected in this checkout, so enabling the server with an implicit local store would create a false production path.
- **Decision:** Define one strict versioned runner-dispatch artifact envelope for prepare, execute, cancel, and cleanup. It requires a service actor whose organization, actor reference, and correlation ID match the enclosed provider request. Add a provider-neutral `ArtifactReaderPort` that always receives the tenant/project request context. The worker handler accepts only the dedicated media type and retention class, caps content size, retrieves bytes through that scoped port, recomputes SHA-256, decodes fatal UTF-8 JSON, schema-validates the envelope, and requires the complete inner request context to equal the durable outer context. Future-issued or expired actor evidence is denied. The handler delegates the parsed request to `RunnerOrchestrationService`, which alone re-reads the current service grant and authoritative run/policy/repository/workspace state and changes state. Only an explicit typed retryable `PlatformError` may reach ADR-023's bounded retry path; untyped reader failures remain terminal. Provide a worker-owned composition root for the PostgreSQL queue, orchestration store/service, handler, and runtime pump. Server activation is controlled by explicit configuration and fails closed when protected artifact and isolation providers are absent.
- **Alternatives considered:** Storing command JSON or argv in the queue; trusting artifact URI metadata without reading and hashing bytes; parsing an unversioned command union; permitting human actors in delayed runner artifacts; trusting the actor/request snapshot without current orchestration authorization; converting every artifact-store exception into a retryable failure; enabling a filesystem or memory fallback in the server; allowing artifact/provider-specific code into domain orchestration.
- **Consequences:** Local tests prove service-only schema enforcement, tenant-scoped reads, metadata/digest/context substitution rejection, actor-expiry denial, preservation of explicit typed retryability, and runtime-pump rejection before artifact/provider access. The server has no silent execution fallback: setting `WORKER_RUNNER_DISPATCH_ENABLED=true` without injected protected artifact and isolated-runner providers stops startup. This completes the local command-resolution and handler composition seam, not live activation or production isolation. M08 still requires an approved protected artifact read/write adapter, concrete GitHub bundle client, published image digest, provider dependencies supplied to the server composition, the ADR-007 production durability decision, and organization-approved live security/recovery evidence.

## ADR-025 - M08 non-production durability and artifact evaluation boundary

- **Status:** Accepted for non-production evaluation; production engine selection deferred
- **Date:** 2026-08-18
- **Milestone:** M08
- **Context:** Approved external infrastructure now exists for Vercel Workflow,
  Temporal Cloud, Vercel Private Blob, a project-scoped VCR repository and Vercel
  Sandbox. The evaluation must produce comparable evidence without allowing beta
  Workflow code, benchmark APIs, provider credentials, raw storage URLs or an
  incomplete benchmark to become production authority.
- **Decision:** Keep Workflow `4.8.3` and `5.0.0-beta.42` on isolated benchmark
  branches, guard all benchmark routes with both Preview-only environment checks
  and a sensitive bearer token, and never merge the beta branch into the main
  application. Implement Temporal in the separately deployable worker using
  official SDK `1.22.0`, deterministic workflow IDs and an isolated task queue.
  Store artifacts privately behind a tenant/project/run-scoped application port,
  verify SHA-256 and size on every read, expose only protected application
  references, and retain immutable metadata plus a deletion mark. Publish Sandbox
  images only to the private project VCR repository from a credential-free build
  context and require an immutable image digest. Treat local official-runtime
  tests and basic guarded Preview runs as evaluation evidence, not a production
  selection. A malformed/placeholder Temporal credential is a blocker and must
  never be bypassed or copied into code.
- **Alternatives considered:** merging beta Workflow into the application;
  declaring Vercel the winner from basic Preview success; using raw Blob URLs as
  authorization; placing provider tokens in image build arguments; silently
  substituting a local Temporal server for live Cloud acceptance; selecting an
  engine before common interruption/cost evidence.
- **Consequences:** Workflow stable and beta have reproducible local and Preview
  evidence, Temporal has official time-skipping coverage plus a 2026-09-05 live
  Cloud matrix for retry, timer, approval, payload, permanent failure,
  cancellation, duplicate start and worker restart recovery, and the custom
  Sandbox image has live non-production evidence. The Temporal credential blocker
  is resolved without storing or printing the credential. ADR-007 remains deferred
  and M08 remains in progress until repeated common comparative latency/cost and
  live protected-artifact provider-composition gates are observed.

## Open production decisions

These are not blockers to contract-first/local implementation but must be resolved before their production acceptance gates:

- Durable workflow engine and hosting topology (ADR-007).
- Organization-approved AI providers, data terms, regions, and retention.
- Production secrets manager, artifact store, PostgreSQL service, and observability stack.
- Supported framework/version matrix and runner images.
- Environment-specific approval/separation-of-duties matrix and whether all single-user changes require PRs.
- Service objectives, retention windows, backup frequency, and restore-test cadence.
- Generated-site production database migration policy.
- Security, dependency, secret, and license scanners.
- Model evaluation suite and pilot benchmark repositories.
