-- server/migrations/2026-05-14-email-reminders.sql
-- Durable scheduler for transactional emails.
-- Each row is one pending send. The worker (server/workers/emailReminderWorker.ts)
-- polls for due rows every 5 minutes, sends, and marks sent_at.
--
-- Apply via: Supabase SQL editor OR MCP apply_migration.
-- Related plan: docs/plans/2026-05-14-email-infra-prelaunch.md (Task 1.1)

CREATE TABLE IF NOT EXISTS email_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity / dedupe
  reminder_type TEXT NOT NULL,                  -- e.g. 'trial_reminder_day_25', 'trial_reminder_day_29'
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  -- Scheduling
  send_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  -- Retry tracking
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One reminder per (subscription, type) — prevents duplicates if webhook replays
  UNIQUE (stripe_subscription_id, reminder_type)
);

-- Worker queries by (sent_at IS NULL AND send_at <= NOW()) — index makes that fast
CREATE INDEX IF NOT EXISTS idx_email_reminders_pending
  ON email_reminders (send_at)
  WHERE sent_at IS NULL;

-- Service-role only — no RLS needed since this is server-internal.
-- Explicitly deny anon to be safe.
ALTER TABLE email_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_reminders_no_public_access" ON email_reminders;
CREATE POLICY "email_reminders_no_public_access" ON email_reminders
  FOR ALL USING (false);
