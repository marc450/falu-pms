-- ============================================================
-- Migration 074: Document saved_shift_logs table role
-- ============================================================
-- Captures the COMMENT ON TABLE statement that was run directly
-- against prod, so fresh customer builds get the same
-- documentation inline with the schema.
--
-- saved_shift_logs is the authoritative per-shift closeout
-- snapshot. One row per (machine, shift) at the moment the PLC
-- asserts the Save flag. It is the source of truth for all
-- historical analytics: get_machine_shift_summary,
-- get_fleet_trend path B, aggregate_daily_summary. Without this
-- table, every analytics query beyond the shift_readings live
-- window (last 48h by design) returns nothing.
--
-- COMMENT ON TABLE is idempotent (subsequent calls overwrite).
-- Safe to re-run. No behavior change; documentation only.
-- ============================================================

COMMENT ON TABLE saved_shift_logs IS
  'Authoritative per-shift closeout record. One row per (machine, shift), written by the bridge when the PLC asserts the Save flag at end-of-shift. Source of truth for all historical analytics (get_machine_shift_summary, get_fleet_trend path B, aggregate_daily_summary). Partnered with shift_readings for data newer than 48h.';
