-- ============================================================================
-- Realistic test data for FALU PMS
-- Per-machine, per-shift readings for 6 months
-- ============================================================================
--
-- Machine target: 185 BU / 12 h shift  (= 185 × 7 200 = 1 332 000 swabs)
-- Mediocre:       150 BU / 12 h shift
--
-- Performance design:
--   - base efficiency (fraction of shift spent producing): 0.72–0.88
--   - fleet average ≈ 82 % → ~152 BU/shift/machine → ~228 BU/h fleet
--   - "Good" reference line = 18 × 185 / 12 ≈ 278 BU/h (just above actual avg)
--   - Hard cap per 2 h interval: 115 % of interval target (never >213 BU/shift)
--   - Breakdowns: 7 % chance per machine per shift → drop to 40–60 % efficiency
--   - Weekends: −5 % day factor
--   - Night shift (shift 2): −3 % shift factor
--   - 6 CUMULATIVE readings per 12 h shift (every ~2 h + jitter)
--
-- Key formula fix: efficiency is applied only to PRODUCTIVE TIME.
--   Swab rate while running is close to 100 % of rated speed (+ small noise).
--   This avoids double-penalising efficiency in the swab count.
-- ============================================================================

-- Wipe old synthetic data (keeps any real data from today onward)
DELETE FROM shift_readings   WHERE recorded_at < CURRENT_DATE;
DELETE FROM saved_shift_logs WHERE saved_at     < CURRENT_DATE;

-- Restore correct per-machine BU targets
-- (run unconditionally so a previous bad seed does not persist)
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

  -- Per-machine efficiency profiles (up to 18 slots; extras use 0.80)
  -- These represent the fraction of shift time the machine is running.
  -- Fleet average ≈ 0.82  →  fleet BU ≈ 18 × 185 × 0.82 / 12 ≈ 228 BU/h
  base_eff DOUBLE PRECISION[] := ARRAY[
    0.88, 0.82, 0.85, 0.74, 0.83, 0.78,
    0.86, 0.76, 0.84, 0.73, 0.81, 0.79,
    0.87, 0.75, 0.80, 0.88, 0.77, 0.82
  ];

  -- Per-machine baseline scrap rate
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
  shift_len_mins CONSTANT INT := 720;         -- 12 h
  n_readings     CONSTANT INT := 6;           -- readings per shift
  interval_mins         INT;                  -- minutes per reading interval

  -- 185 BU × 7 200 swabs/BU = 1 332 000 swabs per shift at 100 % efficiency
  target_swabs   CONSTANT BIGINT := 1332000;
  interval_target         BIGINT;             -- target per single reading interval

  mach_eff       DOUBLE PRECISION;
  day_factor     DOUBLE PRECISION;
  shift_factor   DOUBLE PRECISION;
  eff_factor     DOUBLE PRECISION;            -- combined day × shift × machine

  is_breakdown   BOOLEAN;
  bd_eff         DOUBLE PRECISION;            -- breakdown severity (0.40–0.60)

  -- Cumulative counters reset each shift
  cum_prod_time  INT;
  cum_idle_time  INT;
  cum_swabs      BIGINT;
  cum_discarded  BIGINT;
  cum_boxes      BIGINT;
  cum_boxes_lp   BIGINT;

  -- Per-interval increments
  inc_prod_mins  INT;
  inc_swabs      BIGINT;
  inc_discarded  BIGINT;
  inc_boxes      BIGINT;

  eff_pct        DOUBLE PRECISION;
  rej_pct        DOUBLE PRECISION;
  rec_at         TIMESTAMPTZ;

  err_cotton  INT;
  err_sticks  INT;
  err_pickups INT;
  err_other   INT;

