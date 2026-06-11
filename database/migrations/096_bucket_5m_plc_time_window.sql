-- ============================================================
-- Migration 096: bucket by PLC publish time, not insert time
-- ============================================================
-- ROOT CAUSE of Avg Uptime >100% (intermittent, post-094a):
-- the 5-min bucket windowed readings by recorded_at (DB insert
-- time), but the production counter advances on the PLC publish
-- clock (shift_readings.plc_timestamp = payload Timestamp). The
-- bridge ingests with a large, VARIABLE lag (publish→insert drifted
-- 3–19 min and grew/drained). When the lag shrank between two
-- adjacent buckets, one bucket absorbed >5 min of PLC-time
-- production: MAX − anchor exceeded the 300s window, so uptime
-- exceeded 100%, while its neighbour starved. That is the
-- alternating spike pattern.
--
-- prod_s advances exactly 1:1 with plc_timestamp, so windowing by
-- the PLC clock makes every 5-min bucket hold ≤300s by construction,
-- regardless of ingest lag. Migration 066 already bucketed by
-- plc_timestamp; the 083 5-min rewrite regressed it to recorded_at.
-- This restores PLC-time windowing in the current (094a) function.
--
-- Because readings arrive late, the cron must RE-aggregate a window
-- of recent PLC buckets each run (upsert is idempotent), so late
-- arrivals land in the right bucket. aggregate_recent_buckets()
-- does this in ascending order to keep the _end→anchor chain valid.
--
-- KPI calculation change — applied with Marc's explicit approval.
-- ============================================================


