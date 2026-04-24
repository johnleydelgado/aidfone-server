-- server/migrations/2026-04-12-auth-rls.sql
-- Enable Row Level Security and add policies for caregivers + their seniors.
-- Convention: caregivers.id = auth.users.id (same UUID, no separate FK column).
--
-- Apply via: Supabase SQL editor OR `supabase db push` OR MCP apply_migration.
-- Related plan: docs/plans/2026-04-12-b2c-auth-dashboard-redesign.md (Task 5)
--
-- IMPORTANT: Before running this, ensure in the Supabase Dashboard:
--   1. Auth → Providers → Email: ENABLED
--   2. Auth → Sign In / Up → "Confirm email": DISABLED (per 2026-04-12 decision)
--   3. Auth → URL Configuration → Site URL: http://localhost:3000 (dev)
--      Additional redirect URLs: http://localhost:3000/**, https://aidfone.netlify.app/**

-- =====================================================
-- CAREGIVERS
-- =====================================================
ALTER TABLE caregivers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "caregivers_select_own" ON caregivers;
CREATE POLICY "caregivers_select_own" ON caregivers
  FOR SELECT USING (id = auth.uid());

DROP POLICY IF EXISTS "caregivers_insert_own" ON caregivers;
CREATE POLICY "caregivers_insert_own" ON caregivers
  FOR INSERT WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "caregivers_update_own" ON caregivers;
CREATE POLICY "caregivers_update_own" ON caregivers
  FOR UPDATE USING (id = auth.uid());

-- =====================================================
-- SENIORS
-- =====================================================
ALTER TABLE seniors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "seniors_select_own" ON seniors;
CREATE POLICY "seniors_select_own" ON seniors
  FOR SELECT USING (caregiver_id = auth.uid());

DROP POLICY IF EXISTS "seniors_insert_own" ON seniors;
CREATE POLICY "seniors_insert_own" ON seniors
  FOR INSERT WITH CHECK (caregiver_id = auth.uid());

DROP POLICY IF EXISTS "seniors_update_own" ON seniors;
CREATE POLICY "seniors_update_own" ON seniors
  FOR UPDATE USING (caregiver_id = auth.uid());

DROP POLICY IF EXISTS "seniors_delete_own" ON seniors;
CREATE POLICY "seniors_delete_own" ON seniors
  FOR DELETE USING (caregiver_id = auth.uid());

-- =====================================================
-- RELATED TABLES (join through seniors.caregiver_id)
-- =====================================================
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assessments_own" ON assessments;
CREATE POLICY "assessments_own" ON assessments
  FOR ALL USING (
    senior_id IN (SELECT id FROM seniors WHERE caregiver_id = auth.uid())
  );

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subscriptions_own" ON subscriptions;
CREATE POLICY "subscriptions_own" ON subscriptions
  FOR ALL USING (
    senior_id IN (SELECT id FROM seniors WHERE caregiver_id = auth.uid())
  );

ALTER TABLE configurations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "configurations_own" ON configurations;
CREATE POLICY "configurations_own" ON configurations
  FOR ALL USING (
    senior_id IN (SELECT id FROM seniors WHERE caregiver_id = auth.uid())
  );

ALTER TABLE senior_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "senior_contacts_own" ON senior_contacts;
CREATE POLICY "senior_contacts_own" ON senior_contacts
  FOR ALL USING (
    senior_id IN (SELECT id FROM seniors WHERE caregiver_id = auth.uid())
  );

-- =====================================================
-- PUBLIC TABLES (no RLS change)
-- =====================================================
-- These must remain insertable by unauthenticated users (wizard analytics):
--   - wizard_sessions
--   - prescreening_submissions
--   - assessment_submissions
--   - guardian_waitlist
--   - partner_inquiries
-- Leave their existing RLS state alone.
