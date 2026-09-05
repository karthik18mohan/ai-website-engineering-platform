# Implementation Plan - SRS v1.1

## Purpose and execution rules

This plan maps SRS milestones M01-M20 to concrete work, dependencies, validation, and the evidence required before a completion claim. The PDF at `docs/product/AI_Website_Engineering_Platform_SRS_v1.1_AI_Cost_Controller.pdf` is authoritative. `docs/product/SRS_EXTRACTED.md` is a searchable companion, not a replacement.

Delivery proceeds in milestone order. A later milestone may add a contract seam or test fixture early when this is required to keep the current implementation safe, but it is not thereby complete. In particular, **no model-backed feature may invoke a provider until the minimum AI Cost Controller gateway, estimate, policy/budget decision, routing record, and usage reconciliation path exist**; M17 completes the full registries, optimization/cache, analytics, dashboards, calibration, and budget surface.

Each milestone is complete only when:

- its SRS deliverables and acceptance statement are implemented without mandatory gates being relaxed;
- schemas, APIs, commands, events, callbacks, migrations, and model outputs are versioned and boundary-validated;
- applicable format, lint, typecheck, unit, integration, contract, migration, production build, security/secret, browser, accessibility, and preview checks actually pass;
- evidence records contain exact commands/outcomes and only tool-reported counts;
- security, database/recovery, provider state, limitations, external actions, commit, and next dependency are recorded in `docs/IMPLEMENTATION_STATUS.md`;
- `docs/SESSION_HANDOFF.md` and `docs/CONTINUATION_PROMPT.md` reflect the checkpoint.

## Dependency spine

M01 -> M02 -> M03 -> M04 -> M05 -> M06 -> M07 -> M08 -> M09 -> M10 -> M11 -> M12 -> M13 -> M14 -> M15 -> M16 -> M17 -> M18 -> M19 -> M20.

Cross-cutting constraints apply throughout: tenant scoping begins in M01/M02; provider neutrality begins in M03; the mandatory AI Cost Controller gate precedes the first model call; deterministic state and policy precede mutation; append-only audit begins in M02; immutable commit/evidence linkage begins in M11; production promotion remains disabled until M15/M18/M20 gates and explicit human authorization are satisfied.

## M01 - Foundation (completed)

- **Tasks:** Bootstrap pinned npm workspaces for `apps/web`, `apps/api`, `apps/worker`, SRS-aligned packages, and shared test/config packages; enable strict TypeScript and consistent format/lint/test/build scripts; create Next.js App Router web and Fastify API health surfaces; define configuration parsing with safe environment separation; create the authentication/session port and deny-by-default skeleton without claiming a production identity provider; define PostgreSQL/Drizzle schema foundation, forward migrations, tenant identifiers, append-only audit conventions, migration purpose/recovery notes, and local/test seed guard; create CI gates for formatting, lint, typecheck, unit/contract tests, build, migration validation, dependency/secret scanning; establish typed errors, structured/redacted logging, correlation IDs, and initial orchestration/state-machine seams.
- **Dependencies:** Node.js/npm (available per audit); a PostgreSQL endpoint/toolchain is required for live migration integration but was not found; auth provider selection/credentials are not required for the port and local test identity.
- **Tests/checks:** Workspace install reproducibility; format/lint/typecheck; unit tests for configuration, health, typed errors/redaction, and foundational state rules; API/web health integration tests; schema/migration static validation and live PostgreSQL apply/rollback-recovery test when a safe local/test endpoint exists; production builds; dependency and secret scans.
- **Completion evidence:** Pinned lockfile and workspace manifests; passing root CI-equivalent command log; health response evidence from web/API; initial migration files plus recovery notes and migration test output; CI workflow run; no-secret scan result; commit `feat(M01): initialize platform foundation [codex]` (or documented equivalent) and branch/PR reference.

## M02 - Projects and RBAC (completed)

