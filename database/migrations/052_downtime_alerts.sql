-- Migration 052: Downtime alert notification log + default config
-- ============================================================================
--
-- Adds a notification_log table to track WhatsApp alerts sent to mechanics
-- when machines stay in error state beyond a configurable threshold.
--
-- The bridge (Node.js) sends alerts via Twilio and logs them here.
-- ============================================================================

-- ── 1. notification_log table ───────────────────────────────────────────────

CREATE TABLE notification_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id    UUID REFERENCES machines(id),
  machine_code  TEXT NOT NULL,
  mechanic_id   UUID,
  phone         TEXT,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'sent',   -- sent | failed
  error_detail  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_log_machine ON notification_log(machine_id, created_at DESC);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- Service role (bridge) can do everything
CREATE POLICY "service_write_notif"
  ON notification_log FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated users can read (for future notification history UI)
CREATE POLICY "auth_read_notif"
  ON notification_log FOR SELECT TO authenticated
  USING (true);


-- ── 2. Default alert config in app_settings ─────────────────────────────────

INSERT INTO app_settings (key, value) VALUES
  ('downtime_alert_config', '{"enabled": false, "threshold_minutes": 10}')
ON CONFLICT (key) DO NOTHING;
