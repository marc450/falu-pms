-- ============================================================
-- Migration 041: hourly_analytics pre-aggregation
-- ============================================================
-- Replaces the heavy get_fleet_trend hourly path for the "Last 24 hours"
-- view with a lightweight pre-aggregated table that is populated every
-- hour by pg_cron. Reads drop from millions of rows to at most 24 rows
-- per machine, eliminating the statement timeout.
-- ============================================================

-- ── A. Add PLC timestamp column to shift_readings ────────────────────────────
-- The cron job buckets by PLC time, not DB insertion time, so that
-- readings from slightly out-of-sync machine clocks land in the correct
-- hour regardless of when they arrived in the database.

ALTER TABLE shift_readings
  ADD COLUMN IF NOT EXISTS plc_timestamp timestamptz;

CREATE INDEX IF NOT EXISTS shift_readings_plc_timestamp_idx
  ON shift_readings (plc_timestamp);


-- ── B. hourly_analytics table ────────────────────────────────────────────────
-- One row per (machine, shift_number, plc_hour).
-- Delta columns  : production WITHIN that hour only (not cumulative).
-- _end_ columns  : end-of-hour cumulative values used as anchors by the
--                  NEXT cron run to compute the following hour's deltas.

CREATE TABLE IF NOT EXISTS hourly_analytics (
  id                      bigint           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id              uuid             NOT NULL REFERENCES machines(id),
  machine_code            text             NOT NULL,
  cell_id                 uuid             REFERENCES production_cells(id),
  plc_hour                timestamptz      NOT NULL,
  shift_number            integer          NOT NULL,

  -- ── Deltas (production within this 1-hour window only) ──
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

  -- ── Internal anchors (end-of-hour cumulative, used by next cron run) ──
  _end_produced_swabs     bigint           NOT NULL DEFAULT 0,
  _end_produced_boxes     bigint           NOT NULL DEFAULT 0,
  _end_production_time_s  bigint           NOT NULL DEFAULT 0,
  _end_idle_time_s        bigint           NOT NULL DEFAULT 0,
  _end_error_time_s       bigint           NOT NULL DEFAULT 0,
  _end_discarded_swabs    bigint           NOT NULL DEFAULT 0,
  _end_cotton_tears       bigint           NOT NULL DEFAULT 0,
  _end_missing_sticks     bigint           NOT NULL DEFAULT 0,
  _end_faulty_pickups     bigint           NOT NULL DEFAULT 0,
  _end_other_errors       bigint           NOT NULL DEFAULT 0,

  created_at              timestamptz      NOT NULL DEFAULT now(),

  UNIQUE (machine_id, plc_hour, shift_number)
);

CREATE INDEX IF NOT EXISTS hourly_analytics_plc_hour_idx
  ON hourly_analytics (plc_hour DESC);

CREATE INDEX IF NOT EXISTS hourly_analytics_machine_plc_idx
  ON hourly_analytics (machine_id, plc_hour DESC);


-- ── C. cell_aggregation_log table ───────────────────────────────────────────
-- Records which (cell, plc_hour) pairs have already been aggregated.
-- Prevents double-runs if the cron fires twice or the seeding script is
-- re-run. Cleaned up together with hourly_analytics by the nightly job.
--
-- NULL cell_id (machines not assigned to any cell) uses a sentinel UUID
-- to make the UNIQUE constraint work correctly (SQL NULLs are never equal).

INSERT INTO production_cells (id, name, position)
VALUES ('00000000-0000-0000-0000-000000000000', '__NO_CELL__', -1)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS cell_aggregation_log (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cell_id   uuid        NOT NULL,   -- '00000000-...' for uncelled machines
  plc_hour  timestamptz NOT NULL,
  ran_at    timestamptz NOT NULL DEFAULT now(),
  row_count integer,
  UNIQUE (cell_id, plc_hour)
);


-- ── D. aggregate_cell_hour(p_cell_id, p_target_hour) ────────────────────────
-- Core aggregation function. Processes all machines in one cell for one
-- completed PLC hour and upserts results into hourly_analytics.