- **Tasks:** Implement User, Organization, Membership, Project, Policy reference, and append-only AuditEvent storage/services; define Owner, Developer, Designer, Reviewer, Viewer, and scoped service identities; add organization/project tenant guards and distinct request/approve/merge/promote/secret/policy permissions; create project lifecycle APIs for create/archive/restore/delete subject to retention policy; authorize at command issue and re-check delayed privileged execution; emit audit events for authentication and denied/allowed project actions.
- **Dependencies:** M01 auth/session port, persistence/migration pattern, error/contract conventions.
- **Tests/checks:** Role/permission decision table unit tests; cross-organization/project isolation integration tests; unauthorized and stale-membership rejection; append-only audit correction behavior; project lifecycle and retention contract tests; migration validation.
- **Completion evidence:** Versioned RBAC and project schemas; migration and recovery notes; API contract fixtures; test proving an unauthorized action is rejected **and audited**; cross-tenant negative tests; commit and CI evidence.

## M03 - Provider framework (completed)

- **Tasks:** Define versioned ports/contracts for secrets, Git, deployment, model providers, artifacts, runner, and orchestration; keep provider tokens as secret references rather than plaintext tables; implement deterministic mock adapters and common conformance suites; define provider callback verification/deduplication/idempotency envelope; introduce the single AI Cost Controller invocation port so agents/services cannot call a model adapter directly; model capability/pricing/routing values remain configuration/data, never hardcoded business rules.
- **Dependencies:** M01 contracts/config/logging; M02 actor, tenant, permission, and audit context.
- **Tests/checks:** Mock adapter contract suites; compile-time/package-boundary checks against vendor leakage/direct model imports; secret-reference/redaction tests; callback replay/out-of-order tests; provider outage and typed-error tests; audit attribution tests.
- **Completion evidence:** Versioned adapter schemas; mock conformance report; dependency-rule proof that direct LLM-provider imports are barred outside adapter/controller composition; secret handling evidence; exact test log and commit.

## M04 - GitHub onboarding (completed)

- **Tasks:** Implement GitHub App adapter authentication with least-privilege installation scopes; connection initiation/callback with secret references; repository selection and access verification; sync repository ID, permissions, default branch, framework/package/build/test metadata placeholders, and indexed commit; authenticate, deduplicate, and replay-safely process installation/repository/push webhooks; surface readiness without enabling mutation until onboarding checks pass.
- **Dependencies:** M02 provider permissions/audit; M03 Git/secrets ports and callback envelope; external GitHub App configuration only for real-provider validation.
- **Tests/checks:** Mock GitHub contract and fixture onboarding; invalid/expired callback signature; duplicate/out-of-order webhook; lost installation access; repository permission and default-branch verification; no-token response/log tests.
- **Completion evidence:** A fixture project that verifies permitted repository access and default branch; webhook replay evidence; provider scope review; real GitHub installation evidence when configured, otherwise clearly labeled mock/contract evidence and exact owner setup action.

## M05 - Repository intelligence (completed)

- **Tasks:** Index an immutable commit into a repository map; detect language/framework, package manager, scripts, routes, exports/imports, symbols, components, stories/examples, tests, configuration, architecture instructions, ownership, and recent commit context; exclude generated, vendor, binary, large, and secret-policy files; create lexical/symbol/dependency retrieval first, semantic retrieval behind a port; attach commit/provenance/digest/token metadata to every context item; invalidate commit/config-addressed indexes safely.
- **Dependencies:** M04 repository access and immutable commit; M03 artifact/search ports; tenant-isolated storage from M01/M02.
- **Tests/checks:** Golden fixture repositories for supported Next.js/TypeScript profiles; package-manager/command detection; expected route/symbol/import graphs; exclusion/secret-redaction tests; stale index/invalidation; cross-tenant search denial; deterministic-map repeatability.
- **Completion evidence:** Known fixture repositories produce reviewed golden maps at known commits; retrieval manifests show provenance and exclusions; no-secret/index isolation result; contract/unit/integration report and commit.

## M06 - Prompt and requirements (completed)

