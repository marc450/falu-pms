-- ============================================================
-- Migration 089i: relax bucket_5m_over_attribution_check thresholds
-- ============================================================
-- 089g flagged anything > 300s for a single counter or > 360s
-- for production+idle. After running 089e + 089f on a healthy
-- system, those bounds turned out to be too tight — they
-- triggered on legitimate noise:
--
--   • Cron path uses a ±1 min DB buffer (catches late writes),
--     so a 5-min bucket's query window is 7 min wide. At 100%
--     production that's up to 420s of growth attributed to the
--     bucket. Real and expected.
--   • Strict backfill path (date_bin, no buffer) can still
--     land 1-5s over 300 because of PLC clock drift and
--     sub-second tick rounding.
--
-- New thresholds catch a true 2x trap-2 regression (delta of
-- ~600s, where MAX is used in the reset branch instead of
-- MAX − MIN) but ignore the noise floor:
--
--   • single counter > 420s (clears the ±buffer envelope)
--   • production + idle > 540s (1.8x bucket length, headroom
--     above the buffer's 420s × 2 = 840s theoretical max, but
--     still well under the 600s+ trap-2 signature)
--
-- The view still surfaces drift early — clusters at 05:00 /
-- 17:00 UTC (= 07:00 / 19:00 local) on either column remain
-- the canonical shift-change regression signature.
-- ============================================================

CREATE OR REPLACE VIEW bucket_5m_over_attribution_check AS
SELECT
  machine_code,
  bucket_ts,
  shift_crew,
  production_time_seconds,
  idle_time_seconds,
  error_time_seconds,
  swabs_produced,
  GREATEST(
    production_time_seconds,
    idle_time_seconds,
    error_time_seconds
  )                                                AS max_counter_seconds,
  production_time_seconds + idle_time_seconds      AS production_plus_idle_seconds
FROM bucket_analytics_5m
WHERE production_time_seconds                       > 420
   OR idle_time_seconds                             > 420
   OR error_time_seconds                            > 420
   OR production_time_seconds + idle_time_seconds   > 540
ORDER BY bucket_ts DESC, machine_code;

GRANT SELECT ON bucket_5m_over_attribution_check TO anon, authenticated;
