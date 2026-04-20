-- Mobile phone-login sessions.
--
-- RLS on employees (20260408_lock_down_public_tables) blocks anon SELECT,
-- so the mobile app cannot query directly. Instead, /api/login-phone
-- generates a random token that the mobile app stores and presents on
-- every subsequent request. A `mobileAuth` middleware resolves the token
-- → employee → tenant, granting access via service role.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS mobile_session_token TEXT,
  ADD COLUMN IF NOT EXISTS mobile_session_issued_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS employees_mobile_session_token_uidx
  ON employees(mobile_session_token)
  WHERE mobile_session_token IS NOT NULL;
