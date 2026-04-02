-- Detailed error events (kept for ~48h, cleaned by bridge)
-- One row per error code per occurrence
CREATE TABLE IF NOT EXISTS error_events (
  id            BIGSERIAL PRIMARY KEY,
  machine_id    UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  machine_code  VARCHAR(50) NOT NULL,
  error_code    VARCHAR(10) NOT NULL,          -- e.g. 'A172', FK lookup to plc_error_codes
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,                   -- NULL while still active
  duration_secs INTEGER                        -- computed on close
);

CREATE INDEX IF NOT EXISTS idx_error_events_machine_started
  ON error_events (machine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_cleanup
  ON error_events (started_at);

-- Aggregated error summary per shift (permanent, small footprint)
-- One row per error code per machine per PLC shift per day
CREATE TABLE IF NOT EXISTS error_shift_summary (
  id               BIGSERIAL PRIMARY KEY,
  machine_id       UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  machine_code     VARCHAR(50) NOT NULL,
  shift_date       DATE NOT NULL,
  plc_shift        INTEGER NOT NULL,           -- 1, 2, or 3 (PLC shift number)
  error_code       VARCHAR(10) NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  total_duration_secs INTEGER NOT NULL DEFAULT 0,
  UNIQUE (machine_id, shift_date, plc_shift, error_code)
);

CREATE INDEX IF NOT EXISTS idx_error_shift_summary_lookup
  ON error_shift_summary (machine_id, shift_date DESC);
