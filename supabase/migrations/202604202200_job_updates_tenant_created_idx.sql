-- Scale prep: recent-activity feed on the owner home pulls the last 10
-- job_updates for a tenant, ordered by created_at DESC. At hundreds of
-- updates per tenant per week this needs an index.

CREATE INDEX IF NOT EXISTS job_updates_tenant_created_idx
  ON job_updates (tenant_id, created_at DESC);
