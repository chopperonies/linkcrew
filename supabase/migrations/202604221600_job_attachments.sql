-- Plans / schematics / work-order documents attached to a job.
-- Owner/manager/supervisor uploads; crew views and (if required) acks.

CREATE TABLE IF NOT EXISTS job_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,          -- path inside `job-attachments` bucket
  mime_type TEXT,
  size_bytes BIGINT,
  label TEXT,                          -- optional human label (e.g. "Site survey")
  require_acknowledgment BOOLEAN NOT NULL DEFAULT false,
  uploaded_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS job_attachments_job_idx
  ON job_attachments(job_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS job_attachments_tenant_idx
  ON job_attachments(tenant_id);

-- Per-attachment, per-employee ack row.
-- viewed_at set on first open/download; acknowledged_at set when the crew
-- member flips the "I have read the plans / I understand the work order"
-- switch (only required when require_acknowledgment = true on the parent).
CREATE TABLE IF NOT EXISTS job_attachment_acks (
  attachment_id UUID NOT NULL REFERENCES job_attachments(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  PRIMARY KEY (attachment_id, employee_id)
);
CREATE INDEX IF NOT EXISTS job_attachment_acks_employee_idx
  ON job_attachment_acks(employee_id);

ALTER TABLE job_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attachment_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_attachments_service ON job_attachments;
CREATE POLICY job_attachments_service ON job_attachments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS job_attachment_acks_service ON job_attachment_acks;
CREATE POLICY job_attachment_acks_service ON job_attachment_acks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Storage bucket — files go in `job-attachments/{tenant_id}/{job_id}/{filename}`.
-- idempotent insert; bucket policies enforced by service role in app layer.
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-attachments', 'job-attachments', false)
ON CONFLICT (id) DO NOTHING;
