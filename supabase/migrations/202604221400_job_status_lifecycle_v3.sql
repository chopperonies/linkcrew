-- Crew-driven flow: expand jobs.status enum with dispatched / en_route /
-- on_site / paused / closed. 'active' stays as a synonym for "field-active"
-- and is what most existing production jobs are stamped as. The backend
-- transition API moves rows through the new states going forward.

ALTER TABLE IF EXISTS public.jobs
  DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE IF EXISTS public.jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN (
    'quoted',
    'scheduled',
    'dispatched',
    'en_route',
    'on_site',
    'active',
    'in_progress',
    'on_hold',
    'paused',
    'completed',
    'closed',
    'invoiced',
    'saved_for_later',
    'cancelled',
    'archived'
  ));