- **Tasks:** Implement immutable ChangeRequest intake API/UI for original prompt, mode, attachments, target, constraints, and actor; support Builder, Designer, Refactor, Debug, SEO, Performance, Accessibility, and Content modes; validate/malware-scan attachment metadata and treat image/web/repository text as untrusted data; define versioned `RequirementSpec` with goals, non-goals, assumptions, acceptance criteria, impacted surfaces, constraints, risk signals, and attachment references; invoke the Requirement role only through the AI Cost Controller and schema-validate its output; expose assumptions and review/correction before execution.
- **Dependencies:** M02 authorization/audit; M03 model/cost-controller and artifact ports; M05 context selection; minimum M17 gateway behavior (estimate, budget/policy route, usage/reconciliation) before any live model call.
- **Tests/checks:** Request/API schema contracts; all mode fixtures; prompt-injection and attachment trust-label tests; schema failure one-retry-then-stop; budget denial before provider call; immutable original prompt plus reviewable corrected requirement; accessibility tests for the intake/review UI.
- **Completion evidence:** A fixture prompt becomes a persisted, schema-valid, human-reviewable `RequirementSpec`; routing/pricing/estimate/usage references for every model-backed fixture; no bypass test; API/UI/contract evidence and commit.

## M07 - Planner and policy (completed)

- **Tasks:** Define versioned `ExecutionPlan`, task dependencies, expected files, validations, rollback considerations, estimated usage, and requested approvals; implement Low/Medium/High/Blocked risk classification and environment/project policy snapshots; create deterministic approval state machine and role checks; require architecture/UI/security analysis for relevant impacts; ensure only orchestration can transition run state and policy failures cannot be automatically relaxed.
- **Dependencies:** M06 accepted requirement; M02 RBAC/audit; M03 orchestration/model ports; cost estimate/budget decision.
- **Tests/checks:** Golden risk fixtures including auth, payment, secret, infrastructure, DB migration, destructive, and prohibited requests; approval authorization/staleness; blocked-request audit; deterministic transition/property tests; duplicate approval idempotency; high-risk no-mutation assertion.
- **Completion evidence:** High-risk fixture is demonstrably paused in `AWAITING_APPROVAL` before workspace creation/file mutation; approved/rejected/blocked audit timeline; plan schema fixtures; test/commit evidence.

## M08 - Isolated runner (in progress)

- **Tasks:** Implement runner port and an ephemeral workspace backend based on an immutable base commit; CPU/memory/time/filesystem/process/network/egress controls; command/tool allowlist; approved registry and install-script policy; artifact capture by digest and retention class; cancellation/cleanup; no cloud or production secret exposure; stable idempotency keys and typed runner errors. Select/validate runner image/profile without treating a host-process mock as production isolation.
- **Dependencies:** M07 approved execution; M04 immutable repository access; M03 runner/artifact/secrets ports; approved container/sandbox runtime is an external prerequisite for production-grade isolation.
- **Tests/checks:** Forbidden host filesystem, process, network, credential, and production-secret access; resource/time limits; allowlist denial; immutable checkout digest; cleanup after success/failure/cancel; artifact integrity; malicious install/script fixtures.
- **Completion evidence:** Isolation suite proves the runner cannot access forbidden host resources; base commit and artifact digests recorded; local mock clearly distinguished from production backend; runner threat review, commands, and commit.

## M09 - Coding loop (not started)

- **Tasks:** Assemble minimum sufficient context using repository/dependency/symbol evidence, relevant tests/docs/tokens, commit provenance, deduplication, cache, and redaction; invoke Coder through controller and constrained patch tools only; enforce changed-file/scope/dependency/migration/lockfile/generated-file policies; apply incremental patches against base commit; implement bounded schema/tool/build repair attempts with attempt history, stable idempotency, file/token/time limits, and no gate relaxation.
- **Dependencies:** M05 repository intelligence; M06/M07 requirement and plan; M08 isolated runner; minimum AI Cost Controller enforcement.
- **Tests/checks:** Simple fixture feature/edit; unrelated formatting/file rewrite rejection; dependency approval and lockfile consistency; context insufficiency retrieval; patch conflict/upstream change stop; bounded repair exhaustion; every attempt/diff retained; secret/context redaction.
- **Completion evidence:** A simple fixture change produces a narrow valid patch with context manifest and attempt lineage; relevant-only context/tokens evidence; no direct provider call; unit/integration/security report and commit.

## M10 - Deterministic validation (not started)

