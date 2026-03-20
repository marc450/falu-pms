-- Migration 049: normalise mixed-case team names in shift_assignments
-- Old "Fill past months" saved values like "Shift A/B/C/D" (sentence case).
-- Current config uses "SHIFT A/B/C/D" (uppercase). This one-time pass
-- rewrites every affected slot_teams JSONB array to the canonical casing so
-- the Crew Comparison dropdown no longer shows duplicate entries.

UPDATE shift_assignments
SET slot_teams = (
  SELECT jsonb_agg(
    CASE v
      WHEN 'Shift A' THEN '"SHIFT A"'::jsonb
      WHEN 'Shift B' THEN '"SHIFT B"'::jsonb
      WHEN 'Shift C' THEN '"SHIFT C"'::jsonb
      WHEN 'Shift D' THEN '"SHIFT D"'::jsonb
      ELSE CASE WHEN v IS NULL THEN 'null'::jsonb ELSE to_jsonb(v) END
    END
  )
  FROM jsonb_array_elements_text(slot_teams) AS v
)
WHERE slot_teams::text ~ '"Shift [ABCD]"';
