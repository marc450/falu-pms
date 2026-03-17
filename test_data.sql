-- ============================================================================
-- Realistic test data for FALU PMS
-- Generates per-machine, per-shift shift_readings for 6 months
-- ============================================================================
--
-- Design principles:
--   * 18 machines across 3 production cells (6 each)
--   * 2 shifts per day: shift 1 = 06:00-18:00, shift 2 = 18:00-06:00
--   * 6 cumulative readings per shift (every ~2 hours, ± jitter)
--   * Performance band: base efficiency 72-86%, typical output 70-95% of target
--   * Hard cap: never exceed +15% of target in a single reading interval
--   * Breakdowns: ~7% chance per machine per shift (reduces to 40-60% efficiency)
--   * Weekends: -5% overall factor
--   * Night shift (shift 2): -3% factor
--   * Each machine has a stable profile (strong, average, weak)
--   * bu_target and bu_mediocre are seeded onto machines so chart lines match
--
-- Target per machine per 12h shift:
--   target_swabs = 3,600,000  (= 500 BU at 7,200 swabs/BU)
--   bu_target    = 500 BU per shift per machine
--   bu_mediocre  = 380 BU per shift per machine (~76% of target)
--
-- ============================================================================

-- Wipe old synthetic data (keeps any real data from today onward)
DELETE FROM shift_readings    WHERE recorded_at  < CURRENT_DATE;
DELETE FROM saved_shift_logs  WHERE saved_at      < CURRENT_DATE;

-- Seed machine targets so the analytics chart reference lines match
-- Only updates machines that have not been configured yet (bu_target IS NULL or 0)
UPDATE machines
SET
  bu_target         = 500,
  bu_mediocre       = 380,
  efficiency_good   = COALESCE(NULLIF(efficiency_good,   0), 85),
  efficiency_mediocre = COALESCE(NULLIF(efficiency_mediocre, 0), 70),
  scrap_good        = COALESCE(NULLIF(scrap_good,   0), 2),
  scrap_mediocre    = COALESCE(NULLIF(scrap_mediocre, 0), 5)
WHERE hidden = false
  AND (bu_target IS NULL OR bu_target = 0);

DO $$
DECLARE
  -- Machine arrays
  machine_ids    UUID[];
  machine_codes  TEXT[];
  machine_count  INT;

  -- Per-machine performance profiles (18 slots; extras get average profile)
  -- base_eff: fraction of shift spent producing at full speed (0 = all idle)
  -- A machine with base_eff = 0.82 will produce ~82% of target in a normal shift
  base_eff   DOUBLE PRECISION[] := ARRAY[
    0.86, 0.80, 0.84, 0.72, 0.83, 0.78,   -- cell 1: 2 strong, 2 avg, 2 weak
    0.82, 0.76, 0.85, 0.74, 0.81, 0.77,   -- cell 2
    0.84, 0.73, 0.80, 0.86, 0.75, 0.79    -- cell 3
  ];

  -- base_scrap: baseline reject rate fraction (0.01 = 1%)
  base_scrap DOUBLE PRECISION[] := ARRAY[
    0.012, 0.018, 0.010, 0.026, 0.014, 0.021,
    0.016, 0.023, 0.011, 0.027, 0.017, 0.022,
    0.013, 0.025, 0.019, 0.012, 0.024, 0.020
  ];

  -- Iteration variables
  m_idx          INT;
  m_id           UUID;
  d              DATE;
  s              INT;
  r              INT;
  dow            INT;

  -- Shift timing
  shift_start         TIMESTAMPTZ;
  shift_len_mins CONSTANT INT := 720;   -- 12 hours
  readings_per_shift CONSTANT INT := 6;
  reading_interval_mins INT;

  -- Performance factors
  day_factor     DOUBLE PRECISION;
  shift_factor   DOUBLE PRECISION;
  mach_eff       DOUBLE PRECISION;
  is_breakdown   BOOLEAN;
  breakdown_eff  DOUBLE PRECISION;

  -- Cumulative counters (reset each shift)
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

  -- Derived
  eff_pct     DOUBLE PRECISION;
  rej_pct     DOUBLE PRECISION;
  rec_at      TIMESTAMPTZ;

  -- Target: swabs per reading interval at 100% efficiency
  -- 3,600,000 swabs / 6 readings = 600,000 per interval at 100%
  target_swabs CONSTANT BIGINT := 3600000;
  interval_target BIGINT;

  -- Error counts (cumulative, small)
  err_cotton  INT;
  err_sticks  INT;
  err_pickups INT;
  err_other   INT;

