-- Scale prep: tenant_id + hot-path compound indexes for mobile API
-- All additive, IF NOT EXISTS, safe to run multiple times.

CREATE INDEX IF NOT EXISTS jobs_tenant_id_idx            ON jobs (tenant_id);
CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx        ON jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS jobs_tenant_updated_at_idx    ON jobs (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS jobs_tenant_invoice_idx       ON jobs (tenant_id) WHERE invoice_amount IS NOT NULL AND invoice_amount > 0;

CREATE INDEX IF NOT EXISTS clients_tenant_id_idx         ON clients (tenant_id);
CREATE INDEX IF NOT EXISTS supply_requests_tenant_id_idx ON supply_requests (tenant_id);
CREATE INDEX IF NOT EXISTS job_updates_tenant_created_idx ON job_updates (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_assignments_tenant_id_idx ON job_assignments (tenant_id);
CREATE INDEX IF NOT EXISTS employees_tenant_id_idx       ON employees (tenant_id);
