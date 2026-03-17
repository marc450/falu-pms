-- ============================================================================
-- Realistic test data for FALU PMS
-- Generates per-machine, per-shift shift_readings for 6 months
-- ============================================================================
-- Design principles:
--   * Each machine has a unique performance profile (base efficiency, scrap tendency)
--   * Each shift has characteristics (shift 2 / night slightly weaker)
--   * Production stays realistic: max 120% of target, most readings 85..105%
--   * Occasional breakdowns (efficiency drops to 40..60%)
--   * Weekends have slightly lower output
--   * 6 cumulative readings spread across each 12h shift
--   * Machine names follow the CB-30..CB-37 convention (8 machines)
-- ============================================================================

-- Wipe old synthetic data (keeps any real data from today onward)
DELETE FROM shift_readings WHERE recorded_at < CURRENT_DATE;
DELETE FROM saved_shift_logs WHERE saved_at < CURRENT_DATE;

DO $$
DECLARE
  -- Machine arrays (parallel arrays for profiles)
  machine_ids    UUID[];
  machine_codes  TEXT[];
  machine_count  INT;

  -- Per-machine performance profiles: base efficiency (0..1), scrap tendency (0..1)
  -- Index matches machine_ids array position
  base_eff       DOUBLE PRECISION[] := ARRAY[0.92, 0.88, 0.95, 0.85, 0.90, 0.87, 0.93, 0.89];
  base_scrap     DOUBLE PRECISION[] := ARRAY[0.012, 0.018, 0.008, 0.022, 0.015, 0.020, 0.010, 0.016];

  -- Iteration variables
  m_idx          INT;
  m_id           UUID;
  d              DATE;
  s              INT;       -- shift number (1 or 2)
  r              INT;       -- reading index within shift
  dow            INT;

  -- Shift timing
  shift_start    TIMESTAMPTZ;
  shift_len_mins CONSTANT INT := 720;  -- 12 hours
  reading_interval_mins INT;

  -- Performance factors
  day_factor     DOUBLE PRECISION;
  shift_factor   DOUBLE PRECISION;
  machine_eff    DOUBLE PRECISION;
  is_breakdown   BOOLEAN;
  breakdown_sev  DOUBLE PRECISION;

  -- Cumulative counters (reset per shift)
  cum_prod_time  INT;
  cum_idle_time  INT;
  cum_swabs      BIGINT;
  cum_discarded  BIGINT;
  cum_boxes      BIGINT;
  cum_boxes_lp   BIGINT;

  -- Per-reading increments
  inc_prod_mins  INT;
  inc_idle_mins  INT;
  inc_swabs      BIGINT;
  inc_discarded  BIGINT;
  inc_boxes      BIGINT;

  -- Calculated
  eff_pct        DOUBLE PRECISION;
  rej_pct        DOUBLE PRECISION;
  rec_at         TIMESTAMPTZ;

  -- Target: per machine per shift (12h)
  -- 555 BUs = 555 * 7200 = 3,996,000 swabs per shift
  target_swabs   CONSTANT BIGINT := 3996000;

  -- Error counts
  err_cotton     INT;
  err_sticks     INT;
  err_pickups    INT;
  err_other      INT;

