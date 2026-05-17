-- ============================================================
-- Migration 086: clear UNRESTRICTED badge on phantom views
-- ============================================================
-- The two views created in 085 default to security_definer
-- mode (Postgres default): underlying-table reads happen as
-- the view OWNER, bypassing RLS on bucket_analytics_5m. The
-- Supabase Table Editor flags this with an UNRESTRICTED badge
-- because a view granted to anon could in principle expose
-- rows the table's RLS would hide.
--
-- Not an actual leak today — bucket_analytics_5m's policy is
-- USING (true), so anon can read all rows directly. But if
-- we ever tighten that policy, security_definer views would
-- silently keep returning everything.
--
-- Flip both to security_invoker so the underlying-table reads
-- happen as the QUERIER and respect whatever RLS lives on
-- bucket_analytics_5m, now and in the future.
-- ============================================================

ALTER VIEW phantom_standstill_check          SET (security_invoker = true);
ALTER VIEW phantom_standstill_hourly_pattern SET (security_invoker = true);