CREATE OR REPLACE FUNCTION aggregate_cell_hour(
  p_cell_id     uuid,         -- pass '00000000-...' for uncelled machines
  p_target_hour timestamptz   -- must be truncated to the hour already
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- Resolve sentinel back to NULL for machine JOIN
  v_real_cell_id  uuid        := CASE
                                   WHEN p_cell_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
                                   ELSE p_cell_id
                                 END;

  -- Time window: strict PLC hour + ±12-minute DB buffer to catch
  -- readings that arrived slightly early or late in the database.
  v_plc_start     timestamptz := p_target_hour;
  v_plc_end       timestamptz := p_target_hour + interval '1 hour';
  v_db_start      timestamptz := p_target_hour - interval '12 minutes';
  v_db_end        timestamptz := p_target_hour + interval '1 hour 12 minutes';

  -- Loop variables
  v_machine_id    uuid;
  v_machine_code  text;
  v_shift         integer;

  -- Aggregated MAX values for the current (machine, shift, hour)
  v_max_swabs     bigint;
  v_max_boxes     bigint;
  v_max_prod_t    bigint;
  v_max_idle_t    bigint;
  v_max_error_t   bigint;
  v_max_discard   bigint;
  v_max_cotton    bigint;
  v_max_sticks    bigint;
  v_max_pickups   bigint;
  v_max_other     bigint;
  v_rdg_count     integer;
  v_avg_eff       double precision;
  v_avg_scrap     double precision;

  -- Anchor values from the previous hourly_analytics row
  v_anc_swabs     bigint;
  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;
  v_anc_idle_t    bigint;
  v_anc_error_t   bigint;
  v_anc_discard   bigint;
  v_anc_cotton    bigint;
  v_anc_sticks    bigint;
  v_anc_pickups   bigint;
  v_anc_other     bigint;

  -- Computed deltas
  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_idle_t  bigint;
  v_delta_error_t bigint;
  v_delta_discard bigint;
  v_delta_cotton  bigint;
  v_delta_sticks  bigint;
  v_delta_pickups bigint;
  v_delta_other   bigint;

  v_rows_written  integer := 0;
BEGIN
  -- 1. Early-exit if this (cell, hour) was already aggregated
  IF EXISTS (
    SELECT 1 FROM cell_aggregation_log
    WHERE cell_id = p_cell_id AND plc_hour = p_target_hour
  ) THEN
    RETURN;
  END IF;

  -- 2. Loop over every (machine, shift_number) with readings in the window
  FOR v_machine_id, v_machine_code, v_shift IN
    SELECT DISTINCT sr.machine_id, COALESCE(sr.machine_code, m.machine_code), sr.shift_number
    FROM   shift_readings sr
    JOIN   machines       m  ON m.id = sr.machine_id
    WHERE
      -- Cell membership filter
      (
        (v_real_cell_id IS NULL AND m.cell_id IS NULL)
        OR m.cell_id = v_real_cell_id
      )
      -- DB buffer window (catches late-arriving inserts)
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      -- Strict PLC hour filter, with NULL fallback for legacy rows
      AND (
            (sr.plc_timestamp >= v_plc_start AND sr.plc_timestamp < v_plc_end)
            OR sr.plc_timestamp IS NULL
          )
  LOOP
    -- 3. Aggregate MAX cumulative counters and reading metadata
    SELECT
      COUNT(*)                         AS rdg_count,
      MAX(sr.produced_swabs)           AS max_swabs,
      MAX(sr.produced_boxes)           AS max_boxes,
      MAX(sr.production_time)          AS max_prod_t,
      MAX(sr.idle_time)                AS max_idle_t,
      MAX(sr.error_time)               AS max_error_t,
      MAX(sr.discarded_swabs)          AS max_discard,
      MAX(sr.cotton_tears)             AS max_cotton,
      MAX(sr.missing_sticks)           AS max_sticks,
      MAX(sr.faulty_pickups)           AS max_pickups,
      MAX(sr.other_errors)             AS max_other,
      AVG(NULLIF(sr.efficiency, 0))    AS avg_eff,
      AVG(sr.reject_rate)              AS avg_scrap
    INTO
      v_rdg_count, v_max_swabs, v_max_boxes, v_max_prod_t, v_max_idle_t,
      v_max_error_t, v_max_discard, v_max_cotton, v_max_sticks, v_max_pickups,
      v_max_other, v_avg_eff, v_avg_scrap
    FROM shift_readings sr
    WHERE sr.machine_id   = v_machine_id
      AND sr.shift_number = v_shift
      AND sr.recorded_at  >= v_db_start
      AND sr.recorded_at  <  v_db_end
      AND (
            (sr.plc_timestamp >= v_plc_start AND sr.plc_timestamp < v_plc_end)
            OR sr.plc_timestamp IS NULL
          );

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    -- 4. Look up anchor: the most recent hourly_analytics row for this
    --    (machine, shift_number) that ended BEFORE the current target hour.
    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      _end_production_time_s,
      _end_idle_time_s,
      _end_error_time_s,
      _end_discarded_swabs,
      _end_cotton_tears,
      _end_missing_sticks,
      _end_faulty_pickups,
      _end_other_errors
    INTO
      v_anc_swabs,  v_anc_boxes,   v_anc_prod_t,  v_anc_idle_t,  v_anc_error_t,
      v_anc_discard, v_anc_cotton, v_anc_sticks,  v_anc_pickups, v_anc_other
    FROM hourly_analytics
    WHERE machine_id   = v_machine_id
      AND shift_number = v_shift
      AND plc_hour     < v_plc_start
    ORDER BY plc_hour DESC
    LIMIT 1;

    -- 5. If no anchor: first hour of this shift, treat start values as 0
    v_anc_swabs   := COALESCE(v_anc_swabs,   0);
    v_anc_boxes   := COALESCE(v_anc_boxes,   0);
    v_anc_prod_t  := COALESCE(v_anc_prod_t,  0);
    v_anc_idle_t  := COALESCE(v_anc_idle_t,  0);
    v_anc_error_t := COALESCE(v_anc_error_t, 0);
    v_anc_discard := COALESCE(v_anc_discard, 0);
    v_anc_cotton  := COALESCE(v_anc_cotton,  0);
    v_anc_sticks  := COALESCE(v_anc_sticks,  0);
    v_anc_pickups := COALESCE(v_anc_pickups, 0);
    v_anc_other   := COALESCE(v_anc_other,   0);

    -- 6. Compute deltas; GREATEST(0,...) guards against restarts or
    --    out-of-order delivery producing spurious negative values
    v_delta_swabs   := GREATEST(0, COALESCE(v_max_swabs,   0) - v_anc_swabs);
    v_delta_boxes   := GREATEST(0, COALESCE(v_max_boxes,   0) - v_anc_boxes);
    v_delta_prod_t  := GREATEST(0, COALESCE(v_max_prod_t,  0) - v_anc_prod_t);
    v_delta_idle_t  := GREATEST(0, COALESCE(v_max_idle_t,  0) - v_anc_idle_t);
    v_delta_error_t := GREATEST(0, COALESCE(v_max_error_t, 0) - v_anc_error_t);
    v_delta_discard := GREATEST(0, COALESCE(v_max_discard, 0) - v_anc_discard);
    v_delta_cotton  := GREATEST(0, COALESCE(v_max_cotton,  0) - v_anc_cotton);
    v_delta_sticks  := GREATEST(0, COALESCE(v_max_sticks,  0) - v_anc_sticks);
    v_delta_pickups := GREATEST(0, COALESCE(v_max_pickups, 0) - v_anc_pickups);
    v_delta_other   := GREATEST(0, COALESCE(v_max_other,   0) - v_anc_other);

    -- 7. Upsert (safe to re-run: ON CONFLICT updates all columns)
    INSERT INTO hourly_analytics (
      machine_id,              machine_code,          cell_id,
      plc_hour,                shift_number,
      swabs_produced,          boxes_produced,
      production_time_seconds, idle_time_seconds,     error_time_seconds,
      discarded_swabs,         cotton_tears,          missing_sticks,
      faulty_pickups,          other_errors,
      reading_count,           avg_efficiency,        avg_scrap_rate,
      _end_produced_swabs,     _end_produced_boxes,
      _end_production_time_s,  _end_idle_time_s,      _end_error_time_s,
      _end_discarded_swabs,    _end_cotton_tears,     _end_missing_sticks,
      _end_faulty_pickups,     _end_other_errors
    )
    VALUES (
      v_machine_id,             v_machine_code,        v_real_cell_id,
      v_plc_start,              v_shift,
      v_delta_swabs,            v_delta_boxes,
      v_delta_prod_t,           v_delta_idle_t,        v_delta_error_t,
      v_delta_discard,          v_delta_cotton,        v_delta_sticks,
      v_delta_pickups,          v_delta_other,
      v_rdg_count,
      COALESCE(v_avg_eff,   0), COALESCE(v_avg_scrap, 0),
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_idle_t,  0), COALESCE(v_max_error_t, 0),
      COALESCE(v_max_discard, 0), COALESCE(v_max_cotton,  0), COALESCE(v_max_sticks,  0),
      COALESCE(v_max_pickups, 0), COALESCE(v_max_other,   0)
    )
    ON CONFLICT (machine_id, plc_hour, shift_number) DO UPDATE SET
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
      _end_produced_swabs     = EXCLUDED._end_produced_swabs,
      _end_produced_boxes     = EXCLUDED._end_produced_boxes,
      _end_production_time_s  = EXCLUDED._end_production_time_s,
      _end_idle_time_s        = EXCLUDED._end_idle_time_s,
      _end_error_time_s       = EXCLUDED._end_error_time_s,
      _end_discarded_swabs    = EXCLUDED._end_discarded_swabs,
      _end_cotton_tears       = EXCLUDED._end_cotton_tears,
      _end_missing_sticks     = EXCLUDED._end_missing_sticks,
      _end_faulty_pickups     = EXCLUDED._end_faulty_pickups,
      _end_other_errors       = EXCLUDED._end_other_errors;

    v_rows_written := v_rows_written + 1;
  END LOOP;

  -- 8. Log completion (idempotent via ON CONFLICT)
  INSERT INTO cell_aggregation_log (cell_id, plc_hour, row_count)
  VALUES (p_cell_id, p_target_hour, v_rows_written)
  ON CONFLICT (cell_id, plc_hour) DO UPDATE SET
    ran_at    = now(),
    row_count = EXCLUDED.row_count;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_cell_hour(uuid, timestamptz)
  TO anon, authenticated;


