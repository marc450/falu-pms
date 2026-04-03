-- RPC function to fetch error shift summary data in a single call
-- Bypasses the 1000-row PostgREST limit and returns all matching rows
-- Also merges in recent error_events not yet aggregated into shift summary

CREATE OR REPLACE FUNCTION get_error_shift_summary(start_date DATE, end_date DATE)
RETURNS TABLE (
  machine_id       UUID,
  machine_code     VARCHAR(50),
  shift_date       DATE,
  plc_shift        INTEGER,
  error_code       VARCHAR(10),
  occurrence_count INTEGER,
  total_duration_secs INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  -- Main aggregated data
  SELECT
    s.machine_id, s.machine_code, s.shift_date, s.plc_shift,
    s.error_code, s.occurrence_count, s.total_duration_secs
  FROM error_shift_summary s
  WHERE s.shift_date >= start_date AND s.shift_date <= end_date

  UNION ALL

  -- Recent error_events not yet in shift summary (for real-time data)
  SELECT
    e.machine_id,
    e.machine_code,
    e.started_at::DATE AS shift_date,
    (EXTRACT(HOUR FROM e.started_at)::INTEGER / 8 + 1) AS plc_shift,
    e.error_code,
    COUNT(*)::INTEGER AS occurrence_count,
    COALESCE(SUM(e.duration_secs), 0)::INTEGER AS total_duration_secs
  FROM error_events e
  WHERE e.started_at::DATE >= start_date
    AND e.started_at::DATE <= end_date
    -- Exclude dates+codes already covered by shift summary
    AND NOT EXISTS (
      SELECT 1 FROM error_shift_summary s2
      WHERE s2.machine_id = e.machine_id
        AND s2.shift_date = e.started_at::DATE
        AND s2.error_code = e.error_code
    )
  GROUP BY e.machine_id, e.machine_code, e.started_at::DATE, e.error_code;
END;
$$;
