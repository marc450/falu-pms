-- ============================================================
-- Migration 062: Compute avg_uptime from production_time_seconds
-- ============================================================
-- Previously avg_uptime was derived from the PLC's efficiency
-- signal (a cumulative running average).  This was inconsistent
-- with delta-based metrics like swabs_produced, because the PLC
-- efficiency does not reset at crew transitions while the
-- cumulative counters do.
--
-- New formula (consistent with hourly chart logic):
--   avg_uptime = SUM(production_time_seconds)
--                / (machine_count * 86400)
--                * 100
--
-- production_time_seconds in daily_machine_summary is already
-- a proper delta, so it stays consistent with BU output.
-- ============================================================


-- ── A. Update aggregate_daily_summary ────────────────────────────────────────

CREATE OR REPLACE FUNCTION aggregate_daily_summary(p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_written integer := 0;
BEGIN
  -- Step 1: upsert per-machine rows (unchanged)
  WITH ssl_data AS (
    SELECT
      p_date                        AS summary_date,
      CASE
        WHEN EXTRACT(HOUR FROM sl.saved_at) >= 7
         AND EXTRACT(HOUR FROM sl.saved_at) < 19
        THEN 'A' ELSE 'B'
      END                           AS shift_label,
      sl.machine_id,
      COALESCE(sl.machine_code, m.machine_code) AS machine_code,
      m.cell_id,
      sl.production_time,
      sl.idle_time,
      COALESCE(sl.error_time, 0)    AS error_time,
      sl.produced_swabs,
      sl.produced_boxes,
      sl.discarded_swabs,
      sl.cotton_tears,
      sl.missing_sticks,
      sl.faulty_pickups,
      sl.other_errors,
      sl.efficiency,
      sl.reject_rate
    FROM saved_shift_logs sl
    JOIN machines m ON m.id = sl.machine_id
    WHERE sl.saved_at >= p_date::timestamptz
      AND sl.saved_at <  (p_date + 1)::timestamptz
  ),
  combined AS (
    SELECT
      summary_date,
      shift_label,
      machine_id,
      machine_code,
      cell_id,
      SUM(produced_swabs)::bigint                                           AS swabs_produced,
      SUM(produced_boxes)::bigint                                           AS boxes_produced,
      SUM(production_time)::bigint                                          AS production_time_seconds,
      SUM(idle_time)::bigint                                                AS idle_time_seconds,
      SUM(error_time)::bigint                                               AS error_time_seconds,
      SUM(discarded_swabs)::bigint                                          AS discarded_swabs,
      SUM(cotton_tears)::bigint                                             AS cotton_tears,
      SUM(missing_sticks)::bigint                                           AS missing_sticks,
      SUM(faulty_pickups)::bigint                                           AS faulty_pickups,
      SUM(other_errors)::bigint                                             AS other_errors,
      COUNT(*)::integer                                                     AS reading_count,
      ROUND((AVG(efficiency) FILTER (WHERE efficiency > 0))::numeric, 2)   AS avg_efficiency,
      ROUND(AVG(reject_rate)::numeric, 2)                                  AS avg_scrap_rate
    FROM ssl_data
    GROUP BY summary_date, shift_label, machine_id, machine_code, cell_id
  ),
  upserted AS (
    INSERT INTO daily_machine_summary (
      summary_date, shift_label, machine_id, machine_code, cell_id,
      swabs_produced, boxes_produced,
      production_time_seconds, idle_time_seconds, error_time_seconds,
      discarded_swabs, cotton_tears, missing_sticks, faulty_pickups, other_errors,
      reading_count, avg_efficiency, avg_scrap_rate,
      updated_at
    )
    SELECT
      summary_date, shift_label, machine_id, machine_code, cell_id,
      COALESCE(swabs_produced, 0), COALESCE(boxes_produced, 0),
      COALESCE(production_time_seconds, 0), COALESCE(idle_time_seconds, 0), COALESCE(error_time_seconds, 0),
      COALESCE(discarded_swabs, 0), COALESCE(cotton_tears, 0), COALESCE(missing_sticks, 0),
      COALESCE(faulty_pickups, 0), COALESCE(other_errors, 0),
      reading_count,
      COALESCE(avg_efficiency, 0), COALESCE(avg_scrap_rate, 0),
      now()
    FROM combined
    ON CONFLICT (summary_date, shift_label, machine_id) DO UPDATE SET
      machine_code            = EXCLUDED.machine_code,
      cell_id                 = EXCLUDED.cell_id,
      swabs_produced          = EXCLUDED.swabs_produced,
      boxes_produced          = EXCLUDED.boxes_produced,
      production_time_seconds = EXCLUDED.production_time_seconds,
      idle_time_seconds       = EXCLUDED.idle_time_seconds,
      error_time_seconds      = EXCLUDED.error_time_seconds,
      discarded_swabs         = EXCLUDED.discarded_swabs,
      cotton_tears            = EXCLUDED.cotton_tears,
      missing_sticks          = EXCLUDED.missing_sticks,
      faulty_pickups          = EXCLUDED.faulty_pickups,
      other_errors            = EXCLUDED.other_errors,
      reading_count           = EXCLUDED.reading_count,
      avg_efficiency          = EXCLUDED.avg_efficiency,
      avg_scrap_rate          = EXCLUDED.avg_scrap_rate,
      updated_at              = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows_written FROM upserted;

  -- Step 2: upsert fleet-level totals.
  --   avg_uptime: total production_time / (machines * 24h) — consistent with
  --              hourly chart which uses production_time / 3600.
  --   scrap:     total_discarded_swabs stored; frontend computes ratio.
  INSERT INTO daily_fleet_summary (
    summary_date, total_swabs, total_boxes,
    machine_count, shift_count, reading_count,
    avg_uptime, avg_scrap,
    total_discarded_swabs,
    updated_at
  )
  SELECT
    d.summary_date,
    SUM(d.swabs_produced)::bigint                                           AS total_swabs,
    SUM(d.boxes_produced)::bigint                                           AS total_boxes,
    COUNT(DISTINCT d.machine_id)::integer                                   AS machine_count,
    COUNT(DISTINCT d.shift_label)::integer                                  AS shift_count,
    SUM(d.reading_count)::bigint                                            AS reading_count,
    -- Uptime = total production seconds / (machines * 24h in seconds) * 100
    ROUND(
      (SUM(d.production_time_seconds)::double precision
       / NULLIF(COUNT(DISTINCT d.machine_id) * 86400.0, 0)
       * 100
      )::numeric, 1
    )::double precision                                                     AS avg_uptime,
    -- avg_scrap kept for backward compat; frontend uses discarded/total ratio
    ROUND(
      (SUM(d.avg_scrap_rate * d.reading_count)
       / NULLIF(SUM(d.reading_count), 0)
      )::numeric, 1
    )::double precision                                                     AS avg_scrap,
    SUM(d.discarded_swabs)::bigint                                          AS total_discarded_swabs,
    now()
  FROM daily_machine_summary d
  WHERE d.summary_date = p_date
  GROUP BY d.summary_date
  ON CONFLICT (summary_date) DO UPDATE SET
    total_swabs           = EXCLUDED.total_swabs,
    total_boxes           = EXCLUDED.total_boxes,
    machine_count         = EXCLUDED.machine_count,
    shift_count           = EXCLUDED.shift_count,
    reading_count         = EXCLUDED.reading_count,
    avg_uptime            = EXCLUDED.avg_uptime,
    avg_scrap             = EXCLUDED.avg_scrap,
    total_discarded_swabs = EXCLUDED.total_discarded_swabs,
    updated_at            = now();

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_daily_summary(date)
  TO anon, authenticated;


-- ── B. Backfill existing daily_fleet_summary rows ────────────────────────────
-- Recompute avg_uptime from production_time_seconds for all historical days.

UPDATE daily_fleet_summary dfs
SET
  avg_uptime = sub.new_uptime,
  updated_at = now()
FROM (
  SELECT
    summary_date,
    ROUND(
      (SUM(production_time_seconds)::double precision
       / NULLIF(COUNT(DISTINCT machine_id) * 86400.0, 0)
       * 100
      )::numeric, 1
    )::double precision AS new_uptime
  FROM daily_machine_summary
  GROUP BY summary_date
) sub
WHERE dfs.summary_date = sub.summary_date;