-- ── E. aggregate_all_cells_for_hour(p_target_hour) ──────────────────────────
-- Wrapper called by pg_cron. Iterates all production cells plus a final
-- pass for machines that are not assigned to any cell.

CREATE OR REPLACE FUNCTION aggregate_all_cells_for_hour(p_target_hour timestamptz)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_cell_id uuid;
BEGIN
  -- Named cells (excluding the sentinel)
  FOR v_cell_id IN
    SELECT id FROM production_cells
    WHERE id != '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY position
  LOOP
    PERFORM aggregate_cell_hour(v_cell_id, p_target_hour);
  END LOOP;

  -- Machines with no cell assigned (sentinel UUID)
  PERFORM aggregate_cell_hour(
    '00000000-0000-0000-0000-000000000000'::uuid,
    p_target_hour
  );
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_all_cells_for_hour(timestamptz)
  TO anon, authenticated;


-- ── F. pg_cron jobs ──────────────────────────────────────────────────────────

-- Aggregate the just-completed PLC hour at :05 every hour.
-- date_trunc('hour', now()) - 1h  =  09:00 when cron fires at 10:05.
SELECT cron.schedule(
  'aggregate-hourly-analytics',
  '5 * * * *',
  $$SELECT aggregate_all_cells_for_hour(
      date_trunc('hour', now()) - interval '1 hour'
    )$$
);

-- Nightly cleanup: delete rows older than the 48-hour rolling window.
SELECT cron.schedule(
  'cleanup-hourly-analytics',
  '30 3 * * *',
  $$
  DELETE FROM hourly_analytics    WHERE plc_hour < now() - interval '48 hours';
  DELETE FROM cell_aggregation_log WHERE plc_hour < now() - interval '48 hours';
  $$
);


-- ── G. Row-level security ────────────────────────────────────────────────────

ALTER TABLE hourly_analytics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_aggregation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hourly_analytics_read     ON hourly_analytics;
DROP POLICY IF EXISTS cell_aggregation_log_read ON cell_aggregation_log;

CREATE POLICY hourly_analytics_read
  ON hourly_analytics     FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY cell_aggregation_log_read
  ON cell_aggregation_log FOR SELECT TO anon, authenticated USING (true);
