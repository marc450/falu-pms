#!/usr/bin/env node
/**
 * Unit test for the bridge API access control (docs/GO_LIVE_US.md section H).
 *
 * Boots a throwaway express app wired with the SAME middleware the bridge uses
 * (src/apiAuth.js) and asserts the behaviour that matters:
 *   - token unset  → everything still reachable (safe rollout, nothing breaks)
 *   - token set    → /api/* needs a correct Bearer token, /api/health does not
 *   - exports      → protected (this is the endpoint that leaks a whole history)
 *   - CORS         → allowlisted origin echoed, foreign origin refused,
 *                    no-Origin requests (curl, health checks, CI) still allowed
 *
 *   node scripts/test-api-auth.js
 *   npm run test:auth
 *
 * Exits non-zero on the first failure.
 */
const express = require("express");
const cors = require("cors");
const { makeCorsOptions, makeTokenGate, parseOrigins } = require("../src/apiAuth");

const TOKEN = "test-token-abc123";
const ORIGIN_OK = "https://usc.falu.app";
const ORIGIN_BAD = "https://competitor.example.com";

/** Boot an app with the given config on an ephemeral port. */
function boot({ token, origins }) {
  const app = express();
  app.use(cors(makeCorsOptions(parseOrigins(origins))));
  app.use(express.json());
  app.use("/api", makeTokenGate(token));
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/machines", (req, res) => res.json([{ machine_code: "CB-30" }]));
  app.get("/api/export/machines-daily", (req, res) => res.json([{ date: "2026-08-01" }]));
  // cors() rejects a foreign origin by throwing; express surfaces that as 500
  // unless handled. Mirror a sane error response so the test sees a clear code.
  app.use((err, req, res, _next) => res.status(403).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${actual}, want ${expected})`}`);
}

async function get(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return res;
}

(async () => {
  // ── Phase 1: nothing configured — the pre-rollout state ────────────────────
  console.log("\ntoken unset, no origin allowlist (rollout step 1: nothing changes)");
  {
    const { server, port } = await boot({ token: "", origins: "" });
    check("/api/health reachable",   (await get(port, "/api/health")).status, 200);
    check("/api/machines reachable", (await get(port, "/api/machines")).status, 200);
    check("/api/export reachable",   (await get(port, "/api/export/machines-daily")).status, 200);
    check("foreign origin allowed",
      (await get(port, "/api/machines", { Origin: ORIGIN_BAD })).status, 200);
    server.close();
  }

  // ── Phase 2: token enforced ───────────────────────────────────────────────
  console.log("\ntoken set (rollout step 2)");
  {
    const { server, port } = await boot({ token: TOKEN, origins: "" });
    check("/api/health still open (Railway polls it)",
      (await get(port, "/api/health")).status, 200);
    check("/api/machines without token → 401",
      (await get(port, "/api/machines")).status, 401);
    check("/api/machines with wrong token → 401",
      (await get(port, "/api/machines", { Authorization: "Bearer wrong" })).status, 401);
    check("/api/machines with bare token (no Bearer) → 401",
      (await get(port, "/api/machines", { Authorization: TOKEN })).status, 401);
    check("/api/machines with correct token → 200",
      (await get(port, "/api/machines", { Authorization: `Bearer ${TOKEN}` })).status, 200);
    check("/api/export without token → 401",
      (await get(port, "/api/export/machines-daily")).status, 401);
    check("/api/export with correct token → 200",
      (await get(port, "/api/export/machines-daily", { Authorization: `Bearer ${TOKEN}` })).status, 200);
    check("query string does not bypass the gate",
      (await get(port, "/api/export/machines-daily?start=2026-01-01")).status, 401);
    check("health with query string still open",
      (await get(port, "/api/health?probe=1")).status, 200);
    server.close();
  }

  // ── Phase 3: token + origin allowlist ─────────────────────────────────────
  console.log("\ntoken set + origin allowlist (rollout step 3)");
  {
    const { server, port } = await boot({ token: TOKEN, origins: `${ORIGIN_OK}, http://localhost:3000` });
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const okRes = await get(port, "/api/machines", { ...auth, Origin: ORIGIN_OK });
    check("allowlisted origin → 200", okRes.status, 200);
    check("allowlisted origin echoed back",
      okRes.headers.get("access-control-allow-origin"), ORIGIN_OK);

    check("foreign origin refused", (await get(port, "/api/machines", { ...auth, Origin: ORIGIN_BAD })).status, 403);
    check("localhost dev origin → 200",
      (await get(port, "/api/machines", { ...auth, Origin: "http://localhost:3000" })).status, 200);

    // curl / Railway health check / CI smoke test send no Origin header.
    const noOrigin = await get(port, "/api/machines", auth);
    check("no-Origin request still allowed (curl, CI, health checks)", noOrigin.status, 200);
    server.close();
  }

  console.log(failures === 0
    ? "\nAll API access-control checks passed.\n"
    : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
