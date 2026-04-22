-- In-app messaging. Owner↔crew, crew↔crew, and optional group chats.
-- Backed by Supabase Realtime — no Twilio / external SMS.

CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT,                          -- null = DM; set = group
  created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_threads_tenant_last_idx
  ON chat_threads(tenant_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_thread_members (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, employee_id)
);
CREATE INDEX IF NOT EXISTS chat_thread_members_employee_idx
  ON chat_thread_members(employee_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx
  ON chat_messages(thread_id, created_at DESC);

-- last_message_at bump so thread list ordering stays fresh.
CREATE OR REPLACE FUNCTION chat_bump_thread() RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_threads
     SET last_message_at = NEW.created_at
   WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_messages_bump_thread ON chat_messages;
CREATE TRIGGER chat_messages_bump_thread
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_bump_thread();

-- RLS — service role owns all access; authenticated clients read rows
-- that belong to threads they're a member of. Realtime uses the anon
-- key so the 'authenticated' policies cover subscriptions too.

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_threads_service ON chat_threads;
CREATE POLICY chat_threads_service ON chat_threads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chat_members_service ON chat_thread_members;
CREATE POLICY chat_members_service ON chat_thread_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chat_messages_service ON chat_messages;
CREATE POLICY chat_messages_service ON chat_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS chat_threads_member_read ON chat_threads;
CREATE POLICY chat_threads_member_read ON chat_threads
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM chat_thread_members m
     WHERE m.thread_id = chat_threads.id
       AND m.employee_id = auth.uid()
  ));

DROP POLICY IF EXISTS chat_messages_member_read ON chat_messages;
CREATE POLICY chat_messages_member_read ON chat_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM chat_thread_members m
     WHERE m.thread_id = chat_messages.thread_id
       AND m.employee_id = auth.uid()
  ));

DROP POLICY IF EXISTS chat_members_self_read ON chat_thread_members;
CREATE POLICY chat_members_self_read ON chat_thread_members
  FOR SELECT TO authenticated
  USING (employee_id = auth.uid() OR EXISTS (
    SELECT 1 FROM chat_thread_members m
     WHERE m.thread_id = chat_thread_members.thread_id
       AND m.employee_id = auth.uid()
  ));

-- Enable Realtime replication on the messages table (safe no-op if
-- already added).
DO $$
BEGIN
  PERFORM 1
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND schemaname = 'public'
     AND tablename = 'chat_messages';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages';
  END IF;
END $$;