BEGIN
  -- Load machine IDs
  SELECT array_agg(id ORDER BY machine_code),
         array_agg(machine_code ORDER BY machine_code)
    INTO machine_ids, machine_codes
    FROM machines
   WHERE hidden = false;

  machine_count := COALESCE(array_length(machine_ids, 1), 0);
  IF machine_count = 0 THEN
    RAISE NOTICE 'No active machines found — skipping test data generation.';
    RETURN;
  END IF;

  reading_interval_mins := shift_len_mins / readings_per_shift;  -- 120 min
  interval_target := target_swabs / readings_per_shift;          -- 600,000

  -- Generate 6 months: 2025-09-17 through 2026-03-16
  FOR d IN SELECT generate_series('2025-09-17'::date, '2026-03-16'::date, '1 day') LOOP
    dow := EXTRACT(dow FROM d)::int;  -- 0 = Sun, 6 = Sat

    -- Day-level factor: weekends lower, small daily random variation
    day_factor := 1.0
      + CASE WHEN dow IN (0, 6) THEN -0.05 ELSE 0 END
      + (random() - 0.5) * 0.06;   -- +/- 3% daily swing

    FOR s IN 1..2 LOOP
      -- Shift-level factor: shift 2 (night) slightly weaker
      shift_factor := day_factor
        + CASE WHEN s = 2 THEN -0.03 ELSE 0.01 END
        + (random() - 0.5) * 0.04;

      shift_start := d::timestamptz
        + CASE WHEN s = 1 THEN interval '6 hours' ELSE interval '18 hours' END;

      FOR m_idx IN 1..machine_count LOOP
        m_id := machine_ids[m_idx];

        -- Machine efficiency profile (fall back to 0.80 for machines beyond 18)
        mach_eff := CASE
          WHEN m_idx <= array_length(base_eff, 1) THEN base_eff[m_idx]
          ELSE 0.80
        END;

        -- ~7% chance of a breakdown this shift
        is_breakdown  := random() < 0.07;
        -- Breakdown severity: efficiency drops to 40-60% of normal
        breakdown_eff := CASE WHEN is_breakdown THEN 0.40 + random() * 0.20 ELSE 0 END;

        -- Reset cumulative counters
        cum_prod_time := 0;
        cum_idle_time := 0;
        cum_swabs     := 0;
        cum_discarded := 0;
        cum_boxes     := 0;
        cum_boxes_lp  := 0;

        FOR r IN 1..readings_per_shift LOOP

          -- ── Production time for this interval ─────────────────────────────
          -- Breakdown happens mid-shift (readings 3-5) with reduced efficiency
          IF is_breakdown AND r BETWEEN 3 AND 5 THEN
            -- During breakdown: mostly idle, short bursts of production
            inc_prod_mins := GREATEST(8,
              (reading_interval_mins * breakdown_eff * (0.7 + random() * 0.6))::int
            );
          ELSE
            -- Normal: production time = interval × machine_eff × shift_factor × small noise
            -- Noise band: 0.88-1.05 (skewed so average ≈ 0.96, not 1.0)
            inc_prod_mins := GREATEST(30,
              (reading_interval_mins
               * mach_eff * shift_factor
               * (0.88 + random() * 0.17)
              )::int
            );
            -- Cannot exceed the interval
            inc_prod_mins := LEAST(reading_interval_mins, inc_prod_mins);
          END IF;

          inc_idle_mins := reading_interval_mins - inc_prod_mins;

          cum_prod_time := cum_prod_time + inc_prod_mins;
          cum_idle_time := cum_idle_time + inc_idle_mins;

          -- ── Swab production for this interval ────────────────────────────
          -- Base: rate × productive minutes × machine_eff × shift_factor × noise
          -- Cap each interval at 115% of the proportional target (= 690,000 swabs)
          inc_swabs := (
            (target_swabs::float8 / shift_len_mins)   -- rate per minute
            * inc_prod_mins
            * mach_eff * shift_factor
            * (0.88 + random() * 0.17)                -- 88-105% of expected rate
          )::bigint;

          -- Hard cap per interval: +15% of interval_target
          inc_swabs := LEAST(inc_swabs, (interval_target * 1.15)::bigint);
          inc_swabs := GREATEST(0, inc_swabs);

          -- Breakdown slashes production
          IF is_breakdown AND r BETWEEN 3 AND 5 THEN
            inc_swabs := (inc_swabs * breakdown_eff)::bigint;
          END IF;

          cum_swabs := cum_swabs + inc_swabs;

          -- ── Scrap ─────────────────────────────────────────────────────────
          inc_discarded := GREATEST(0, (
            inc_swabs * (
              CASE WHEN m_idx <= array_length(base_scrap, 1)
                   THEN base_scrap[m_idx] ELSE 0.018 END
              + (random() - 0.25) * 0.008   -- slightly skewed positive
              + CASE WHEN is_breakdown AND r >= 3 THEN 0.012 ELSE 0 END
            )
          )::bigint);
          cum_discarded := cum_discarded + inc_discarded;

          -- ── Boxes ─────────────────────────────────────────────────────────
          inc_boxes := GREATEST(0, inc_swabs / 7200);
          cum_boxes := cum_boxes + inc_boxes;
          -- ~5% chance of layer-plus boxes in this interval
          IF random() < 0.05 THEN
            cum_boxes_lp := cum_boxes_lp + GREATEST(1, inc_boxes / 10);
          END IF;

          -- ── Efficiency and reject rate ────────────────────────────────────
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

          -- ── Timestamp: spread evenly through shift with small jitter ──────
          rec_at := shift_start
            + (r * reading_interval_mins * interval '1 minute')
            + ((random() * 4 - 2) * interval '1 minute');   -- +/- 2 min jitter

          -- ── Error counts (cumulative, grow slowly through shift) ──────────
          err_cotton  := FLOOR(random() * r * 0.7)::int;
          err_sticks  := FLOOR(random() * r * 0.4)::int;
          err_pickups := FLOOR(random() * r * 0.5)::int;
          err_other   := FLOOR(random() * r * 0.25)::int;
          IF is_breakdown THEN
            err_cotton  := err_cotton  + FLOOR(random() * 4)::int;
            err_other   := err_other   + FLOOR(random() * 3)::int;
          END IF;

          -- ── Insert reading ────────────────────────────────────────────────
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
            r = readings_per_shift    -- save_flag = true on last reading
          );

        END LOOP; -- readings

        -- ── Insert saved_shift_log for the completed shift ────────────────
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
          COALESCE(machine_codes[m_idx], 'CB-XX'),
          s,
          cum_prod_time, cum_idle_time,
          err_cotton, err_sticks, err_pickups, err_other,
          cum_swabs, GREATEST(0, cum_swabs - cum_discarded),
          cum_boxes, cum_boxes_lp,
          cum_discarded,
          ROUND(eff_pct::numeric, 1), ROUND(rej_pct::numeric, 1),
          shift_start + interval '12 hours'
            - (random() * interval '3 minutes')
        );

      END LOOP; -- machines
    END LOOP;   -- shifts
  END LOOP;     -- days

  RAISE NOTICE 'Test data generation complete (% machines, 6 months).',
    machine_count;
END $$;
