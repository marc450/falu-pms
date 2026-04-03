-- Backfill error_shift_summary with realistic historical data
-- From September 18, 2025 to April 1, 2026
-- Uses weighted error code distribution matching the simulator
-- Run this in the Supabase SQL Editor

DO $$
DECLARE
  rec RECORD;
  d DATE;
  s INTEGER;
  err_code VARCHAR(10);
  occ INTEGER;
  dur INTEGER;
  -- Weighted error codes (higher weight = more likely to appear)
  -- We'll use arrays to define codes and their weights
  codes TEXT[] := ARRAY[
    'A172','A173','A073','A074','A190','A274','A275','A276','A176','A177',
    'A010','A011','A012','A040','A124','A113','A180','A075','A278',
    'A035','A041','A244','A245','A246','A236','A109','A127','A171',
    'A001','A002','A003','A013','A014','A015','A016','A019','A020',
    'A030','A031','A032','A033','A034','A036','A037','A042','A050',
    'A051','A060','A070','A071','A072','A076','A077','A100','A101',
    'A102','A103','A104','A110','A111','A112','A114','A120','A121',
    'A122','A123','A125','A126','A128','A129','A170','A174','A175',
    'A178','A179','A181','A191','A192','A193','A200','A210','A230',
    'A231','A232','A233','A234','A235','A237','A243','A247','A270',
    'A271','A272','A273','A277'
  ];
  weights INTEGER[] := ARRAY[
    40,40,35,30,25,25,20,15,20,15,
    15,12,10,10,10,8,8,8,7,
    5,5,5,5,4,4,3,3,3,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,1,
    1,1,1,1,1
  ];
  total_weight INTEGER := 0;
  i INTEGER;
  r FLOAT;
  cum_weight INTEGER;
  picked_code TEXT;
  num_errors INTEGER;
  j INTEGER;
  day_of_week INTEGER;
BEGIN
  -- Calculate total weight
  FOR i IN 1..array_length(weights, 1) LOOP
    total_weight := total_weight + weights[i];
  END LOOP;

  -- Loop through each machine
  FOR rec IN SELECT id, machine_code FROM machines LOOP
    -- Loop through each day from Sept 18, 2025 to April 1, 2026
    d := '2025-09-18'::DATE;
    WHILE d <= '2026-04-01'::DATE LOOP
      day_of_week := EXTRACT(DOW FROM d)::INTEGER;

      -- Loop through 3 PLC shifts per day
      FOR s IN 1..3 LOOP
        -- Determine how many unique error codes for this shift
        -- Weekdays: more errors, weekends: fewer
        -- Random between 2-6 errors per shift (weekday) or 1-3 (weekend)
        IF day_of_week IN (0, 6) THEN
          num_errors := 1 + floor(random() * 3)::INTEGER;  -- 1-3
        ELSE
          num_errors := 2 + floor(random() * 5)::INTEGER;  -- 2-6
        END IF;

        -- Sometimes a shift has no errors (10% chance)
        IF random() < 0.10 THEN
          num_errors := 0;
        END IF;

        -- Pick and insert error codes for this shift
        FOR j IN 1..num_errors LOOP
          -- Weighted random pick
          r := random() * total_weight;
          cum_weight := 0;
          picked_code := codes[1]; -- fallback
          FOR i IN 1..array_length(codes, 1) LOOP
            cum_weight := cum_weight + weights[i];
            IF r <= cum_weight THEN
              picked_code := codes[i];
              EXIT;
            END IF;
          END LOOP;

          -- Generate realistic occurrence count and duration
          -- Common errors: more occurrences, shorter individual duration
          -- Rare errors: fewer occurrences, variable duration
          CASE
            WHEN picked_code IN ('A172','A173','A073','A074') THEN
              -- Very common: 3-12 occurrences, 30-180 sec each
              occ := 3 + floor(random() * 10)::INTEGER;
              dur := occ * (30 + floor(random() * 150)::INTEGER);
            WHEN picked_code IN ('A190','A274','A275','A276','A176','A177') THEN
              -- Common material: 2-8 occurrences, 60-300 sec each
              occ := 2 + floor(random() * 7)::INTEGER;
              dur := occ * (60 + floor(random() * 240)::INTEGER);
            WHEN picked_code IN ('A010','A011','A012','A040','A124') THEN
              -- Operational stops: 1-4 occurrences, 120-600 sec each
              occ := 1 + floor(random() * 4)::INTEGER;
              dur := occ * (120 + floor(random() * 480)::INTEGER);
            WHEN picked_code IN ('A113','A180','A075','A278') THEN
              -- Mechanical: 1-3 occurrences, 180-900 sec each
              occ := 1 + floor(random() * 3)::INTEGER;
              dur := occ * (180 + floor(random() * 720)::INTEGER);
            ELSE
              -- Everything else: 1-2 occurrences, 60-600 sec each
              occ := 1 + floor(random() * 2)::INTEGER;
              dur := occ * (60 + floor(random() * 540)::INTEGER);
          END CASE;

          -- Insert with ON CONFLICT to handle duplicates
          INSERT INTO error_shift_summary (machine_id, machine_code, shift_date, plc_shift, error_code, occurrence_count, total_duration_secs)
          VALUES (rec.id, rec.machine_code, d, s, picked_code, occ, dur)
          ON CONFLICT (machine_id, shift_date, plc_shift, error_code)
          DO UPDATE SET
            occurrence_count = error_shift_summary.occurrence_count + EXCLUDED.occurrence_count,
            total_duration_secs = error_shift_summary.total_duration_secs + EXCLUDED.total_duration_secs;
        END LOOP;
      END LOOP;

      d := d + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Backfill complete!';
END $$;