- **Tasks:** Implement ordered gates for workspace integrity/changed-file policy, formatter/lint, static types, impacted unit tests, integration/API tests, production build, secret/dependency/license/source security scans, and policy decision; store suite/version, exact command, commit, environment, timing, status, tool-provided summary, report/log refs, and failure classification; block commit state on any mandatory failure; expose eligible failures to bounded repair without marking them passed.
- **Dependencies:** M08 runner; M09 patch/attempt lineage; project command metadata from M04/M05.
- **Tests/checks:** Passing and deliberately failing fixtures for every configured gate; order/short-circuit policy; timeout/cancellation; flaky/infrastructure classification without fabricated success; report digest integrity; commit transition denied on failure.
- **Completion evidence:** A required-check failure demonstrably blocks `COMMITTING`; a clean fixture passes all configured pre-commit gates; complete validation records and exact command outputs; commit.

## M11 - Git write path (not started)

- **Tasks:** Through the Git adapter only, create policy-compliant per-run branches, attributed commit metadata, push, optional/required PRs, and status checks; verify remote head/base commit immediately before write; scan secrets/prohibited files before push; map run, change request, base/result commit, validation, requester, and service identity; stop or policy-govern rebase on upstream conflicts; protect `main` and prohibit force push.
- **Dependencies:** M04 GitHub adapter; M10 passed immutable validation; M07 policy/approvals; M02 audit.
- **Tests/checks:** Adapter contract for branch/commit/push/PR/status; no commit after failed/stale validation; protected branch and force-push denial; upstream conflict; duplicate/idempotent requests; secret scan denial; signed/attributed metadata policy.
- **Completion evidence:** Fixture result commit maps to the run and base commit; branch/PR/status evidence; rejection fixtures for stale/failed/secret cases; real provider evidence if configured or mock contract evidence plus external action; commit.

## M12 - Vercel preview (not started)

- **Tasks:** Implement Vercel behind the deployment adapter; map team/project/framework/root/build/environment settings; request preview for the exact tested committed SHA; verify/poll and process authenticated replay-safe webhooks to a terminal state; persist provider deployment ID, URL, commit, status, evidence, and retention; keep preview/production secrets distinct and prevent production promotion.
- **Dependencies:** M11 committed SHA; M03 deployment/secrets contracts; Vercel authentication and project link for real preview (audit says authenticated but unlinked).
- **Tests/checks:** Mock adapter conformance; commit mismatch rejection; invalid/duplicate/out-of-order webhook; provider failure/timeout; environment mapping and secret-scope denial; real preview smoke only from a committed tested SHA when linked.
- **Completion evidence:** Exact tested commit reaches preview and its URL/provider ID are recorded; build terminal-state evidence; no production mutation; otherwise adapter/mock/setup evidence and exact owner linking action; commit.

## M13 - Browser and visual QA (not started)

- **Tasks:** Run Playwright against the deployed preview at governed desktop/mobile viewports; capture screenshots by digest; collect console/network failures; run automated accessibility scans plus keyboard/focus/reduced-motion/manual-oriented checks; visual regression and optional configured Lighthouse/performance checks; bind every artifact to preview deployment and commit; feed failures into policy/repair without silent baselines.
- **Dependencies:** M12 ready preview; M10 validation evidence; M07 visual/risk policy.
- **Tests/checks:** Configured happy/error/loading flow; desktop/mobile; deliberate console/network/a11y/visual regressions; baseline approval/integrity; artifact authorization and retention; commit/deployment mismatch.
- **Completion evidence:** Configured smoke flow passes on a preview fixture, with accessible screenshot/test artifacts tied to exact commit and deployment; failure fixtures block review readiness as configured; commit.

## M14 - Workspace UX (not started)

- **Tasks:** Deliver project workspace with chat/requirements, plan/assumptions/risk, deterministic progress, file tree/diff, preview, tests, logs, approvals, cost panel, warnings, and actions; dashboard projects/runs/previews/warnings/spend; accessible History/Deployments/Settings/Audit foundations; plain-language errors with expandable protected evidence; destructive controls disabled without permission/prerequisites; status labels derived only from state-machine values.
- **Dependencies:** M02-M13 read models, evidence APIs, permissions, event stream/polling; M17-compatible usage view contracts.
- **Tests/checks:** Component/accessibility/keyboard/focus/announcement/reduced-motion tests; end-to-end review flow; role-specific visibility/actions; loading/empty/error/large-diff pagination; no raw secret/prompt/source leakage; UI cannot manufacture status.
- **Completion evidence:** A user can review requirement, plan, progress, diff, preview, tests, logs, approvals, warnings, and cost evidence in one workspace; WCAG-oriented automated evidence and browser flow; commit.

