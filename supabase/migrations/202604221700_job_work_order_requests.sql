-- Crew requests work-order details when a scheduled job is missing plans,
-- attachments, or a Service PRO workflow. Fan-out push notifies management;
-- request auto-resolves when an attachment is added or a workflow assigned.

CREATE TABLE IF NOT EXISTS job_work_order_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  resolution TEXT CHECK (resolution IN (
    'attachment_added', 'workflow_assigned', 'dismissed'
  )),
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS job_wo_requests_job_idx
  ON job_work_order_requests(job_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS job_wo_requests_tenant_open_idx
  ON job_work_order_requests(tenant_id, requested_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE job_work_order_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_wo_requests_service ON job_work_order_requests;
CREATE POLICY job_wo_requests_service ON job_work_order_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
