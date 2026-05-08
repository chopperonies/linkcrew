-- Job-first messaging: link chat threads to jobs so we get job-scoped
-- threads (auto-includes the assigned crew, enriched with job context in
-- the API response). Nullable because direct messages still need to exist
-- without a job. Find-or-create at the API layer treats (tenant_id, job_id)
-- as identity for job threads.
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS job_id UUID NULL REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS chat_threads_job_id_idx ON chat_threads(job_id);