## M15 - Versioning and rollback (not started)

- **Tasks:** Implement Version and Release ledgers linking prompt, requirement, plan, base/result commits, changed files, validation, preview, approvals, memory, usage/cost, and audit; immutable labels and known-good references; governed discard, undo-as-new-revert, restore-as-new-change, and production rollback to an eligible prior commit; environment lock, fresh gates, post-action health verification, previous-release link; explicitly separate database recovery from code rollback.
- **Dependencies:** M11 commit lineage; M12/M13 deployment evidence; M07 approvals/policy; M02 audit.
- **Tests/checks:** Ledger completeness/immutability; eligibility and stale-gate checks; concurrent release lock; revert/restore history preservation; rollback failure/compensation; post-rollback health; database migration incompatibility stop.
- **Completion evidence:** Rollback fixture creates a new auditable release, retains prior history, points to a known-good immutable commit, and verifies health; no autonomous production execution; commit.

## M16 - Memory and documentation (not started)

- **Tasks:** Implement structured Pinned policy, Brand, Design system, Engineering, Domain, Preference, and Episodic memory with scope, provenance, creator, confidence, timestamps, status, and supersession; derive candidates only from accepted evidence; repository/current config overrides stale derived memory; view/edit/pin/unpin/delete with audit/retention; documentation role updates only configured changelog/ADRs/component catalog/setup notes; context retrieval is scoped and manifest-based.
- **Dependencies:** M05 provenance/indexing; M14 UX; M15 accepted version evidence; M02 RBAC/audit.
- **Tests/checks:** Accepted-versus-rejected candidate extraction; pinned item cannot be silently overwritten; correction/supersession/deletion; stale source precedence; tenant/cache isolation; sensitive-value rejection; documentation narrow-diff tests.
- **Completion evidence:** An accepted change updates configured memory/docs and a user can inspect and correct it with provenance/audit retained; cross-tenant and pinned-policy tests; commit.

## M17 - AI Cost Controller and model routing (not started)

- **Tasks:** Complete versioned/effective-dated ModelPricing and ModelRegistry data, model classes/capabilities/quality/latency/availability, provider/privacy/region eligibility, token/time/cost estimators with confidence, configurable lowest-cost eligible routing and approved fallback, per-request/daily/weekly/monthly/user/project/organization budgets and actions, minimum-context optimizer, compression/deduplication/batching/unchanged-file skipping/patch preference, tenant/commit/config-addressed cache, AIUsage/CostEstimate/TokenStatistics/UsageSession/RoutingDecision/OptimizationLog ledgers, actual provider reconciliation and variance calibration, estimate/pricing/usage/history/recommendation/budget APIs, workspace cost panel, and dashboard analytics/warnings/alternatives/confirmation.
- **Dependencies:** M03 mandatory gateway and provider contracts; M05 context evidence; M06-M16 task/run/user/project/usage data. No earlier live model call is permitted without the minimum controller path.
- **Tests/checks:** Static/runtime no-bypass enforcement; model eligibility and lowest-cost routing; pricing effective dates/currency/units; estimate confidence and actual variance; soft warning/confirmation/downgrade/reduce-scope/hard denial; provider failover without policy/budget/privacy bypass; stale pricing; cache tenant isolation/freshness/deletion/integrity; optimization token/savings evidence; API/UI analytics authorization; provider usage missing/malformed reconciliation.
- **Completion evidence:** Every model fixture references estimate, budget decision, routing decision, pricing version, context manifest, optimization actions, provider usage, actual cost, and variance; hard budget prevents the next paid call; mappings/pricing change without code deployment; dashboard/API evidence; commit.

## M18 - Security hardening (not started)