BEGIN
  -- Load machine IDs in a deterministic order
  SELECT array_agg(id ORDER BY machine_code),
         array_agg(machine_code ORDER BY machine_code)
    INTO machine_ids, machine_codes
    FROM machines
   WHERE hidden = false;

  machine_count := coalesce(array_length(machine_ids, 1), 0);
  IF machine_count = 0 THEN
    RAISE NOTICE 'No active machines found. Skipping test data generation.';
    RETURN;
  END IF;

  -- If fewer than 8 machines, truncate profile arrays
  -- If more, extra machines get average profiles
  -- (profiles are just defaults; random noise is added anyway)

  reading_interval_mins := shift_len_mins / 6;  -- ~120 min between readings

  -- Generate 6 months of data: 2025-09-17 through 2026-03-16
  FOR d IN SELECT generate_series('2025-09-17'::date, '2026-03-16'::date, '1 day') LOOP
    dow := extract(dow FROM d)::int;  -- 0=Sun, 6=Sat

    -- Day-level performance factor: weekends slightly lower, some random variation
    day_factor := 1.0
      + CASE WHEN dow IN (0, 6) THEN -0.06 ELSE 0 END
      + (random() - 0.5) * 0.08;  -- +/- 4% random daily swing

    -- Two shifts per day (shift 1 = 06:00..18:00, shift 2 = 18:00..06:00 next day)
    FOR s IN 1..2 LOOP
      -- Shift-level factor: shift 2 (night) is ~3% weaker on average
      shift_factor := day_factor
        + CASE WHEN s = 2 THEN -0.03 ELSE 0.01 END
        + (random() - 0.5) * 0.04;  -- small shift-level noise

      shift_start := d::timestamptz + (CASE WHEN s = 1 THEN interval '6 hours' ELSE interval '18 hours' END);

      -- Each machine independently
      FOR m_idx IN 1..machine_count LOOP
        m_id := machine_ids[m_idx];

        -- Machine base efficiency (use profile if available, else default 0.90)
        machine_eff := CASE
          WHEN m_idx <= array_length(base_eff, 1) THEN base_eff[m_idx]
          ELSE 0.90
        END;

        -- Determine if this machine has a breakdown this shift (~4% chance)
        is_breakdown := random() < 0.04;
        -- Breakdown severity: how much efficiency drops (0.4..0.65)
        breakdown_sev := CASE WHEN is_breakdown THEN 0.40 + random() * 0.25 ELSE 0 END;

        -- Reset cumulative counters
        cum_prod_time := 0;
        cum_idle_time := 0;
        cum_swabs     := 0;
        cum_discarded := 0;
        cum_boxes     := 0;
        cum_boxes_lp  := 0;

        -- 6 readings spread across the shift
        FOR r IN 1..6 LOOP
          -- Time allocation for this reading interval (~120 mins)
          -- Normal: high production time, low idle
          -- Breakdown: much more idle time
          IF is_breakdown AND r >= 3 AND r <= 5 THEN
            -- Breakdown happens mid-shift (readings 3-5)
            inc_prod_mins := GREATEST(10, (reading_interval_mins * breakdown_sev * (0.8 + random() * 0.4))::int);
            inc_idle_mins := reading_interval_mins - inc_prod_mins;
          ELSE
            -- Normal operation
            inc_prod_mins := GREATEST(60, (reading_interval_mins * machine_eff * shift_factor * (0.92 + random() * 0.16))::int);
            inc_prod_mins := LEAST(reading_interval_mins, inc_prod_mins);
            inc_idle_mins := reading_interval_mins - inc_prod_mins;
          END IF;

          cum_prod_time := cum_prod_time + inc_prod_mins;
          cum_idle_time := cum_idle_time + inc_idle_mins;

          -- Swab production for this interval
          -- Rate: target_swabs / shift_len_mins * production_minutes * performance
          -- Cap at 120% of proportional target
          inc_swabs := GREATEST(0,
            (target_swabs::double precision / shift_len_mins * inc_prod_mins
              * machine_eff * shift_factor
              * (0.90 + random() * 0.15)  -- 90..105% of expected rate
            )::bigint
          );
          -- Hard cap: never exceed 120% of proportional target for this interval
          inc_swabs := LEAST(inc_swabs,
            (target_swabs::double precision * 1.20 / 6)::bigint
          );

          -- If breakdown, production drops significantly
          IF is_breakdown AND r >= 3 AND r <= 5 THEN
            inc_swabs := (inc_swabs * breakdown_sev)::bigint;
          END IF;

          cum_swabs := cum_swabs + inc_swabs;

          -- Scrap / discarded
          inc_discarded := GREATEST(0,
            (inc_swabs * (
              CASE WHEN m_idx <= array_length(base_scrap, 1) THEN base_scrap[m_idx] ELSE 0.015 END
              + (random() - 0.3) * 0.01  -- skewed slightly positive (more scrap)
              + CASE WHEN is_breakdown AND r >= 3 THEN 0.015 ELSE 0 END  -- extra scrap during breakdown
            ))::bigint
          );
          cum_discarded := cum_discarded + inc_discarded;

          -- Boxes: swabs / 7200 (some are layer-plus at 541 swabs each, ~5%)
          inc_boxes := GREATEST(0, inc_swabs / 7200);
          cum_boxes := cum_boxes + inc_boxes;
          IF random() < 0.05 THEN
            cum_boxes_lp := cum_boxes_lp + GREATEST(1, inc_boxes / 10);
          END IF;

          -- Calculate cumulative efficiency and reject rate
          eff_pct := CASE
            WHEN cum_prod_time + cum_idle_time > 0
            THEN LEAST(100.0, cum_prod_time::double precision / (cum_prod_time + cum_idle_time) * 100)
            ELSE 0
          END;
          rej_pct := CASE
            WHEN cum_swabs > 0
            THEN cum_discarded::double precision / cum_swabs * 100
            ELSE 0
          END;

          -- Recording timestamp: spread across shift with some jitter
          rec_at := shift_start
            + (r * reading_interval_mins * interval '1 minute')
            + ((random() * 5 - 2.5) * interval '1 minute');  -- +/- 2.5 min jitter

          -- Error counts (cumulative, grow slowly)
          err_cotton  := floor(random() * r * 0.8)::int;
          err_sticks  := floor(random() * r * 0.5)::int;
          err_pickups := floor(random() * r * 0.6)::int;
          err_other   := floor(random() * r * 0.3)::int;
          IF is_breakdown THEN
            err_cotton  := err_cotton  + floor(random() * 5)::int;
            err_other   := err_other   + floor(random() * 3)::int;
          END IF;

          -- Insert the reading
          INSERT INTO shift_readings (
            machine_id, shift_number, recorded_at,
            production_time, idle_time,
            cotton_tears, missing_sticks, faulty_pickups, other_errors,
            produced_swabs, packaged_swabs,
            produced_boxes, produced_boxes_layer_plus,
            discarded_swabs,
            efficiency, reject_rate,
            save_flag
          ) VALUES (
            m_id, s, rec_at,
            cum_prod_time, cum_idle_time,
            err_cotton, err_sticks, err_pickups, err_other,
            cum_swabs, GREATEST(0, cum_swabs - cum_discarded),
            cum_boxes, cum_boxes_lp,
            cum_discarded,
            round(eff_pct::numeric, 1), round(rej_pct::numeric, 1),
            r = 6  -- save_flag = true on last reading of shift
          );

        END LOOP;  -- readings

        -- Also insert a saved_shift_log for the completed shift
        INSERT INTO saved_shift_logs (
          machine_id, machine_code, shift_number,
          production_time, idle_time,
          cotton_tears, missing_sticks, faulty_pickups, other_errors,
          produced_swabs, packaged_swabs,
          produced_boxes, produced_boxes_layer_plus,
          discarded_swabs,
          efficiency, reject_rate,
          saved_at
        ) VALUES (
          m_id,
          CASE WHEN m_idx <= array_length(machine_codes, 1) THEN machine_codes[m_idx] ELSE 'CB-XX' END,
          s,
          cum_prod_time, cum_idle_time,
          err_cotton, err_sticks, err_pickups, err_other,
          cum_swabs, GREATEST(0, cum_swabs - cum_discarded),
          cum_boxes, cum_boxes_lp,
          cum_discarded,
          round(eff_pct::numeric, 1), round(rej_pct::numeric, 1),
          shift_start + interval '12 hours' - (random() * interval '2 minutes')
        );

      END LOOP;  -- machines
    END LOOP;  -- shifts
  END LOOP;  -- days

  RAISE NOTICE 'Test data generation complete.';
END $$;
