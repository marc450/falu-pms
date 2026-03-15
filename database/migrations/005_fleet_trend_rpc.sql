-- Migration 005: fleet trend RPC function
--
-- Replaces the client-side row-fetch + JS bucketing approach, which was
-- silently capped at PostgREST's max-rows limit (default 1000).  Instead,
-- all aggregation runs inside Postgres and only one pre-bucketed row per
-- time bucket is returned to the client.
--
-- Usage:
--   select * from get_fleet_trend('2026-03-14T00:00:00Z', '2026-03-15T17:00:00Z', 'hour');
--   select * from get_fleet_trend('2026-02-15T00:00:00Z', '2026-03-15T17:00:00Z', 'day');

create or replace function get_fleet_trend(
  range_start        timestamptz,
  range_end          timestamptz,
  bucket_granularity text          -- 'hour' or 'day'
)
returns table (
  bucket        text,
  avg_uptime    numeric,
  avg_scrap     numeric,
  total_boxes   bigint,
  total_swabs   bigint,
  machine_count bigint,
  reading_count bigint
)
language sql
stable
as $$
  with src as (
    -- Assign each reading to its time bucket; keep only the columns we need.
    select
      case bucket_granularity
        when 'hour' then to_char(date_trunc('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
        else             to_char(date_trunc('day',  recorded_at), 'YYYY-MM-DD')
      end            as bucket,
      machine_id,
      shift_number,
      efficiency,
      reject_rate,
      produced_boxes,
      produced_swabs
    from shift_readings
    where recorded_at >= range_start
      and recorded_at <= range_end
  ),

  -- For cumulative production counters, take the MAX value per
  -- (machine, shift, bucket) to avoid summing repeated cumulative totals.
  max_prod as (
    select
      bucket,
      machine_id,
      shift_number,
      max(produced_boxes) as max_boxes,
      max(produced_swabs) as max_swabs
    from src
    group by bucket, machine_id, shift_number
  ),

  prod_totals as (
    select
      bucket,
      sum(max_boxes) as total_boxes,
      sum(max_swabs) as total_swabs
    from max_prod
    group by bucket
  ),

  agg as (
    select
      bucket,
      -- nullif excludes efficiency=0 rows (shift-start noise where the PLC
      -- hasn't accumulated enough time for a meaningful figure yet).
      round(avg(nullif(efficiency, 0))::numeric, 1) as avg_uptime,
      round(avg(reject_rate)::numeric,           1) as avg_scrap,
      count(*)                                       as reading_count,
      count(distinct machine_id)                     as machine_count
    from src
    group by bucket
  )

  select
    a.bucket,
    coalesce(a.avg_uptime, 0)          as avg_uptime,
    coalesce(a.avg_scrap,  0)          as avg_scrap,
    coalesce(p.total_boxes, 0)::bigint as total_boxes,
    coalesce(p.total_swabs, 0)::bigint as total_swabs,
    a.machine_count,
    a.reading_count
  from agg a
  left join prod_totals p using (bucket)
  order by a.bucket
$$;

-- Grant execute to the roles used by the Supabase API keys.
grant execute on function get_fleet_trend(timestamptz, timestamptz, text)
  to anon, authenticated;