BEGIN
  SELECT array_agg(id ORDER BY machine_code),
         array_agg(machine_code ORDER BY machine_code)
    INTO machine_ids, machine_codes
    FROM machines
   WHERE hidden = false;

  machine_count := COALESCE(array_length(machine_ids, 1), 0);
  IF machine_count = 0 THEN
    RAISE NOTICE 'No active machines — skipping test data generation.';
    RETURN;
  END IF;

  interval_mins   := shift_len_mins / n_readings;       -- 120 min per interval
  interval_target := target_swabs   / n_readings;       -- 222 000 swabs per interval

  -- 6 months: 2025-09-17 through 2026-03-16
  FOR d IN SELECT generate_series('2025-09-17'::date, '2026-03-16'::date, '1 day') LOOP
    dow := EXTRACT(dow FROM d)::int;

    day_factor := 1.0
      + CASE WHEN dow IN (0, 6) THEN -0.05 ELSE 0 END
      + (random() - 0.5) * 0.06;

    FOR s IN 1..2 LOOP
      shift_factor := day_factor
        + CASE WHEN s = 2 THEN -0.03 ELSE 0.01 END
        + (random() - 0.5) * 0.04;

      shift_start := d::timestamptz
        + CASE WHEN s = 1 THEN interval '6 hours' ELSE interval '18 hours' END;

      FOR m_idx IN 1..machine_count LOOP
        m_id     := machine_ids[m_idx];
        mach_eff := CASE WHEN m_idx <= 18 THEN base_eff[m_idx] ELSE 0.80 END;

        -- Combined efficiency for this shift session
        eff_factor := GREATEST(0.30, LEAST(1.0, mach_eff * shift_factor));

        -- Breakdown: ~7 % chance
        is_breakdown := random() < 0.07;
        bd_eff       := CASE WHEN is_breakdown THEN 0.40 + random() * 0.20 ELSE 0 END;

        cum_prod_time := 0;
        cum_idle_time := 0;
        cum_swabs     := 0;
        cum_discarded := 0;
        cum_boxes     := 0;
        cum_boxes_lp  := 0;

        FOR r IN 1..n_readings LOOP

          -- ── Productive time for this interval ───────────────────────────
          -- Apply efficiency to TIME only (not to swab rate).
          -- Small noise ±6 % so readings are not perfectly uniform.
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

          -- ── Swab production ──────────────────────────────────────────────
          -- Rate while running is rated speed ± small noise (97–103 %).
          -- Efficiency was already captured in productive time above.
          inc_swabs := (
            (target_swabs::float8 / shift_len_mins)   -- rated swabs/min
            * inc_prod_mins                            -- productive minutes
            * (0.97 + random() * 0.06)                -- speed noise ±3 %
          )::bigint;

          -- Hard cap: +15 % of proportional target per interval
          inc_swabs := LEAST(inc_swabs, (interval_target::float8 * 1.15)::bigint);
          inc_swabs := GREATEST(0, inc_swabs);

          cum_swabs := cum_swabs + inc_swabs;

          -- ── Scrap ────────────────────────────────────────────────────────
          inc_discarded := GREATEST(0, (
            inc_swabs * (
              CASE WHEN m_idx <= 18 THEN base_scrap[m_idx] ELSE 0.018 END
              + (random() - 0.25) * 0.008
              + CASE WHEN is_breakdown AND r >= 3 THEN 0.012 ELSE 0 END
            )
          )::bigint);
          cum_discarded := cum_discarded + inc_discarded;

          -- ── Boxes ────────────────────────────────────────────────────────
          inc_boxes    := GREATEST(0, inc_swabs / 7200);
          cum_boxes    := cum_boxes + inc_boxes;
          IF random() < 0.05 THEN
            cum_boxes_lp := cum_boxes_lp + GREATEST(1, inc_boxes / 10);
          END IF;

          -- ── Efficiency and reject rate ───────────────────────────────────
          eff_pct := CASE
            WHEN cum_prod_time + cum_idle_time > 0
            THEN LEAST(100.0,
              cum_prod_time::float8 / (cum_prod_time + cum_idle_time) * 100
            )
            ELSE 0
          END;
          rej_pct := CASE
            WHEN cum_swabs > 0
            THEN LEAST(100.0, cum_discarded::float8 / cum_swabs * 100)
            ELSE 0
          END;

          -- ── Timestamp ────────────────────────────────────────────────────
          rec_at := shift_start
            + (r * interval_mins * interval '1 minute')
            + ((random() * 4 - 2) * interval '1 minute');

          -- ── Cumulative error counts ──────────────────────────────────────
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
            ROUND(eff_pct::numeric, 1), ROUND(rej_pct::numeric, 1),
            r = n_readings
          );

        END LOOP; -- readings

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

  RAISE NOTICE 'Test data complete: % machines, 6 months.', machine_count;
END $$;
