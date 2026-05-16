-- ============================================================
-- Migration 082b: backfill bucket_analytics_15m (optional)
-- ============================================================
-- Run AFTER 082 (which truncated the table and fixed the
-- anchor logic). Each chunk does ~24 buckets (6h) and ~1.5k
-- internal queries — should fit comfortably under the Supabase
-- SQL editor timeout. Chunks MUST run in time order because
-- each bucket's anchor is taken from the previous bucket.
--
-- If a chunk still times out, halve its window — duplicate
-- the DO block and swap the interval bounds.
-- ============================================================


-- ── Chunk 1 of 8: now - 48h to now - 42h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '48 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '42 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 2 of 8: now - 42h to now - 36h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '42 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '36 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 3 of 8: now - 36h to now - 30h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '36 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '30 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 4 of 8: now - 30h to now - 24h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '30 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '24 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 5 of 8: now - 24h to now - 18h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '24 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '18 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 6 of 8: now - 18h to now - 12h ────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '18 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '12 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 7 of 8: now - 12h to now - 6h ─────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '12 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now() - interval '6 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;


-- ── Chunk 8 of 8: now - 6h to now ───────────────────────────────────────────
DO $$
DECLARE v_bucket timestamptz;
BEGIN
  FOR v_bucket IN
    SELECT generate_series(
      date_bin('15 minutes', now() - interval '6 hours', TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'),
      date_bin('15 minutes', now(), TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00') - interval '15 minutes',
      interval '15 minutes'
    )
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;
