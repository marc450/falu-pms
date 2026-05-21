-- ============================================================
-- Migration 089g: regression-detection view for over-attribution
-- ============================================================
-- Companion to phantom_standstill_check (085). That view catches
-- the under-attribution bug (bucket shows zero production when
-- the machine was actually running); this one catches the
-- over-attribution bug fixed in 089e — bucket attributing more
-- seconds than physically fit inside its 5-min wall-clock slot.
--
-- A 5-min bucket can hold at most 300 seconds of any one PLC
-- counter, period. The sum production + idle + error can also
-- exceed 300 (e.g. idle includes error), but never by much; we
-- flag rows over 360s (20% margin) so future aggregator bugs
-- surface within minutes instead of being spotted on a chart
-- weeks later.
--
-- Run periodically (or wire to a dashboard tile) — any row
-- means the math has drifted and the chart/uptime are wrong.
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
  -- Largest single-counter attribution. Any single counter > 300 is
  -- structurally impossible for a 5-min bucket.
  GREATEST(
    production_time_seconds,
    idle_time_seconds,
    error_time_seconds
  ) AS max_counter_seconds,
  -- Combined attribution. Idle includes error inside the PLC, so the
  -- sum can legitimately go a bit over 300 (production + idle, with
  -- error double-counted into idle). 360s is a generous ceiling that
  -- still catches the 2x post-reset spike pattern from the 089e bug.
  production_time_seconds + idle_time_seconds AS production_plus_idle_seconds
FROM bucket_analytics_5m
WHERE production_time_seconds > 300
   OR idle_time_seconds       > 300
   OR error_time_seconds      > 300
   OR production_time_seconds + idle_time_seconds > 360
ORDER BY bucket_ts DESC, machine_code;

GRANT SELECT ON bucket_5m_over_attribution_check TO anon, authenticated;
