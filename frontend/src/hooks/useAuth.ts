"use client";

import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, fetchCurrentUserRole } from "@/lib/supabase";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<"admin" | "viewer" | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sb = getSupabase();

    // Get initial session from localStorage
    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchCurrentUserRole(session.user.id).then((r) => {
          setRole(r);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    });

    // Subscribe to auth state changes (login / logout / token refresh)
    const {
      data: { subscription },
    } = sb.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchCurrentUserRole(session.user.id).then((r) => setRole(r));
      } else {
        setRole(null);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    const sb = getSupabase();
    await sb.auth.signOut();
  };

  return { session, user, role, isAdmin: role === "admin", loading, signOut };
}