-- ── A. aggregate_cell_bucket: window by PLC time ────────────────────────────
-- Identical to 094a except the read window uses the PLC publish clock
--   clk := CASE WHEN plc_timestamp >= 2020-01-01 THEN plc_timestamp
--               ELSE recorded_at END
-- (falls back to insert time for null/sentinel PLC clocks, matching the
-- bridge's isValidPlcTimestamp >= 2020 rule). _end_* stays = MAX.

CREATE OR REPLACE FUNCTION aggregate_cell_bucket(
  p_cell_id      uuid,
  p_bucket_start timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_real_cell_id  uuid        := CASE
                                   WHEN p_cell_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
                                   ELSE p_cell_id
                                 END;

  v_bucket_end    timestamptz := p_bucket_start + interval '5 minutes';
  v_db_start      timestamptz := p_bucket_start;
  v_db_end        timestamptz := v_bucket_end;

  v_machine_id    uuid;
  v_machine_code  text;
  v_label_crew    text;

  v_max_swabs     bigint;  v_min_swabs     bigint;
  v_max_boxes     bigint;  v_min_boxes     bigint;
  v_max_prod_t    bigint;  v_min_prod_t    bigint;
  v_max_idle_t    bigint;  v_min_idle_t    bigint;
  v_max_error_t   bigint;  v_min_error_t   bigint;
  v_max_discard   bigint;  v_min_discard   bigint;

  v_rdg_count     integer;

  v_anc_swabs     bigint;  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;  v_anc_idle_t    bigint;
  v_anc_error_t   bigint;  v_anc_discard   bigint;

  v_delta_swabs   bigint;  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;  v_delta_idle_t  bigint;
  v_delta_error_t bigint;  v_delta_discard bigint;
BEGIN
  FOR v_machine_id, v_machine_code IN
    SELECT DISTINCT
      sr.machine_id,
      COALESCE(sr.machine_code, m.machine_code)
    FROM   shift_readings sr
    JOIN   machines       m  ON m.id = sr.machine_id
    WHERE
      (
        (v_real_cell_id IS NULL AND m.cell_id IS NULL)
        OR m.cell_id = v_real_cell_id
      )
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) >= v_db_start
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) <  v_db_end
      AND sr.shift_crew  IS NOT NULL
  LOOP
    SELECT
      COUNT(*),
      MAX(sr.produced_swabs),           MIN(sr.produced_swabs),
      MAX(sr.produced_boxes),           MIN(sr.produced_boxes),
      MAX(sr.production_time_seconds),  MIN(sr.production_time_seconds),
      MAX(sr.idle_time_seconds),        MIN(sr.idle_time_seconds),
      MAX(sr.error_time_seconds),       MIN(sr.error_time_seconds),
      MAX(sr.discarded_swabs),          MIN(sr.discarded_swabs)
    INTO
      v_rdg_count,
      v_max_swabs,   v_min_swabs,
      v_max_boxes,   v_min_boxes,
      v_max_prod_t,  v_min_prod_t,
      v_max_idle_t,  v_min_idle_t,
      v_max_error_t, v_min_error_t,
      v_max_discard, v_min_discard
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) >= v_db_start
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) <  v_db_end
      AND sr.shift_crew  IS NOT NULL;

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    SELECT sr.shift_crew
      INTO v_label_crew
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) >= v_db_start
      AND (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) <  v_db_end
      AND sr.shift_crew  IS NOT NULL
    ORDER BY (CASE WHEN sr.plc_timestamp >= TIMESTAMPTZ '2020-01-01' THEN sr.plc_timestamp ELSE sr.recorded_at END) DESC
    LIMIT 1;

    SELECT
      _end_produced_swabs,    _end_produced_boxes,
      _end_production_time_s, _end_idle_time_s,
      _end_error_time_s,      _end_discarded_swabs
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t,
      v_anc_idle_t, v_anc_error_t, v_anc_discard
    FROM bucket_analytics_5m
    WHERE machine_id = v_machine_id
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    IF NOT FOUND THEN
      v_anc_swabs   := COALESCE(v_max_swabs,   0);
      v_anc_boxes   := COALESCE(v_max_boxes,   0);
      v_anc_prod_t  := COALESCE(v_max_prod_t,  0);
      v_anc_idle_t  := COALESCE(v_max_idle_t,  0);
      v_anc_error_t := COALESCE(v_max_error_t, 0);
      v_anc_discard := COALESCE(v_max_discard, 0);
    END IF;

    -- Reset branch (MAX < anchor): bucket is entirely past a shift reset;
    -- delta = MAX − MIN. Normal branch: delta = MAX − anchor.
    v_delta_swabs   := CASE WHEN COALESCE(v_max_swabs,   0) < v_anc_swabs   THEN COALESCE(v_max_swabs,   0) - COALESCE(v_min_swabs,   0) ELSE COALESCE(v_max_swabs,   0) - v_anc_swabs   END;
    v_delta_boxes   := CASE WHEN COALESCE(v_max_boxes,   0) < v_anc_boxes   THEN COALESCE(v_max_boxes,   0) - COALESCE(v_min_boxes,   0) ELSE COALESCE(v_max_boxes,   0) - v_anc_boxes   END;
    v_delta_prod_t  := CASE WHEN COALESCE(v_max_prod_t,  0) < v_anc_prod_t  THEN COALESCE(v_max_prod_t,  0) - COALESCE(v_min_prod_t,  0) ELSE COALESCE(v_max_prod_t,  0) - v_anc_prod_t  END;
    v_delta_idle_t  := CASE WHEN COALESCE(v_max_idle_t,  0) < v_anc_idle_t  THEN COALESCE(v_max_idle_t,  0) - COALESCE(v_min_idle_t,  0) ELSE COALESCE(v_max_idle_t,  0) - v_anc_idle_t  END;
    v_delta_error_t := CASE WHEN COALESCE(v_max_error_t, 0) < v_anc_error_t THEN COALESCE(v_max_error_t, 0) - COALESCE(v_min_error_t, 0) ELSE COALESCE(v_max_error_t, 0) - v_anc_error_t END;
    v_delta_discard := CASE WHEN COALESCE(v_max_discard, 0) < v_anc_discard THEN COALESCE(v_max_discard, 0) - COALESCE(v_min_discard, 0) ELSE COALESCE(v_max_discard, 0) - v_anc_discard END;

    INSERT INTO bucket_analytics_5m (
      machine_id, machine_code, cell_id, bucket_ts, shift_crew,
      swabs_produced, boxes_produced,
      production_time_seconds, idle_time_seconds, error_time_seconds,
      discarded_swabs, reading_count,
      _end_produced_swabs, _end_produced_boxes,
      _end_production_time_s, _end_idle_time_s, _end_error_time_s,
      _end_discarded_swabs
    )
    VALUES (
      v_machine_id, v_machine_code, v_real_cell_id, p_bucket_start, v_label_crew,
      v_delta_swabs, v_delta_boxes,
      v_delta_prod_t, v_delta_idle_t, v_delta_error_t,
      v_delta_discard, v_rdg_count,
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_idle_t,  0), COALESCE(v_max_error_t, 0),
      COALESCE(v_max_discard, 0)
    )
    ON CONFLICT (machine_id, bucket_ts) DO UPDATE SET
      shift_crew              = EXCLUDED.shift_crew,
      swabs_produced          = EXCLUDED.swabs_produced,
      boxes_produced          = EXCLUDED.boxes_produced,
      production_time_seconds = EXCLUDED.production_time_seconds,
      idle_time_seconds       = EXCLUDED.idle_time_seconds,
      error_time_seconds      = EXCLUDED.error_time_seconds,
      discarded_swabs         = EXCLUDED.discarded_swabs,
      reading_count           = EXCLUDED.reading_count,
      _end_produced_swabs     = EXCLUDED._end_produced_swabs,
      _end_produced_boxes     = EXCLUDED._end_produced_boxes,
      _end_production_time_s  = EXCLUDED._end_production_time_s,
      _end_idle_time_s        = EXCLUDED._end_idle_time_s,
      _end_error_time_s       = EXCLUDED._end_error_time_s,
      _end_discarded_swabs    = EXCLUDED._end_discarded_swabs;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_cell_bucket(uuid, timestamptz)
  TO anon, authenticated;


-- ── B. aggregate_recent_buckets(): re-aggregate recent PLC buckets ──────────
-- Late ingest means a PLC bucket keeps receiving readings minutes after it
-- closed. Re-aggregate a sliding window every run (upsert is idempotent),
-- ascending so each bucket's _end is fresh before the next reads it as anchor.
-- Lookback 45 min covers the observed lag with margin; shrink later once the
-- bridge backlog (Part B) is fixed and lag falls to seconds.

CREATE OR REPLACE FUNCTION aggregate_recent_buckets(
  p_lookback interval DEFAULT interval '45 minutes'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_bucket timestamptz;
  v_first  timestamptz := date_bin(interval '5 minutes', now() - p_lookback, TIMESTAMPTZ '2000-01-01 00:00:00+00');
  v_last   timestamptz := date_bin(interval '5 minutes', now(),              TIMESTAMPTZ '2000-01-01 00:00:00+00');
BEGIN
  v_bucket := v_first;
  WHILE v_bucket <= v_last LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
    v_bucket := v_bucket + interval '5 minutes';
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_recent_buckets(interval)
  TO anon, authenticated, service_role;


-- ── C. point the cron at the re-aggregation wrapper ─────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aggregate-bucket-5m') THEN
    PERFORM cron.unschedule('aggregate-bucket-5m');
  END IF;
END $$;

SELECT cron.schedule(
  'aggregate-bucket-5m',
  '2-59/5 * * * *',
  $cron$ SELECT aggregate_recent_buckets(); $cron$
);
