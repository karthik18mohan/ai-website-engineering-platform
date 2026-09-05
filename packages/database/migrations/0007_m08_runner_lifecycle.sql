-- Migration: 0007_m08_runner_lifecycle
-- Purpose: Persist tenant-scoped M08 workspace, command, artifact-reference,
-- cancellation, and cleanup evidence without raw command output or secrets.
--
-- Forward procedure:
--   1. Verify target, backup/PITR point, and that 0001-0006 are applied.
--   2. Apply with the package migration runner.
--   3. Verify tenant foreign keys, idempotency constraints, append-only evidence,
--      and the restricted workspace lifecycle transitions.
--
-- Recovery guidance:
--   Roll back the application while retaining these additive evidence tables.
--   Correct defects with a reviewed forward migration. In a disposable
--   local/test database only, drop the runner tables, triggers, and added
--   constraints. Production recovery uses approved backup/PITR and retains
--   accepted audit and runner evidence.

ALTER TABLE service_identity_permissions
  DROP CONSTRAINT service_identity_permissions_permission_check;
--> statement-breakpoint
ALTER TABLE service_identity_permissions
  ADD CONSTRAINT service_identity_permissions_permission_check CHECK (permission IN (
    'project:read', 'project:create', 'project:archive', 'project:restore', 'project:delete',
    'change:request', 'change:approve', 'run:execute', 'repository:connect', 'git:merge',
    'release:promote', 'secret:manage', 'policy:modify', 'member:manage'
  ));
--> statement-breakpoint

ALTER TABLE runs
  ADD CONSTRAINT runs_tenant_id_plan_unique
  UNIQUE (organization_id, project_id, id, execution_plan_id);
--> statement-breakpoint

CREATE TABLE runner_workspaces (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  execution_plan_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  base_commit text NOT NULL CHECK (length(base_commit) = 40),
  profile_digest text NOT NULL CHECK (length(profile_digest) = 64),
  backend_class text NOT NULL CHECK (backend_class IN ('conformance_fixture', 'production_isolation')),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  checkout_evidence jsonb NOT NULL CHECK (jsonb_typeof(checkout_evidence) = 'object'),
  state text NOT NULL CHECK (state IN ('ready', 'cancelled', 'destroyed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT runner_workspaces_organization_project_id_unique
    UNIQUE (organization_id, project_id, id),
  CONSTRAINT runner_workspaces_tenant_run_unique
    UNIQUE (organization_id, project_id, run_id),
  CONSTRAINT runner_workspaces_tenant_idempotency_unique
    UNIQUE (organization_id, project_id, idempotency_key),
  CONSTRAINT runner_workspaces_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id, execution_plan_id)
    REFERENCES runs (organization_id, project_id, id, execution_plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_workspaces_plan_tenant_fk
    FOREIGN KEY (organization_id, project_id, execution_plan_id)
    REFERENCES execution_plans (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint

CREATE TABLE runner_commands (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  base_commit text NOT NULL CHECK (length(base_commit) = 40),
  profile_digest text NOT NULL CHECK (length(profile_digest) = 64),
  tool text NOT NULL,
  executable text NOT NULL,
  working_directory text NOT NULL,
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 3600000),
  execution_kind text NOT NULL CHECK (execution_kind IN ('simulated_conformance', 'isolated_runtime')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled', 'rejected')),
  exit_code integer,
  rejection_code text,
  stdout_ref jsonb,
  stderr_ref jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT runner_commands_organization_project_id_unique
    UNIQUE (organization_id, project_id, id),
  CONSTRAINT runner_commands_tenant_idempotency_unique
    UNIQUE (organization_id, project_id, idempotency_key),
  CONSTRAINT runner_commands_workspace_tenant_fk
    FOREIGN KEY (organization_id, project_id, workspace_id)
    REFERENCES runner_workspaces (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_commands_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES runs (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint

CREATE TABLE runner_artifacts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  command_id uuid NOT NULL,
  path text NOT NULL,
  reference jsonb NOT NULL CHECK (
    jsonb_typeof(reference) = 'object'
    AND reference->>'digest' = digest
    AND reference->>'mediaType' = media_type
    AND reference->>'retentionClass' = retention_class
  ),
  digest text NOT NULL CHECK (length(digest) = 64),
  media_type text NOT NULL,
  retention_class text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  CONSTRAINT runner_artifacts_pk
    PRIMARY KEY (organization_id, project_id, command_id, path),
  CONSTRAINT runner_artifacts_command_tenant_fk
    FOREIGN KEY (organization_id, project_id, command_id)
    REFERENCES runner_commands (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_artifacts_workspace_tenant_fk
    FOREIGN KEY (organization_id, project_id, workspace_id)
    REFERENCES runner_workspaces (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_artifacts_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES runs (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint

CREATE TABLE runner_lifecycle_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('cancel', 'cleanup')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  result_status text NOT NULL CHECK (result_status IN (
    'cancelled', 'already_cancelled', 'destroyed', 'already_destroyed'
  )),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT runner_lifecycle_tenant_action_idempotency_unique
    UNIQUE (organization_id, project_id, action, idempotency_key),
  CONSTRAINT runner_lifecycle_workspace_tenant_fk
    FOREIGN KEY (organization_id, project_id, workspace_id)
    REFERENCES runner_workspaces (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runner_lifecycle_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES runs (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint

CREATE FUNCTION enforce_runner_workspace_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.execution_plan_id IS DISTINCT FROM OLD.execution_plan_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.backend_class IS DISTINCT FROM OLD.backend_class
    OR NEW.profile IS DISTINCT FROM OLD.profile
    OR NEW.checkout_evidence IS DISTINCT FROM OLD.checkout_evidence
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'runner workspace identity and evidence are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.state = NEW.state OR
    (OLD.state = 'ready' AND NEW.state IN ('cancelled', 'destroyed')) OR
    (OLD.state = 'cancelled' AND NEW.state = 'destroyed')
  ) THEN
    RAISE EXCEPTION 'invalid runner workspace transition from % to %', OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER runner_workspaces_enforce_update
BEFORE UPDATE ON runner_workspaces
FOR EACH ROW EXECUTE FUNCTION enforce_runner_workspace_update();
--> statement-breakpoint

CREATE FUNCTION reject_runner_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'runner evidence is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER runner_commands_append_only
BEFORE UPDATE OR DELETE ON runner_commands
FOR EACH ROW EXECUTE FUNCTION reject_runner_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER runner_artifacts_append_only
BEFORE UPDATE OR DELETE ON runner_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_runner_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER runner_lifecycle_records_append_only
BEFORE UPDATE OR DELETE ON runner_lifecycle_records
FOR EACH ROW EXECUTE FUNCTION reject_runner_evidence_mutation();
--> statement-breakpoint
