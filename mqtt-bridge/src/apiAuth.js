/**
 * Bridge API access control — see docs/GO_LIVE_US.md section H.
 *
 * Every customer runs their own bridge, but the bridge URL is baked into the
 * public frontend bundle, so it is effectively public knowledge. Without the
 * guards here, anyone who loads a customer's dashboard can also curl that
 * customer's entire production history from /api/export/*.
 *
 * Both guards are opt-in via env so the bridge can be deployed BEFORE the
 * frontend is rebuilt with a matching token. Roll out in this order:
 *   1. deploy bridge with neither var set  (nothing changes)
 *   2. set API_TOKEN + rebuild the frontend with NEXT_PUBLIC_API_TOKEN
 *   3. set ALLOWED_ORIGINS to the customer's domain
 *
 * Caveat, deliberately recorded here: NEXT_PUBLIC_API_TOKEN ships inside a
 * public JS bundle, so this is not real authentication — it stops opportunistic
 * and automated access, not someone who opens the dashboard and reads the
 * bundle. The durable fix is verifying the user's Supabase JWT instead.
 *
 * Kept in its own module so the logic is unit-testable without booting the
 * bridge (which needs MQTT + Supabase). See scripts/test-api-auth.js.
 */

/** Routes that stay reachable without a token. */
const PUBLIC_PATHS = new Set(["/api/health"]);

/**
 * CORS options honouring an allowlist.
 *
 * A request carrying no Origin header (curl, Railway health check, the CI smoke
 * test) is always allowed: CORS is a browser-side control and cannot gate those
 * anyway — that is what the token gate is for. An empty allowlist keeps the
 * previous permissive behaviour so enabling this is a deliberate step.
 */
function makeCorsOptions(allowedOrigins) {
  const allow = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return {
    origin: (origin, cb) => {
      if (allow.length === 0) return cb(null, true);
      if (!origin) return cb(null, true);
      if (allow.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  };
}

/**
 * Bearer-token gate for /api/*. Mount AFTER cors() so browser preflight
 * (OPTIONS) is answered by the cors middleware and never reaches this check.
 *
 * An empty token means "not yet rolled out on this bridge" and lets everything
 * through, so deploying the bridge ahead of the frontend cannot break a live
 * dashboard. /api/health stays open either way — Railway and the uptime monitor
 * poll it without credentials and it exposes no production data.
 */
function makeTokenGate(apiToken) {
  return function tokenGate(req, res, next) {
    if (!apiToken) return next();
    const path = (req.originalUrl || req.url).split("?")[0];
    if (PUBLIC_PATHS.has(path)) return next();
    const header = req.get ? req.get("authorization") : req.headers.authorization;
    const value = header || "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    if (token !== apiToken) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };
}

/** Parse a comma-separated ALLOWED_ORIGINS value into a clean array. */
function parseOrigins(raw) {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

module.exports = { makeCorsOptions, makeTokenGate, parseOrigins, PUBLIC_PATHS };
