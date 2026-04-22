-- ============================================================================
-- Realistic test data for FALU PMS
-- Per-machine, per-shift readings for 6 months
-- ============================================================================
--
-- The PLC sends two 12-hour shifts per day (shift_number 1 and 2).
-- The team assigned to each shift is configured separately in app_settings
-- (shift_assignments table) and is looked up by the analytics at display time.
--
-- BU formula:
--   bu_normalized = (swabs_produced / 7200) / run_hours * 12
--
-- Rated capacity: 240 BU × 7200 = 1 728 000 swabs / 12h shift
-- BU target: 185 BU  (machine must achieve ≥ 77 % uptime to hit this)
--
-- Performance design:
--   base efficiency (fraction of shift spent running): 0.74 – 0.88
--   fleet average ≈ 0.81 → 240 × 0.81 ≈ 194 BU/shift ≈ 105 % of target
--   Breakdown chance: 7 % per machine per shift
--   Weekend factor: −5 %    Night-shift factor: −3 %
-- ============================================================================

-- Wipe ALL historical data so no old test runs accumulate on top of each other.
DELETE FROM shift_readings;
DELETE FROM saved_shift_logs;
DELETE FROM analytics_readings;

-- Restore correct per-machine BU targets (run unconditionally)
UPDATE machines
SET
  bu_target           = 185,
  bu_mediocre         = 150,
  efficiency_good     = COALESCE(NULLIF(efficiency_good,     0), 85),
  efficiency_mediocre = COALESCE(NULLIF(efficiency_mediocre, 0), 70),
  scrap_good          = COALESCE(NULLIF(scrap_good,   0), 2),
  scrap_mediocre      = COALESCE(NULLIF(scrap_mediocre, 0), 5)
WHERE hidden = false;

DO $$
DECLARE
  machine_ids   UUID[];
  machine_codes TEXT[];
  machine_count INT;

  -- Rated capacity: 240 BU at 100 % uptime (= target / 0.77)
  rated_swabs    CONSTANT BIGINT := 1728000;  -- 240 BU × 7200 swabs/BU
  interval_rated CONSTANT BIGINT := 288000;   -- rated_swabs / 6 readings
  -- Hard cap per 2 h interval: 185 × 1.15 × 7200 / 6
  interval_cap   CONSTANT BIGINT := 255300;

  -- Per-machine uptime profiles (fleet average 0.810)
  base_eff DOUBLE PRECISION[] := ARRAY[
    0.88, 0.82, 0.85, 0.74, 0.83, 0.78,
    0.86, 0.76, 0.84, 0.73, 0.81, 0.79,
    0.87, 0.75, 0.80, 0.88, 0.77, 0.82
  ];

  base_scrap DOUBLE PRECISION[] := ARRAY[
    0.012, 0.018, 0.010, 0.026, 0.014, 0.021,
    0.016, 0.023, 0.011, 0.027, 0.017, 0.022,
    0.013, 0.025, 0.019, 0.012, 0.024, 0.020
  ];

  m_idx       INT;
  m_id        UUID;
  d           DATE;
  s           INT;
  r           INT;
  dow         INT;

  shift_start           TIMESTAMPTZ;
  shift_len_mins CONSTANT INT := 720;   -- 12-hour PLC shift
  n_readings     CONSTANT INT := 6;
  interval_mins  CONSTANT INT := 120;   -- 720 / 6

  mach_eff    DOUBLE PRECISION;
  day_factor  DOUBLE PRECISION;
  shift_factor DOUBLE PRECISION;
  eff_factor  DOUBLE PRECISION;

  is_breakdown BOOLEAN;
  bd_eff       DOUBLE PRECISION;

  cum_prod_time INT;
  cum_idle_time INT;
  cum_swabs     BIGINT;
  cum_discarded BIGINT;
  cum_boxes     BIGINT;
  cum_boxes_lp  BIGINT;

  inc_prod_mins INT;
  inc_swabs     BIGINT;
  inc_discarded BIGINT;
  inc_boxes     BIGINT;

  eff_pct  DOUBLE PRECISION;
  rej_pct  DOUBLE PRECISION;
  rec_at   TIMESTAMPTZ;

  err_cotton  INT;
  err_sticks  INT;
  err_pickups INT;
  err_other   INT;

