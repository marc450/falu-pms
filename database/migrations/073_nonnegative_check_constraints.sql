-- ============================================================
-- Migration 073: Non-negative CHECK constraints on counters,
--                time durations, and rates
-- ============================================================
-- Adds CHECK constraints that reject writes with physically
-- impossible values (negative counts, negative durations,
-- negative rates). Catches PLC glitches and aggregation bugs at
-- the database boundary instead of letting garbage propagate to
-- KPI tiles.
--
-- Scope: lower bounds only (value >= 0).
-- Rates (efficiency, scrap_rate) are NOT capped at 100:
-- aggregation edge cases during restarts or anchor-lookup
-- transitions can legitimately produce transient values >100,
-- and we don't want the bridge to hit constraint violations
-- on real data.
--
-- All constraints use NOT VALID, which means:
--   * New writes are checked immediately (the safety net works).
--   * Existing rows are NOT scanned at ALTER time (migration is
--     fast and can't fail from historical oddities).
--   * To later verify historical data is clean, run:
--       ALTER TABLE <t> VALIDATE CONSTRAINT <c>;
--     for any constraint you want to fully enforce.
--
-- Idempotency: each ADD CONSTRAINT uses a DO block that checks
-- pg_constraint before adding, so this migration is safe to
-- re-run.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Helper: add a CHECK ... NOT VALID only if the named constraint
-- does not already exist on the table. Keeps the migration
-- idempotent.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.add_check_if_missing(
  p_table   text,
  p_name    text,
  p_check   text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = p_table AND c.conname = p_name
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
      p_table, p_name, p_check
    );
  END IF;
END;
$$;


-- ────────────────────────────────────────────────────────────
-- shift_readings
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_production_time_seconds_nonneg', 'production_time_seconds >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_idle_time_seconds_nonneg',       'idle_time_seconds       >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_error_time_seconds_nonneg',      'error_time_seconds      >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_produced_swabs_nonneg',          'produced_swabs          >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_packaged_swabs_nonneg',          'packaged_swabs          >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_produced_boxes_nonneg',          'produced_boxes          >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_produced_boxes_layer_plus_nonneg', 'produced_boxes_layer_plus >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_discarded_swabs_nonneg',         'discarded_swabs         >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_cotton_tears_nonneg',            'cotton_tears            >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_missing_sticks_nonneg',          'missing_sticks          >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_faulty_pickups_nonneg',          'faulty_pickups          >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_other_errors_nonneg',            'other_errors            >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_speed_nonneg',                   'speed                   >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_efficiency_nonneg',              'efficiency              >= 0');
SELECT pg_temp.add_check_if_missing('shift_readings', 'shift_readings_scrap_rate_nonneg',              'scrap_rate              >= 0');


-- ────────────────────────────────────────────────────────────
-- saved_shift_logs
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_production_time_seconds_nonneg', 'production_time_seconds >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_idle_time_seconds_nonneg',       'idle_time_seconds       >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_error_time_seconds_nonneg',      'error_time_seconds      >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_produced_swabs_nonneg',          'produced_swabs          >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_packaged_swabs_nonneg',          'packaged_swabs          >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_produced_boxes_nonneg',          'produced_boxes          >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_produced_boxes_layer_plus_nonneg', 'produced_boxes_layer_plus >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_discarded_swabs_nonneg',         'discarded_swabs         >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_cotton_tears_nonneg',            'cotton_tears            >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_missing_sticks_nonneg',          'missing_sticks          >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_faulty_pickups_nonneg',          'faulty_pickups          >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_other_errors_nonneg',            'other_errors            >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_efficiency_nonneg',              'efficiency              >= 0');
SELECT pg_temp.add_check_if_missing('saved_shift_logs', 'saved_shift_logs_scrap_rate_nonneg',              'scrap_rate              >= 0');


-- ────────────────────────────────────────────────────────────
-- hourly_analytics (delta columns + _end_ snapshot columns)
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_production_time_seconds_nonneg',     'production_time_seconds >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_idle_time_seconds_nonneg',           'idle_time_seconds       >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_error_time_seconds_nonneg',          'error_time_seconds      >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_swabs_produced_nonneg',              'swabs_produced          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_boxes_produced_nonneg',              'boxes_produced          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_discarded_swabs_nonneg',             'discarded_swabs         >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_cotton_tears_nonneg',                'cotton_tears            >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_missing_sticks_nonneg',              'missing_sticks          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_faulty_pickups_nonneg',              'faulty_pickups          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_other_errors_nonneg',                'other_errors            >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_reading_count_nonneg',               'reading_count           >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_avg_efficiency_nonneg',              'avg_efficiency          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_avg_scrap_rate_nonneg',              'avg_scrap_rate          >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_production_time_seconds_nonneg', 'end_production_time_seconds >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_idle_time_seconds_nonneg',       'end_idle_time_seconds       >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_error_time_seconds_nonneg',      'end_error_time_seconds      >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_produced_swabs_nonneg',          '_end_produced_swabs     >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_produced_boxes_nonneg',          '_end_produced_boxes     >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_discarded_swabs_nonneg',         '_end_discarded_swabs    >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_cotton_tears_nonneg',            '_end_cotton_tears       >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_missing_sticks_nonneg',          '_end_missing_sticks     >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_faulty_pickups_nonneg',          '_end_faulty_pickups     >= 0');
SELECT pg_temp.add_check_if_missing('hourly_analytics', 'hourly_analytics_end_other_errors_nonneg',            '_end_other_errors       >= 0');


-- ────────────────────────────────────────────────────────────
-- daily_machine_summary
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_production_time_seconds_nonneg', 'production_time_seconds >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_idle_time_seconds_nonneg',       'idle_time_seconds       >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_error_time_seconds_nonneg',      'error_time_seconds      >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_swabs_produced_nonneg',          'swabs_produced          >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_boxes_produced_nonneg',          'boxes_produced          >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_discarded_swabs_nonneg',         'discarded_swabs         >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_cotton_tears_nonneg',            'cotton_tears            >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_missing_sticks_nonneg',          'missing_sticks          >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_faulty_pickups_nonneg',          'faulty_pickups          >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_other_errors_nonneg',            'other_errors            >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_reading_count_nonneg',           'reading_count           >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_avg_efficiency_nonneg',          'avg_efficiency          >= 0');
SELECT pg_temp.add_check_if_missing('daily_machine_summary', 'daily_machine_summary_avg_scrap_rate_nonneg',          'avg_scrap_rate          >= 0');


-- ────────────────────────────────────────────────────────────
-- daily_fleet_summary
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_total_swabs_nonneg',           'total_swabs           >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_total_boxes_nonneg',           'total_boxes           >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_machine_count_nonneg',         'machine_count         >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_shift_count_nonneg',           'shift_count           >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_reading_count_nonneg',         'reading_count         >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_avg_uptime_nonneg',            'avg_uptime            >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_avg_scrap_nonneg',             'avg_scrap             >= 0');
SELECT pg_temp.add_check_if_missing('daily_fleet_summary', 'daily_fleet_summary_total_discarded_swabs_nonneg', 'total_discarded_swabs >= 0');


-- ────────────────────────────────────────────────────────────
-- error_events + error_shift_summary
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('error_events',        'error_events_duration_secs_nonneg',            'duration_secs IS NULL OR duration_secs >= 0');
SELECT pg_temp.add_check_if_missing('error_shift_summary', 'error_shift_summary_occurrence_count_nonneg',  'occurrence_count    >= 0');
SELECT pg_temp.add_check_if_missing('error_shift_summary', 'error_shift_summary_total_duration_secs_nonneg', 'total_duration_secs >= 0');


-- ────────────────────────────────────────────────────────────
-- machines (live-state columns the bridge writes every tick)
-- ────────────────────────────────────────────────────────────
SELECT pg_temp.add_check_if_missing('machines', 'machines_speed_nonneg',                'speed                >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_current_swabs_nonneg',        'current_swabs        >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_current_boxes_nonneg',        'current_boxes        >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_current_efficiency_nonneg',   'current_efficiency   >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_current_scrap_rate_nonneg',   'current_scrap_rate   >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_idle_time_seconds_nonneg',    'idle_time_seconds    >= 0');
SELECT pg_temp.add_check_if_missing('machines', 'machines_error_time_seconds_nonneg',   'error_time_seconds   >= 0');

COMMIT;
