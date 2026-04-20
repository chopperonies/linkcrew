-- Phase 3.5: jobs can be scheduled for a specific day. Null = unscheduled.
-- Enables the Schedule tab's day view and the Home week strip.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scheduled_date DATE;

-- Hot path: "give me all jobs for tenant X on day Y", and "tenant X's
-- upcoming schedule for the next 7 days". Partial index skips the
-- unscheduled nulls so the index stays lean.
CREATE INDEX IF NOT EXISTS jobs_tenant_scheduled_idx
  ON jobs (tenant_id, scheduled_date)
  WHERE scheduled_date IS NOT NULL;
