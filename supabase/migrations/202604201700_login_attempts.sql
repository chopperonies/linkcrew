-- Track owner login attempts for rate-limiting + audit.
CREATE TABLE IF NOT EXISTS login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_time_idx
  ON login_attempts (email, created_at DESC);

CREATE INDEX IF NOT EXISTS login_attempts_created_at_idx
  ON login_attempts (created_at DESC);

-- RLS: service role only. Service role bypasses RLS so no policy rows needed.
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