- **Tasks:** Complete threat controls for prompt injection, credentials, malicious dependencies/scripts, destructive Git, unauthorized release, cross-tenant leakage, artifact tampering, denial/cost abuse, sensitive retention, and unsafe generated code; integrate approved secret/SAST/dependency/license/source scanners; short-lived least-privilege credentials, redaction, egress/registry/install policies, attachment malware/type validation, artifact digests/attestations, rate/concurrency limits, retention/deletion workflows, fresh privileged authorization, and environment separation; document threat model and residual risk.
- **Dependencies:** All prior boundaries and data flows, especially M02/M03/M08/M11/M12/M17; external approval of scanners/provider terms where needed.
- **Tests/checks:** Security acceptance suite, secret history/worktree/artifact scan, cross-tenant matrix, injection corpus, webhook forgery/replay, RBAC/production gate, sandbox escape/egress, cache leak, dependency/install attack, rate/cost abuse, retention/deletion, supply-chain integrity.
- **Completion evidence:** Security acceptance suite passes with exact scanner versions/results and reviewed exceptions; no secrets in prompts/logs/artifacts/history; threat-control matrix and residual/open external actions; commit.

## M19 - Reliability and observability (not started)

- **Tasks:** Select durable workflow engine/topology via ADR-007 benchmark; implement durable commands/events/state, retries/backoff, timeouts, idempotency, compensation, cancellation, worker recovery, concurrency/environment locks, provider outage degradation, and resumable human approvals; add structured tenant/project/run/task/correlation logs, traces across API/orchestration/model/tools/Git/deploy, operational and AI-cost metrics, alerts for stalls/failures/security/budget/spend/variance/stale pricing/routes/token growth, dashboards, backup/restore and failed release/rollback runbooks; set measurable SLOs and retention/restore cadence.
- **Dependencies:** M01 orchestration seam and accepted follow-up engine ADR; complete M02-M18 workflows/evidence; chosen observability/backup services for production validation.
- **Tests/checks:** Process kill/restart at every critical state; duplicate/out-of-order events; provider timeouts/outages; cancellation/cleanup; retry limits/compensation; concurrent promotion lock; database/artifact backup restore drill; alert firing/routing; trace/log redaction and correlation; spend anomaly and pricing freshness.
- **Completion evidence:** Injected failures recover or stop in defined terminal/resumable states without duplicate privileged effects; dashboards/alerts and runbooks exercised; restore evidence and SLOs recorded; commit.

## M20 - Pilot readiness (not started)

- **Tasks:** Publish supported framework/profile/package-manager/runner matrix; create safe onboarding and sample projects; finalize setup, provider, security, data, backup, recovery, cost, incident, and owner-action documentation; run complete requirement-to-evidence and acceptance-checklist review; conduct operational/security/QA approvals; validate GitHub and Vercel preview on committed code, end-to-end prompt-to-preview, review, governed release simulation, version/revert/rollback, budgets/cancellation/outage behavior, and memory correction; create final reviewable PR without merge or production deployment.
- **Dependencies:** M01-M19 complete; approved pilot accounts/providers, test repository, linked non-production Vercel project, test PostgreSQL/artifact/secrets/observability services, and required human reviewers.
- **Tests/checks:** Full repository validation; local end-to-end; migration forward/recovery; security acceptance; cross-tenant; browser/accessibility/visual/performance; provider contracts; exact-commit preview smoke; failure/rollback drills; all SRS acceptance checklist items.
- **Completion evidence:** End-to-end pilot checklist and requirement-to-evidence matrix pass with exact commands, reports, commit, preview URL, and reviewer decisions; final docs/PR reference; no merge or production deployment.

## External prerequisites register

These do not block contract-first/local work unless stated, and must never be represented as validated provider/production behavior:

- Safe local/test PostgreSQL endpoint and migration client/tooling; Docker, `psql`, and local PostgreSQL tools were not found in the initial audit.
- GitHub App registration/configuration, installation scopes, webhook secret, and fixture repository for real M04/M11 checks. GitHub CLI authentication was reported available at the initial audit.
- Vercel non-production project/team link and environment mapping for M12/M13/M20. Vercel CLI authentication was reported available, but this repository was not linked.
- Approved production secrets manager, artifact store, database service, observability stack, workflow engine/topology, security scanners, AI providers/data terms/regions, model benchmark fixtures, runner runtime/images, approval matrix, SLOs, retention, backup, and restore policies.
- Product-owner confirmation of the SRS repeating-header v1.0 versus document-control/revision-history v1.1 anomaly; implementation proceeds against v1.1 in the meantime.
