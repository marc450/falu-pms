-- Rename user_profiles.whatsapp_phone to mechanic_phone.
-- The downtime alert channel moved from WhatsApp to plain SMS (both via Twilio),
-- so the column name should be channel-neutral.

ALTER TABLE public.user_profiles
  RENAME COLUMN whatsapp_phone TO mechanic_phone;
