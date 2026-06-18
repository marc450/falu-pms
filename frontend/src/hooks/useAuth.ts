"use client";

import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, fetchCurrentUserProfile } from "@/lib/supabase";
import type { UserProfile } from "@/lib/supabase";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async (userId: string) => {
    const p = await fetchCurrentUserProfile(userId);
    setProfile(p);
    return p;
  };

  useEffect(() => {
    const sb = getSupabase();

    // Get initial session from localStorage
    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // Subscribe to auth state changes (login / logout / token refresh).
    // For a logged-in session we must AWAIT the profile load before clearing
    // `loading` — otherwise consumers (e.g. the admin gate in AuthLayout) run
    // with profile=null and misclassify an admin as a viewer, bouncing them
    // off /settings to / on reload.
    const {
      data: { subscription },
    } = sb.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    const sb = getSupabase();
    await sb.auth.signOut();
  };

  const refreshProfile = async () => {
    if (user) await loadProfile(user.id);
  };

  return {
    session,
    user,
    profile,
    role: profile?.role ?? null,
    isAdmin: profile?.role === "admin",
    loading,
    signOut,
    refreshProfile,
  };
}
