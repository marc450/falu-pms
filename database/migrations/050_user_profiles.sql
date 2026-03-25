-- User profiles with role-based access (admin / viewer)
CREATE TABLE user_profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read profiles (needed to check own role)
CREATE POLICY "auth_read_profiles"
  ON user_profiles FOR SELECT TO authenticated USING (true);

-- Only admins can insert new profiles
CREATE POLICY "admin_insert_profiles"
  ON user_profiles FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Only admins can update profiles
CREATE POLICY "admin_update_profiles"
  ON user_profiles FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Only admins can delete profiles
CREATE POLICY "admin_delete_profiles"
  ON user_profiles FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Service role full access (Edge Functions use this)
CREATE POLICY "service_full_profiles"
  ON user_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
