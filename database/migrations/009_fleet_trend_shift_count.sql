-- Migration 009: Add shift_count to get_fleet_trend RPC
--
-- The analytics page now compares per-shift BU output against per-shift
-- targets.  To do this correctly for daily buckets (where multiple shifts
-- contribute), we need to know how many distinct shifts had data in each
-- bucket.  This replaces the previous function with one that includes
-- shift_count in the return type.

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
  reading_count bigint,
  shift_count   bigint
)
language sql
stable
as $$
  with src as (
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
      round(avg(nullif(efficiency, 0))::numeric, 1) as avg_uptime,
      round(avg(reject_rate)::numeric,           1) as avg_scrap,
      count(*)                                       as reading_count,
      count(distinct machine_id)                     as machine_count,
      count(distinct shift_number)                   as shift_count
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
    a.reading_count,
    a.shift_count
  from agg a
  left join prod_totals p using (bucket)
  order by a.bucket
$$;

grant execute on function get_fleet_trend(timestamptz, timestamptz, text)
  to anon, authenticated;
