import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    // Get caller's user ID from their JWT
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );
    const {
      data: { user: caller },
    } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));

    if (!caller) {
      return json({ error: "Invalid token" }, 401);
    }

    // Verify caller is admin
    const { data: callerProfile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("id", caller.id)
      .single();

    if (!callerProfile || callerProfile.role !== "admin") {
      return json({ error: "Admin access required" }, 403);
    }

    const { email, role, first_name, last_name, mechanic_phone, redirect_to } =
      await req.json();

    if (!email) {
      return json({ error: "Email is required" }, 400);
    }

    if (!first_name || !last_name) {
      return json({ error: "First name and last name are required" }, 400);
    }

    if (role && !["admin", "viewer"].includes(role)) {
      return json({ error: "Invalid role" }, 400);
    }

    // Supabase validates redirect_to against the Auth redirect allowlist,
    // so passing it through from the client is safe.
    const inviteOptions = redirect_to ? { redirectTo: redirect_to } : undefined;

    let userId: string;
    // true when an invite email actually went out this call
    let invited = false;

    const { data: inviteData, error: inviteError } =
      await supabase.auth.admin.inviteUserByEmail(email, inviteOptions);

    if (inviteError) {
      if (inviteError.message.includes("already been registered")) {
        const { data: listData } = await supabase.auth.admin.listUsers();
        const existing = listData?.users?.find(
          (u: { email?: string }) => u.email === email
        );
        if (!existing) {
          return json({ error: "User exists but could not be found" }, 400);
        }

        if (!existing.last_sign_in_at) {
          // Pending invite that was never accepted: recreate the auth user
          // so a fresh invite email goes out (GoTrue refuses to re-invite
          // an existing address). The profile row is upserted again below.
          await supabase.auth.admin.deleteUser(existing.id);
          const { data: reinvite, error: reinviteError } =
            await supabase.auth.admin.inviteUserByEmail(email, inviteOptions);
          if (reinviteError) {
            return json({ error: reinviteError.message }, 400);
          }
          userId = reinvite.user.id;
          invited = true;
        } else {
          // Active account: just (re)attach the profile, no email
          userId = existing.id;
        }
      } else {
        return json({ error: inviteError.message }, 400);
      }
    } else {
      userId = inviteData.user.id;
      invited = true;
    }

    // Insert profile row (upsert to handle re-adding)
    const profileData: Record<string, unknown> = {
      id: userId,
      email,
      role: role || "viewer",
      first_name,
      last_name,
    };
    if (mechanic_phone) {
      profileData.mechanic_phone = mechanic_phone;
    }

    const { error: profileError } = await supabase
      .from("user_profiles")
      .upsert(profileData, { onConflict: "id" });

    if (profileError) {
      // Only rollback the auth user if this call created it
      if (invited) {
        await supabase.auth.admin.deleteUser(userId);
      }
      return json(
        { error: "Failed to create profile: " + profileError.message },
        500
      );
    }

    return json(
      {
        id: userId,
        email,
        role: role || "viewer",
        first_name,
        last_name,
        mechanic_phone: mechanic_phone || null,
        invited,
      },
      201
    );
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
