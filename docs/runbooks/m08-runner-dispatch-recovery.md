# M08 Runner Dispatch Recovery

## Purpose and scope

This runbook covers the M08 PostgreSQL durable runner-dispatch ledger and recoverable Vercel runner-session records. It applies only to approved non-production runner environments until ADR-007 selects the production durability topology and the live M08 isolation suite passes.

The ledger stores a protected command artifact reference and safe request context. It must never contain command bodies, source, executable arguments, raw output, credentials, or unrestricted prompts.

## Safety invariants

- Reauthorize the service identity, approvals, policy, repository state, workspace state, and command policy when delayed work executes.
- Scope every diagnostic lookup by both `organization_id` and `project_id`.
- Do not update or delete dispatch attempts, provider command replays, or audit events. They are append-only evidence.
- Do not change a dispatch status, attempt count, lease, command reference, request digest, or idempotency key by hand.
- Do not automatically replay an expired `running` lease. The previous worker may have caused an external side effect before it failed.
- Never copy protected command content, provider credentials, raw output, or repository source into an incident ticket or chat.
- Production promotion remains disabled.

## State and recovery matrix

| Observed state             | Meaning                                                                                 | Automated behavior                                                                       | Operator action                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`                   | Authorized protected reference is waiting for its first claim.                          | Any healthy configured worker may claim it once `available_at` is due.                   | Restore worker/database availability. Do not create a duplicate dispatch.                                                                                                                                 |
| `retry_wait`               | A typed retryable failure was observed and recorded.                                    | A healthy worker may claim it only when `available_at` is due and attempts remain.       | Correct the named dependency failure. Preserve the existing row and timer.                                                                                                                                |
| `running`, lease unexpired | A worker owns an uncertain in-flight side effect.                                       | Other workers cannot claim it.                                                           | Check worker and provider health. Do not replay or steal the lease.                                                                                                                                       |
| `running`, lease expired   | The owning worker failed or stopped reporting before outcome persistence.               | The next poll marks it `failed` with `WORKER_LEASE_EXPIRED`; the handler is not invoked. | Investigate provider/session/artifact evidence. Reconcile the external result before issuing any new authorized command.                                                                                  |
| `succeeded`                | The handler completed and append-only attempt evidence was written.                     | No further claim occurs.                                                                 | Verify downstream run and artifact evidence if the workflow appears stalled.                                                                                                                              |
| `failed`                   | A terminal validation/provider failure, exhausted retry, or expired lease was recorded. | No further claim occurs.                                                                 | Use `last_failure_code` and attempt evidence. Fix the cause; then issue a new command through deterministic orchestration with a new idempotency key only after reconciliation and current authorization. |

## Triage procedure

1. Record the incident correlation ID, environment, worker release commit, and UTC observation time. Do not record protected payload content.
2. Confirm PostgreSQL and the configured worker are healthy. If `WORKER_RUNNER_DISPATCH_ENABLED` is true, startup must also have an approved protected artifact reader and isolated runner provider; there is no memory or filesystem fallback.
3. Locate the dispatch with tenant scope. Substitute approved identifiers through the database client's parameter binding; never interpolate them into SQL.

   ```sql
   SELECT id, organization_id, project_id, correlation_id, status,
          attempt_count, max_attempts, available_at, lease_owner,
          lease_expires_at, last_failure_code, created_at, updated_at, completed_at
   FROM worker_dispatches
   WHERE organization_id = $1 AND project_id = $2 AND id = $3;
   ```

4. Read append-only attempt evidence with the same tenant scope.

   ```sql
   SELECT attempt_number, worker_id, outcome, failure_code,
          started_at, completed_at, next_available_at
   FROM worker_dispatch_attempts
   WHERE organization_id = $1 AND project_id = $2 AND dispatch_id = $3
   ORDER BY attempt_number;
   ```

5. If the lease expired, determine whether the provider accepted or completed the command. Use only the credential-free persisted session identity and the approved provider lookup path. Verify tenant/run/workspace/profile/image/resource/network/expiry bindings before trusting provider state.
6. Reconcile protected artifacts by digest, media type, retention class, tenant, project, run, workspace, and command. A missing or mismatched artifact is not success.
7. If the outcome remains uncertain, keep the dispatch terminal and escalate for explicit human review. Do not manufacture success and do not replay it.
8. If a new attempt is authorized after reconciliation, create it through deterministic orchestration. Current service grants and approval gates must pass, and the new request must use a new idempotency key. Preserve the failed dispatch as evidence.

## Restart and shutdown expectations

- A process restart reconstructs the dispatch adapter from PostgreSQL. Persisted `queued` work remains claimable and a persisted `retry_wait` remains unavailable until its durable timer is due.
- A graceful worker shutdown stops new polls and waits for the active poll to settle. It does not cancel an already dispatched provider command implicitly.
- A crash during `running` intentionally enters the expired-lease reconciliation path. Automatic at-least-once replay is forbidden for this privileged boundary.
- Recoverable provider-session rows contain validated credential-free plans and completed replay results, not SDK handles. Reconnection must use the deterministic provider name and revalidate all stored/provider evidence.

## Evidence required before closing an incident

- Exact dispatch and attempt states before and after recovery, queried with tenant/project scope.
- Worker release commit, configuration class (without secret values), and relevant safe failure codes.
- Provider session verification and artifact-digest reconciliation, or an explicit statement that the external outcome remained uncertain.
- Current authorization/approval evidence for any replacement command.
- Confirmation that append-only records were not altered and no production deployment, domain, DNS, or secret change occurred.

## Escalation boundaries

Stop and obtain product/security/operations approval if recovery would require a manual database mutation, credential exposure, unapproved provider access, production access, bypassing current authorization, or treating uncertain side effects as safe to repeat. ADR-007 remains deferred; this runbook is evidence for the current PostgreSQL-backed M08 candidate, not approval of the production workflow engine.
