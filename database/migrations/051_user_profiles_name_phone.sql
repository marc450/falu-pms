-- Add name and WhatsApp phone fields to user_profiles
ALTER TABLE user_profiles
  ADD COLUMN first_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN last_name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN whatsapp_phone TEXT;
