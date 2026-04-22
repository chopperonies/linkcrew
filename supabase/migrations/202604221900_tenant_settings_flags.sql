-- Tenant-wide toggles for the crew-driven flow + live map.
--   location_sharing_enabled: track crew GPS while clocked in (for the
--     Live Map on the web dashboard). Tenant-wide only.
--   auto_close_enabled: if true, `completed` jobs auto-advance to `closed`
--     after 24 hours with no owner intervention. Default off — approval
--     is explicit.
--   geofence_radius_m: distance (in meters) from a job's coords that
--     counts as "on-site" for auto-advance. Default 100m.

ALTER TABLE IF EXISTS public.tenants
  ADD COLUMN IF NOT EXISTS location_sharing_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE IF EXISTS public.tenants
  ADD COLUMN IF NOT EXISTS auto_close_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS public.tenants
  ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER NOT NULL DEFAULT 100;

-- Heartbeat columns on time_entries for the Live Map.
-- (time_entries schema lives in 202604212100_time_entries.sql)
ALTER TABLE IF EXISTS public.time_entries
  ADD COLUMN IF NOT EXISTS last_ping_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_ping_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ;

-- Geocoded job location for the map layer + geofence auto-advance.
ALTER TABLE IF EXISTS public.jobs
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
