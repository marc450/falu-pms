-- ============================================================
-- Migration 095: data-quality monitor (detection layer)
-- ============================================================
-- Deterministic, zero-cost guard against the class of bug that
-- produced Avg Uptime >100%: when more than one publisher feeds
-- the same machines, per-bucket counter deltas exceed the bucket
-- window. A real machine can run at most 300s of production in a
-- 5-min (300s) bucket, so production_time_seconds > ~330 (300 +
-- jitter) for any machine, or fleet uptime > ~105%, is physically
-- impossible and means a data-source problem upstream.
--
-- This layer ONLY detects and records. It reuses the existing
-- uptime formula from get_fleet_trend_minute (089d) verbatim and
-- changes no KPI logic. A separate Node loop in the bridge reads
-- new rows, asks Claude for a root-cause report, and notifies.
--
-- Scheduled at :04 (just after the :02 bucket aggregation from
-- 083) so the just-closed bucket is already populated.
-- ============================================================


-- ── A. data_quality_alerts table ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.data_quality_alerts (
  id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket_ts          timestamptz  NOT NULL,
  check_type         text         NOT NULL,   -- production_time_over_window | uptime_over_100
  severity           text         NOT NULL DEFAULT 'warning',  -- warning | critical
  machines_affected  integer      NOT NULL DEFAULT 0,
  worst_machine_code text,
  worst_value        numeric,                  -- worst production_time_seconds, or fleet uptime %
  fleet_uptime_pct   numeric,
  details            jsonb,                    -- structured context for the report step
  status             text         NOT NULL DEFAULT 'new',  -- new | notified | acknowledged | resolved
  report             text,                     -- Claude-generated plain-language explanation
  notified_at        timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT data_quality_alerts_bucket_check_key UNIQUE (bucket_ts, check_type)
);

CREATE INDEX IF NOT EXISTS data_quality_alerts_status_idx
  ON public.data_quality_alerts (status, created_at DESC);

ALTER TABLE public.data_quality_alerts ENABLE ROW LEVEL SECURITY;

GRANT SELECT                         ON public.data_quality_alerts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_quality_alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_quality_alerts TO service_role;

-- Admins (authenticated) read alerts in the UI; service_role (bridge) bypasses
-- RLS for its inserts/updates. The cron job runs as table owner, also bypassing.
DROP POLICY IF EXISTS data_quality_alerts_read ON public.data_quality_alerts;
CREATE POLICY data_quality_alerts_read
  ON public.data_quality_alerts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS data_quality_alerts_update ON public.data_quality_alerts;
CREATE POLICY data_quality_alerts_update
  ON public.data_quality_alerts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


-- ── B. check_data_quality() ─────────────────────────────────────────────────
-- Scans recently CLOSED buckets and records one alert per violating bucket.
-- Defaults: 300s window + 10% jitter = 330; uptime 100% + 5pp tolerance = 105.

CREATE OR REPLACE FUNCTION public.check_data_quality(
  p_lookback         interval DEFAULT interval '15 minutes',
  p_prod_seconds_max numeric  DEFAULT 330,
  p_uptime_max       numeric  DEFAULT 105
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH bucket_stats AS (
    SELECT
      b.bucket_ts,
      count(DISTINCT b.machine_id)                                           AS machines,
      max(b.production_time_seconds)                                         AS worst_prod_s,
      (array_agg(b.machine_code ORDER BY b.production_time_seconds DESC))[1] AS worst_machine_code,
      round(sum(b.production_time_seconds)::numeric
            / (count(DISTINCT b.machine_id) * 300) * 100, 1)                 AS fleet_uptime_pct,
      count(*) FILTER (WHERE b.production_time_seconds > p_prod_seconds_max)  AS machines_over,
      round(avg(b.reading_count), 1)                                         AS avg_readings
    FROM bucket_analytics_5m b
    WHERE b.bucket_ts >= now() - p_lookback
      -- only buckets that have fully closed (exclude the in-progress one)
      AND b.bucket_ts < date_bin(interval '5 minutes', now(),
                                 TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00')
    GROUP BY b.bucket_ts
  ),
  violations AS (
    SELECT
      bs.*,
      CASE
        WHEN bs.machines_over > 0           THEN 'production_time_over_window'
        WHEN bs.fleet_uptime_pct > p_uptime_max THEN 'uptime_over_100'
      END AS check_type
    FROM bucket_stats bs
    WHERE bs.machines_over > 0
       OR bs.fleet_uptime_pct > p_uptime_max
  )
  INSERT INTO data_quality_alerts (
    bucket_ts, check_type, severity, machines_affected,
    worst_machine_code, worst_value, fleet_uptime_pct, details
  )
  SELECT
    v.bucket_ts,
    v.check_type,
    CASE WHEN v.fleet_uptime_pct > 200 OR v.worst_prod_s > 600
         THEN 'critical' ELSE 'warning' END,
    v.machines_over,
    v.worst_machine_code,
    CASE WHEN v.check_type = 'production_time_over_window'
         THEN v.worst_prod_s ELSE v.fleet_uptime_pct END,
    v.fleet_uptime_pct,
    jsonb_build_object(
      'machines',                      v.machines,
      'machines_over_threshold',       v.machines_over,
      'prod_seconds_threshold',        p_prod_seconds_max,
      'worst_production_time_seconds', v.worst_prod_s,
      'worst_machine_code',            v.worst_machine_code,
      'fleet_uptime_pct',              v.fleet_uptime_pct,
      'avg_reading_count',             v.avg_readings,
      'bucket_window_seconds',         300
    )
  FROM violations v
  ON CONFLICT (bucket_ts, check_type) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_data_quality(interval, numeric, numeric)
  TO service_role;


-- ── C. schedule the check every 5 minutes (at :04) ──────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'data-quality-check') THEN
    PERFORM cron.unschedule('data-quality-check');
  END IF;
END $$;

SELECT cron.schedule(
  'data-quality-check',
  '4-59/5 * * * *',
  $cron$ SELECT public.check_data_quality(); $cron$
);
