/**
 * Data-quality monitor — escalation layer.
 *
 * The deterministic detection runs in Postgres (pg_cron job
 * `data-quality-check`, migration 095): it records a row in
 * `data_quality_alerts` whenever a core invariant breaks (a machine
 * reporting more production_time_seconds than the bucket window can
 * hold, or fleet uptime over 100%). That is the duplicate-publisher /
 * bad-source signature that produced Avg Uptime >100%.
 *
 * This module is the cheap-until-incident half: it polls for new
 * alerts, and ONLY when something fires does it ask Claude for a
 * plain-language root-cause report and post it to Slack. No alerts =
 * no LLM call = no cost.
 *
 * Wired into the bridge in index.js via startDataQualityMonitor().
 * Reuses the bridge's service-role Supabase client and winston logger.
 */

const AnthropicPkg = require("@anthropic-ai/sdk");
const Anthropic = AnthropicPkg.Anthropic || AnthropicPkg.default || AnthropicPkg;

// ── config (env, with sensible defaults) ────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SLACK_WEBHOOK_URL  = process.env.SLACK_WEBHOOK_URL || "";
const DQ_MODEL           = process.env.DQ_MODEL || "claude-sonnet-4-6";
const DQ_COOLDOWN_MIN    = parseInt(process.env.DQ_COOLDOWN_MIN || "30", 10);
const DQ_INTERVAL_MS     = parseInt(process.env.DQ_CHECK_INTERVAL_MS || "120000", 10); // 2 min
const DQ_ENABLED         = (process.env.DQ_MONITOR_ENABLED || "true") === "true";
const PROD_SECONDS_MAX   = parseInt(process.env.DQ_PROD_SECONDS_MAX || "330", 10);

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `You are a data-quality analyst for FALU PMS, a factory production-monitoring system.

Background you can rely on:
- Machine counters (production_time_seconds, produced_swabs, etc.) are monotonic per shift and feed 5-minute analytics buckets. Each bucket's value is a delta within a 300-second window.
- Therefore production_time_seconds > 300 for a single machine in one 5-minute bucket is PHYSICALLY IMPOSSIBLE as a real counter delta. Fleet "uptime" = sum(production_time_seconds) / (machine_count * 300) * 100, so values over 100% are equally impossible.
- When these impossible values appear, the bucket math is NOT the bug — it faithfully reports the delta. The cause is upstream, almost always one of:
  1. MULTIPLE PUBLISHERS feeding the same machines at once (e.g. duplicate simulator/PLC bridge processes, or extra Railway replicas/deployments overlapping). Signature: many machines affected together, counters advancing several times faster than wall-clock, readings arriving in sub-second bursts. THIS IS THE MOST COMMON CAUSE.
  2. Stale anchor after a reporting gap: a machine stopped reporting, then resumed, dumping accumulated time into one bucket. Signature: isolated to a machine that had a gap.
  3. Reset-branch misfire at a shift boundary.
- A single isolated bad bucket often coincides with a deploy/restart swap (old + new process briefly overlap) and is a transient blip. Many consecutive bad buckets means a live duplicate publisher that needs action.

Write a SHORT Slack-ready incident report (Slack mrkdwn, no big headers). Include: one line on what's wrong, the single most likely root cause given the evidence, severity (transient blip vs live incident), and a concrete next action (e.g. "check Railway: Simulator/Bridge replica count and for duplicate deployments"). Be precise and calm. Do not invent numbers beyond the data given.`;

// ── helpers ─────────────────────────────────────────────────────────────────

async function gatherDiagnostics(supabase, alerts) {
  // Distinct affected buckets, sorted
  const bucketTimes = [...new Set(alerts.map((a) => a.bucket_ts))].sort();
  const firstBucket = bucketTimes[0];
  const lastBucket = bucketTimes[bucketTimes.length - 1];

  // Per-machine offending rows across the affected buckets
  const { data: offending, error } = await supabase
    .from("bucket_analytics_5m")
    .select("bucket_ts, machine_code, production_time_seconds, reading_count, swabs_produced")
    .in("bucket_ts", bucketTimes)
    .gt("production_time_seconds", PROD_SECONDS_MAX)
    .order("production_time_seconds", { ascending: false })
    .limit(40);

  if (error) throw new Error(`diagnostics query failed: ${error.message}`);

  // Consecutive-bucket span: 1 bucket => likely transient; many => sustained
  const spanMin =
    (new Date(lastBucket).getTime() - new Date(firstBucket).getTime()) / 60000;

  return {
    affectedBuckets: bucketTimes.length,
    firstBucket,
    lastBucket,
    spanMinutes: spanMin,
    offending: offending || [],
  };
}

function buildUserContent(alerts, diag) {
  const lines = [];
  lines.push(`New data-quality alerts: ${alerts.length}`);
  lines.push(`Affected 5-minute buckets: ${diag.affectedBuckets} (from ${diag.firstBucket} to ${diag.lastBucket}, spanning ${diag.spanMinutes} min)`);
  lines.push(`Production-time threshold flagged: > ${PROD_SECONDS_MAX}s in a 300s window`);
  lines.push("");
  lines.push("Alert summary rows:");
  for (const a of alerts.slice(0, 20)) {
    lines.push(`  - ${a.bucket_ts} | ${a.check_type} | severity=${a.severity} | machines_affected=${a.machines_affected} | worst=${a.worst_machine_code}(${a.worst_value}) | fleet_uptime=${a.fleet_uptime_pct}%`);
  }
  lines.push("");
  lines.push("Worst per-machine bucket rows (production_time_seconds is the delta inside a 300s window):");
  for (const r of diag.offending.slice(0, 20)) {
    lines.push(`  - ${r.bucket_ts} | ${r.machine_code} | prod=${r.production_time_seconds}s | readings=${r.reading_count} | swabs=${r.swabs_produced}`);
  }
  return lines.join("\n");
}

