-- ============================================================
-- Migration 043: daily_machine_summary pre-aggregation
-- ============================================================
-- Replaces the heavy get_machine_shift_summary RPC for historical
-- date ranges. One row per (calendar_date, shift_label, machine).
-- The frontend queries this table for past days and falls back to
-- the live RPC for today only.
--
-- Calendar day boundaries (00:00 to 23:59:59) keep the aggregation
-- independent of shift configuration.
-- ============================================================


-- ── A. daily_machine_summary table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS daily_machine_summary (
  id                      bigint           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary_date            date             NOT NULL,
  shift_label             text             NOT NULL,          -- 'A' or 'B'
  machine_id              uuid             NOT NULL REFERENCES machines(id),
  machine_code            text             NOT NULL,
  cell_id                 uuid             REFERENCES production_cells(id),

  -- Production totals for this (date, shift, machine)
  swabs_produced          bigint           NOT NULL DEFAULT 0,
  boxes_produced          bigint           NOT NULL DEFAULT 0,
  production_time_seconds bigint           NOT NULL DEFAULT 0,
  idle_time_seconds       bigint           NOT NULL DEFAULT 0,
  error_time_seconds      bigint           NOT NULL DEFAULT 0,
  discarded_swabs         bigint           NOT NULL DEFAULT 0,
  cotton_tears            bigint           NOT NULL DEFAULT 0,
  missing_sticks          bigint           NOT NULL DEFAULT 0,
  faulty_pickups          bigint           NOT NULL DEFAULT 0,
  other_errors            bigint           NOT NULL DEFAULT 0,
  reading_count           integer          NOT NULL DEFAULT 0,
  avg_efficiency          double precision          DEFAULT 0,
  avg_scrap_rate          double precision          DEFAULT 0,

  created_at              timestamptz      NOT NULL DEFAULT now(),
  updated_at              timestamptz      NOT NULL DEFAULT now(),

  UNIQUE (summary_date, shift_label, machine_id)
);

CREATE INDEX IF NOT EXISTS daily_machine_summary_date_idx
  ON daily_machine_summary (summary_date DESC);

CREATE INDEX IF NOT EXISTS daily_machine_summary_machine_date_idx
  ON daily_machine_summary (machine_id, summary_date DESC);


-- ── B. Row-level security ─────────────────────────────────────────────────────

ALTER TABLE daily_machine_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_machine_summary_read ON daily_machine_summary;

CREATE POLICY daily_machine_summary_read
  ON daily_machine_summary FOR SELECT TO anon, authenticated USING (true);


-- ── C. aggregate_daily_summary(p_date) ────────────────────────────────────────
-- Reads saved_shift_logs for the given calendar date and upserts
-- aggregated rows into daily_machine_summary.
-- Shift label derived from hour: 07:00-18:59 = A, else = B.
-- Idempotent via ON CONFLICT upsert.

CREATE OR REPLACE FUNCTION aggregate_daily_summary(p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_written integer := 0;
BEGIN
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
      SUM(produced_swabs)::bigint                               AS swabs_produced,
      SUM(produced_boxes)::bigint                               AS boxes_produced,
      SUM(production_time)::bigint                              AS production_time_seconds,
      SUM(idle_time)::bigint                                    AS idle_time_seconds,
      SUM(error_time)::bigint                                   AS error_time_seconds,
      SUM(discarded_swabs)::bigint                              AS discarded_swabs,
      SUM(cotton_tears)::bigint                                 AS cotton_tears,
      SUM(missing_sticks)::bigint                               AS missing_sticks,
      SUM(faulty_pickups)::bigint                               AS faulty_pickups,
      SUM(other_errors)::bigint                                 AS other_errors,
      COUNT(*)::integer                                         AS reading_count,
      ROUND((AVG(efficiency) FILTER (WHERE efficiency > 0))::numeric, 2)  AS avg_efficiency,
      ROUND(AVG(reject_rate)::numeric, 2)                               AS avg_scrap_rate
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

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_daily_summary(date)
  TO anon, authenticated;


-- ── D. pg_cron job ────────────────────────────────────────────────────────────
-- Runs at 00:05 daily, aggregates the previous calendar day.

SELECT cron.schedule(
  'aggregate-daily-summary',
  '5 0 * * *',
  $$SELECT aggregate_daily_summary(CURRENT_DATE - 1)$$
);


-- ── E. Backfill (run manually after applying this migration) ──────────────────
-- Uncomment and execute in the Supabase SQL editor to backfill all
-- historical data from saved_shift_logs.
--
-- DO $$
-- DECLARE
--   v_day date;
-- BEGIN
--   FOR v_day IN
--     SELECT DISTINCT saved_at::date
--     FROM saved_shift_logs
--     ORDER BY 1
--   LOOP
--     PERFORM aggregate_daily_summary(v_day);
--   END LOOP;
-- END;
-- $$;
