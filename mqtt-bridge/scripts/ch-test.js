#!/usr/bin/env node
/**
 * ClickHouse connection + table sanity check.
 *
 * Read-only by default: verifies credentials, that the service is reachable,
 * that the `shift_readings` table exists, prints its columns, and shows the
 * current row count + newest row.
 *
 * Usage:
 *   node scripts/ch-test.js            # connect + verify table (no writes)
 *   node scripts/ch-test.js --insert   # also insert ONE marked test row
 *
 * The test row uses machine_code = '__CH_TEST__' so you can find/delete it:
 *   ALTER TABLE shift_readings DELETE WHERE machine_code = '__CH_TEST__';
 *
 * This script does NOT require CLICKHOUSE_ENABLED=true — it reads the
 * CLICKHOUSE_* vars directly so you can test before flipping the live bridge.
 */
require("dotenv").config();
const { createClient } = require("@clickhouse/client");

const TABLE = "shift_readings";
const doInsert = process.argv.includes("--insert");

function fail(msg, err) {
  console.error(`\n❌ ${msg}`);
  if (err) console.error(`   ${err.message || err}`);
  process.exit(1);
}

(async () => {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) fail("CLICKHOUSE_URL is not set in .env");

  console.log(`\nConnecting to: ${url}`);
  console.log(`Database:      ${process.env.CLICKHOUSE_DB || "default"}`);
  console.log(`User:          ${process.env.CLICKHOUSE_USER || "default"}\n`);

  const client = createClient({
    url,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: process.env.CLICKHOUSE_DB || "default",
  });

  // 1) Reachable + credentials valid
  const ping = await client.ping().catch((e) => ({ success: false, error: e }));
  if (!ping.success) fail("Could not reach ClickHouse (check URL / password)", ping.error);
  console.log("✅ Connected and authenticated");

  // 2) Table exists?
  let exists;
  try {
    const rs = await client.query({
      query: `SELECT count() AS n FROM system.tables
              WHERE database = {db:String} AND name = {tbl:String}`,
      query_params: { db: process.env.CLICKHOUSE_DB || "default", tbl: TABLE },
      format: "JSONEachRow",
    });
    exists = Number((await rs.json())[0]?.n || 0) > 0;
  } catch (e) {
    fail("Failed to query system.tables", e);
  }
  if (!exists) {
    fail(`Table '${TABLE}' does not exist — run database/clickhouse/001_shift_readings.sql first`);
  }
  console.log(`✅ Table '${TABLE}' exists`);

  // 3) Show columns
  try {
    const rs = await client.query({
      query: `SELECT name, type FROM system.columns
              WHERE database = {db:String} AND table = {tbl:String} ORDER BY position`,
      query_params: { db: process.env.CLICKHOUSE_DB || "default", tbl: TABLE },
      format: "JSONEachRow",
    });
    const cols = await rs.json();
    console.log(`\n   Columns (${cols.length}):`);
    for (const c of cols) console.log(`     - ${c.name}: ${c.type}`);
  } catch (e) {
    fail("Failed to read columns", e);
  }

  // 4) Optional: insert one marked test row
  if (doInsert) {
    const nowIso = new Date().toISOString();
    try {
      await client.insert({
        table: TABLE,
        format: "JSONEachRow",
        values: [{
          machine_id: "00000000-0000-0000-0000-000000000000",
          machine_code: "__CH_TEST__",
          shift_crew: "Unassigned",
          status: "running",
          speed: 0,
          production_time_seconds: 0,
          idle_time_seconds: 0,
          error_time_seconds: 0,
          cotton_tears: 0, missing_sticks: 0, faulty_pickups: 0, other_errors: 0,
          produced_swabs: 0, packaged_swabs: 0, produced_boxes: 0,
          produced_boxes_layer_plus: 0, discarded_swabs: 0,
          efficiency: 0, scrap_rate: 0, save_flag: 0,
          raw_payload: JSON.stringify({ test: true, at: nowIso }),
          plc_timestamp: null,
          ingested_at: nowIso,
        }],
      });
      console.log("\n✅ Inserted one test row (machine_code = '__CH_TEST__')");
      console.log("   Remove it later with:");
      console.log("     ALTER TABLE shift_readings DELETE WHERE machine_code = '__CH_TEST__';");
    } catch (e) {
      fail("Test insert failed", e);
    }
  }

  // 5) Row count + newest
  try {
    const rs = await client.query({
      query: `SELECT count() AS rows, max(ingested_at) AS newest FROM ${TABLE}`,
      format: "JSONEachRow",
    });
    const r = (await rs.json())[0] || {};
    console.log(`\n   Rows in table: ${r.rows}`);
    console.log(`   Newest row:    ${r.newest || "(none yet)"}`);
  } catch (e) {
    fail("Failed to read row count", e);
  }

  await client.close();
  console.log("\n✅ All checks passed.\n");
  process.exit(0);
})().catch((e) => fail("Unexpected error", e));