async function generateReport(alerts, diag) {
  if (!anthropic) return null;
  const resp = await anthropic.messages.create({
    model: DQ_MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(alerts, diag) }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function postToSlack(text) {
  const resp = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Slack webhook ${resp.status}: ${body.slice(0, 200)}`);
  }
}

function severityOf(alerts) {
  return alerts.some((a) => a.severity === "critical") ? "critical" : "warning";
}

// ── main cycle ──────────────────────────────────────────────────────────────

async function runOnce(supabase, logger) {
  // 1. New alerts only
  const { data: alerts, error } = await supabase
    .from("data_quality_alerts")
    .select("*")
    .eq("status", "new")
    .order("bucket_ts", { ascending: true });

  if (error) {
    logger.error(`[dq-monitor] fetch new alerts failed: ${error.message}`);
    return;
  }
  if (!alerts || alerts.length === 0) return; // cheap path: nothing to do

  // 2. Cooldown: don't message again within DQ_COOLDOWN_MIN of the last send.
  const { data: lastSent } = await supabase
    .from("data_quality_alerts")
    .select("notified_at")
    .not("notified_at", "is", null)
    .order("notified_at", { ascending: false })
    .limit(1);

  if (lastSent && lastSent[0] && lastSent[0].notified_at) {
    const sinceMin = (Date.now() - new Date(lastSent[0].notified_at).getTime()) / 60000;
    if (sinceMin < DQ_COOLDOWN_MIN) {
      logger.info(`[dq-monitor] ${alerts.length} new alert(s), but in cooldown (${sinceMin.toFixed(1)}/${DQ_COOLDOWN_MIN} min) — deferring`);
      return;
    }
  }

  logger.info(`[dq-monitor] ${alerts.length} new alert(s) — investigating`);

  // 3. Diagnostics + report
  let report = null;
  try {
    const diag = await gatherDiagnostics(supabase, alerts);
    report = await generateReport(alerts, diag);
  } catch (e) {
    logger.error(`[dq-monitor] report generation failed: ${e.message}`);
  }

  // 4. Compose + send to Slack
  const sev = severityOf(alerts);
  const buckets = [...new Set(alerts.map((a) => a.bucket_ts))];
  const header =
    `:rotating_light: *FALU data-quality alert* (${sev})\n` +
    `${alerts.length} alert(s) across ${buckets.length} bucket(s). ` +
    `Latest: ${alerts[alerts.length - 1].bucket_ts}.`;
  const body = report
    ? `${header}\n\n${report}`
    : `${header}\n\n(Automated report unavailable — check ANTHROPIC_API_KEY. Raw: worst machine ` +
      `${alerts[alerts.length - 1].worst_machine_code} at ${alerts[alerts.length - 1].worst_value}, ` +
      `fleet uptime ${alerts[alerts.length - 1].fleet_uptime_pct}%.)`;

  if (!SLACK_WEBHOOK_URL) {
    logger.warn(`[dq-monitor] SLACK_WEBHOOK_URL unset — ${alerts.length} alert(s) recorded but not delivered`);
    return;
  }

  try {
    await postToSlack(body);
  } catch (e) {
    logger.error(`[dq-monitor] Slack send failed: ${e.message}`);
    return; // leave alerts as 'new' so the next eligible cycle retries
  }

  // 5. Mark the batch notified (store the report on each)
  const ids = alerts.map((a) => a.id);
  const { error: updErr } = await supabase
    .from("data_quality_alerts")
    .update({ status: "notified", notified_at: new Date().toISOString(), report })
    .in("id", ids);

  if (updErr) {
    logger.error(`[dq-monitor] mark notified failed: ${updErr.message}`);
  } else {
    logger.info(`[dq-monitor] notified ${ids.length} alert(s) via Slack`);
  }
}

// ── public entrypoint ───────────────────────────────────────────────────────

function startDataQualityMonitor({ supabase, logger }) {
  if (!DQ_ENABLED) {
    logger.info("[dq-monitor] disabled (DQ_MONITOR_ENABLED=false)");
    return;
  }
  // Gate activation on the webhook so deploying this code is inert until the
  // migration is run and secrets are set — avoids polling a missing table.
  if (!SLACK_WEBHOOK_URL) {
    logger.info("[dq-monitor] inactive — set SLACK_WEBHOOK_URL (and ANTHROPIC_API_KEY) to enable");
    return;
  }
  if (!ANTHROPIC_API_KEY) logger.warn("[dq-monitor] ANTHROPIC_API_KEY unset — alerts will be sent without a Claude report");

  logger.info(`[dq-monitor] enabled — polling every ${Math.round(DQ_INTERVAL_MS / 1000)}s, model ${DQ_MODEL}, cooldown ${DQ_COOLDOWN_MIN} min`);

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      await runOnce(supabase, logger);
    } catch (e) {
      logger.error(`[dq-monitor] cycle error: ${e.message}`);
    } finally {
      running = false;
    }
  };

  tick(); // run once on startup
  setInterval(tick, DQ_INTERVAL_MS);
}

module.exports = { startDataQualityMonitor };
