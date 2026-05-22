-- Per-language translation columns for the kiosk.
-- English remains in the base columns (description, cause, …). Arabic
-- ships in *_ar columns; the frontend coalesces back to English when the
-- translation is NULL so half-translated databases stay safe.

ALTER TABLE public.plc_error_codes
  ADD COLUMN IF NOT EXISTS description_ar                text,
  ADD COLUMN IF NOT EXISTS cause_ar                      text,
  ADD COLUMN IF NOT EXISTS operator_guidance_ar          text,
  ADD COLUMN IF NOT EXISTS technical_support_guidance_ar text;

ALTER TABLE public.checklist_items
  ADD COLUMN IF NOT EXISTS text_ar text;

ALTER TABLE public.checklist_item_steps
  ADD COLUMN IF NOT EXISTS description_ar text;