BEGIN
  SELECT array_agg(id ORDER BY machine_code),
         array_agg(machine_code ORDER BY machine_code)
    INTO machine_ids, machine_codes
    FROM machines WHERE hidden = false;

  machine_count := COALESCE(array_length(machine_ids, 1), 0);
  IF machine_count = 0 THEN
    RAISE NOTICE 'No active machines — skipping.'; RETURN;
  END IF;

  FOR d IN SELECT generate_series(
      (CURRENT_DATE - INTERVAL '6 months')::date,
      (CURRENT_DATE - INTERVAL '1 day')::date,
      '1 day'
  ) LOOP
    dow := EXTRACT(dow FROM d)::int;

    day_factor := 1.0
      + CASE WHEN dow IN (0, 6) THEN -0.05 ELSE 0 END
      + (random() - 0.5) * 0.06;

    -- Two 12-hour PLC shifts per day:
    --   s=1  Day shift   07:00 – 18:59
    --   s=2  Night shift 19:00 – 06:59 (next calendar day)
    FOR s IN 1..2 LOOP
      shift_factor := day_factor
        + CASE WHEN s = 2 THEN -0.03 ELSE 0.01 END
        + (random() - 0.5) * 0.04;

      shift_start := d::timestamptz
        + CASE WHEN s = 1 THEN interval '7 hours' ELSE interval '19 hours' END;

      FOR m_idx IN 1..machine_count LOOP
        m_id     := machine_ids[m_idx];
        mach_eff := CASE WHEN m_idx <= 18 THEN base_eff[m_idx] ELSE 0.81 END;

        eff_factor := GREATEST(0.25, LEAST(0.98, mach_eff * shift_factor));

        is_breakdown := random() < 0.07;
        bd_eff       := 0.40 + random() * 0.20;

        cum_prod_time := 0;
        cum_idle_time := 0;
        cum_swabs     := 0;
        cum_discarded := 0;
        cum_boxes     := 0;
        cum_boxes_lp  := 0;

        FOR r IN 1..n_readings LOOP

          IF is_breakdown AND r BETWEEN 3 AND 5 THEN
            inc_prod_mins := GREATEST(5,
              (interval_mins * bd_eff * (0.7 + random() * 0.6))::int
            );
          ELSE
            inc_prod_mins := GREATEST(20,
              (interval_mins * eff_factor * (0.94 + random() * 0.12))::int
            );
            inc_prod_mins := LEAST(interval_mins, inc_prod_mins);
          END IF;

          cum_prod_time := cum_prod_time + inc_prod_mins;
          cum_idle_time := cum_idle_time + (interval_mins - inc_prod_mins);

          inc_swabs := (
            (rated_swabs::float8 / shift_len_mins)
            * inc_prod_mins
            * (0.97 + random() * 0.06)
          )::bigint;

          inc_swabs := LEAST(inc_swabs, interval_cap);
          inc_swabs := GREATEST(0, inc_swabs);

          cum_swabs := cum_swabs + inc_swabs;

          inc_discarded := GREATEST(0, (
            inc_swabs * (
              CASE WHEN m_idx <= 18 THEN base_scrap[m_idx] ELSE 0.018 END
              + (random() - 0.25) * 0.008
              + CASE WHEN is_breakdown AND r >= 3 THEN 0.012 ELSE 0 END
            )
          )::bigint);
          cum_discarded := cum_discarded + inc_discarded;

          inc_boxes    := GREATEST(0, inc_swabs / 7200);
          cum_boxes    := cum_boxes + inc_boxes;
          IF random() < 0.05 THEN
            cum_boxes_lp := cum_boxes_lp + GREATEST(1, inc_boxes / 10);
          END IF;

          eff_pct := CASE
            WHEN cum_prod_time + cum_idle_time > 0
            THEN LEAST(100.0,
              cum_prod_time::float8 / (cum_prod_time + cum_idle_time) * 100)
            ELSE 0 END;
          rej_pct := CASE
            WHEN cum_swabs > 0
            THEN LEAST(100.0, cum_discarded::float8 / cum_swabs * 100)
            ELSE 0 END;

          rec_at := shift_start
            + (r * interval_mins * interval '1 minute')
            + ((random() * 4 - 2) * interval '1 minute');

          err_cotton  := FLOOR(random() * r * 0.7)::int;
          err_sticks  := FLOOR(random() * r * 0.4)::int;
          err_pickups := FLOOR(random() * r * 0.5)::int;
          err_other   := FLOOR(random() * r * 0.25)::int;
          IF is_breakdown THEN
            err_cotton := err_cotton + FLOOR(random() * 4)::int;
            err_other  := err_other  + FLOOR(random() * 3)::int;
          END IF;

          INSERT INTO shift_readings (
            machine_id, shift_number, recorded_at,
            production_time_seconds, idle_time_seconds,
            cotton_tears, missing_sticks, faulty_pickups, other_errors,
            produced_swabs, packaged_swabs,
            produced_boxes, produced_boxes_layer_plus,
            discarded_swabs,
            efficiency, scrap_rate,
            save_flag
          ) VALUES (
            m_id, s, rec_at,
            cum_prod_time, cum_idle_time,
            err_cotton, err_sticks, err_pickups, err_other,
            cum_swabs, GREATEST(0, cum_swabs - cum_discarded),
            cum_boxes, cum_boxes_lp,
            cum_discarded,
            ROUND(eff_pct::numeric, 1), ROUND(rej_pct::numeric, 1),
            r = n_readings
          );

        END LOOP; -- readings

        INSERT INTO saved_shift_logs (
          machine_id, machine_code, shift_number,
          production_time_seconds, idle_time_seconds,
          cotton_tears, missing_sticks, faulty_pickups, other_errors,
          produced_swabs, packaged_swabs,
          produced_boxes, produced_boxes_layer_plus,
          discarded_swabs,
          efficiency, scrap_rate,
          saved_at
        ) VALUES (
          m_id, COALESCE(machine_codes[m_idx], 'CB-XX'), s,
          cum_prod_time, cum_idle_time,
          err_cotton, err_sticks, err_pickups, err_other,
          cum_swabs, GREATEST(0, cum_swabs - cum_discarded),
          cum_boxes, cum_boxes_lp,
          cum_discarded,
          ROUND(eff_pct::numeric, 1), ROUND(rej_pct::numeric, 1),
          shift_start + interval '12 hours' - (random() * interval '3 minutes')
        );

      END LOOP; -- machines
    END LOOP;   -- shifts
  END LOOP;     -- days

  RAISE NOTICE 'Done: % machines, 6 months, 2 PLC shifts/day.', machine_count;
END $$;
