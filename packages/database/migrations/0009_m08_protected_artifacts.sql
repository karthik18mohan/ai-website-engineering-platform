-- Purpose: Persist tenant/project/run-scoped metadata and deletion state for
-- protected M08 artifacts stored in Vercel Private Blob.
-- Forward procedure: apply once after 0008_m08_runner_dispatch.sql. Existing
-- runner artifact references remain unchanged; new protected objects start empty.
-- Recovery guidance: stop artifact writers and garbage collectors, preserve the
-- table for audit/reconciliation, then drop its trigger/function and table. Blob
-- deletion must be reconciled separately; no destructive down migration is automated.

CREATE TABLE protected_artifacts (
  artifact_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  blob_path text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text NOT NULL,
  retention_class text NOT NULL,
  delete_after timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT protected_artifacts_tenant_id_unique
    UNIQUE (organization_id, project_id, artifact_id),
  CONSTRAINT protected_artifacts_blob_path_unique UNIQUE (blob_path),
  CONSTRAINT protected_artifacts_run_tenant_fk
    FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES runs (organization_id, project_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT protected_artifacts_path_check CHECK (
    blob_path = 'tenants/' || organization_id || '/projects/' || project_id
      || '/runs/' || run_id || '/artifacts/' || artifact_id
  ),
  CONSTRAINT protected_artifacts_sha256_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT protected_artifacts_size_check CHECK (size_bytes BETWEEN 0 AND 16777216),
  CONSTRAINT protected_artifacts_media_type_check CHECK (
    media_type IN (
      'application/json', 'application/octet-stream', 'application/pdf',
      'application/zip', 'image/png', 'text/plain'
    )
  ),
  CONSTRAINT protected_artifacts_retention_check CHECK (
    retention_class IN ('ephemeral', 'benchmark', 'standard', 'pinned')
    AND ((retention_class = 'pinned') = (delete_after IS NULL))
  ),
  CONSTRAINT protected_artifacts_created_by_check CHECK (
    created_by ~ '^(user|service):[0-9a-f-]{36}$'
  ),
  CONSTRAINT protected_artifacts_delete_state_check CHECK (
    deleted_at IS NULL OR deleted_at >= created_at
  )
);
--> statement-breakpoint

CREATE INDEX protected_artifacts_gc_idx
ON protected_artifacts (delete_after)
WHERE deleted_at IS NULL AND delete_after IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION enforce_protected_artifact_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.blob_path IS DISTINCT FROM OLD.blob_path
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
    OR NEW.delete_after IS DISTINCT FROM OLD.delete_after
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.deleted_at IS NOT NULL
    OR NEW.deleted_at IS NULL
  THEN
    RAISE EXCEPTION 'protected artifact metadata is immutable except for first deletion mark';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER protected_artifacts_enforce_update
BEFORE UPDATE ON protected_artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_protected_artifact_update();
