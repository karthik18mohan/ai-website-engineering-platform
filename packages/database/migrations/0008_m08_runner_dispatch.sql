-- Purpose: Persist credential-free runner provider recovery state and add a
-- tenant-scoped durable worker dispatch queue with bounded retry evidence.
-- Forward procedure: apply once after 0007_m08_runner_lifecycle.sql. Existing
-- runner rows are unchanged; new provider sessions and dispatches start empty.
-- Recovery guidance: stop workers first. Preserve/export all rows for audit and
-- incident review, then drop the triggers, functions, attempt/replay tables,
-- dispatch table, and provider-session table in reverse dependency order. A
-- down migration is intentionally not automated because dispatch/attempt
-- evidence is operational and append-only.

CREATE TABLE runner_provider_sessions (
  provision_key text PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  execution_plan_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  request_fingerprint text NOT NULL,
  identity_digest text NOT NULL,
  plan jsonb NOT NULL,
  profile jsonb NOT NULL,
  workspace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runner_provider_sessions_tenant_provision_unique
    UNIQUE (organization_id, project_id, provision_key),
  CONSTRAINT runner_provider_sessions_tenant_workspace_unique
    UNIQUE (organization_id, project_id, workspace_id),
  CONSTRAINT runner_provider_sessions_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id, execution_plan_id)
    REFERENCES runs (organization_id, project_id, id, execution_plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_provider_sessions_provision_key_check CHECK (length(provision_key) = 64),
  CONSTRAINT runner_provider_sessions_request_fingerprint_check
    CHECK (length(request_fingerprint) = 64),
  CONSTRAINT runner_provider_sessions_identity_digest_check CHECK (length(identity_digest) = 64),
  CONSTRAINT runner_provider_sessions_provider_check CHECK (provider = 'vercel_sandbox'),
  CONSTRAINT runner_provider_sessions_plan_check CHECK (jsonb_typeof(plan) = 'object'),
  CONSTRAINT runner_provider_sessions_profile_check CHECK (jsonb_typeof(profile) = 'object'),
  CONSTRAINT runner_provider_sessions_workspace_check CHECK (jsonb_typeof(workspace) = 'object')
);
--> statement-breakpoint

CREATE TABLE runner_provider_command_replays (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provision_key text NOT NULL,
  command_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT runner_provider_command_replays_pk
    PRIMARY KEY (organization_id, project_id, command_id),
  CONSTRAINT runner_provider_command_replays_session_tenant_fk
    FOREIGN KEY (organization_id, project_id, provision_key)
    REFERENCES runner_provider_sessions (organization_id, project_id, provision_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_provider_command_replays_fingerprint_check
    CHECK (length(request_fingerprint) = 64),
  CONSTRAINT runner_provider_command_replays_result_check CHECK (jsonb_typeof(result) = 'object')
);
--> statement-breakpoint

CREATE TABLE worker_dispatches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_ref text NOT NULL,
  correlation_id uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  command_ref jsonb NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  last_failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT worker_dispatches_tenant_idempotency_unique
    UNIQUE (organization_id, project_id, idempotency_key),
  CONSTRAINT worker_dispatches_tenant_id_unique UNIQUE (organization_id, project_id, id),
  CONSTRAINT worker_dispatches_project_tenant_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES projects (organization_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT worker_dispatches_request_digest_check CHECK (length(request_digest) = 64),
  CONSTRAINT worker_dispatches_actor_ref_check
    CHECK (actor_ref ~ '^(user|service):[0-9a-f-]{36}$'),
  CONSTRAINT worker_dispatches_idempotency_key_check
    CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  CONSTRAINT worker_dispatches_command_ref_check CHECK (jsonb_typeof(command_ref) = 'object'),
  CONSTRAINT worker_dispatches_status_check
    CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
  CONSTRAINT worker_dispatches_attempts_check
    CHECK (attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT worker_dispatches_lease_shape_check CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT worker_dispatches_completion_shape_check CHECK (
    (status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX worker_dispatches_claim_idx ON worker_dispatches (status, available_at);
--> statement-breakpoint

CREATE TABLE worker_dispatch_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  outcome text NOT NULL,
  failure_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  next_available_at timestamptz,
  CONSTRAINT worker_dispatch_attempts_dispatch_number_unique
    UNIQUE (organization_id, project_id, dispatch_id, attempt_number),
  CONSTRAINT worker_dispatch_attempts_dispatch_tenant_fk
    FOREIGN KEY (organization_id, project_id, dispatch_id)
    REFERENCES worker_dispatches (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT worker_dispatch_attempts_number_check CHECK (attempt_number BETWEEN 1 AND 10),
  CONSTRAINT worker_dispatch_attempts_outcome_check
    CHECK (outcome IN ('succeeded', 'retry_scheduled', 'failed', 'lease_expired'))
);
--> statement-breakpoint

CREATE FUNCTION enforce_runner_provider_session_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provision_key IS DISTINCT FROM OLD.provision_key
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.execution_plan_id IS DISTINCT FROM OLD.execution_plan_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.identity_digest IS DISTINCT FROM OLD.identity_digest
    OR NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.profile IS DISTINCT FROM OLD.profile
    OR (NEW.workspace - 'state') IS DISTINCT FROM (OLD.workspace - 'state')
    OR NOT (
      NEW.workspace->>'state' = OLD.workspace->>'state'
      OR (OLD.workspace->>'state' = 'ready' AND NEW.workspace->>'state' IN ('cancelled', 'destroyed'))
      OR (OLD.workspace->>'state' = 'cancelled' AND NEW.workspace->>'state' = 'destroyed')
    )
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'runner provider session identity is immutable and state moves forward only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION enforce_worker_dispatch_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.actor_ref IS DISTINCT FROM OLD.actor_ref
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.command_ref IS DISTINCT FROM OLD.command_ref
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT (
      (OLD.status IN ('queued', 'retry_wait') AND NEW.status = 'running' AND NEW.attempt_count = OLD.attempt_count + 1)
      OR (OLD.status = 'running' AND NEW.status IN ('retry_wait', 'succeeded', 'failed') AND NEW.attempt_count = OLD.attempt_count)
    )
  THEN
    RAISE EXCEPTION 'worker dispatch identity is immutable and transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION reject_runner_dispatch_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runner dispatch evidence is append-only';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER runner_provider_sessions_enforce_update
BEFORE UPDATE ON runner_provider_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_runner_provider_session_update();
--> statement-breakpoint

CREATE TRIGGER runner_provider_command_replays_append_only
BEFORE UPDATE OR DELETE ON runner_provider_command_replays
FOR EACH ROW EXECUTE FUNCTION reject_runner_dispatch_evidence_mutation();
--> statement-breakpoint

CREATE TRIGGER worker_dispatches_enforce_update
BEFORE UPDATE ON worker_dispatches
FOR EACH ROW EXECUTE FUNCTION enforce_worker_dispatch_update();
--> statement-breakpoint

CREATE TRIGGER worker_dispatch_attempts_append_only
BEFORE UPDATE OR DELETE ON worker_dispatch_attempts
FOR EACH ROW EXECUTE FUNCTION reject_runner_dispatch_evidence_mutation();
