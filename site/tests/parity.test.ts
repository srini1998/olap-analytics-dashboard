// Runs the Python suite's golden queries through sql.js with the shared schema/query files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { RaceDB, eventTime, type RaceEvent } from "../src/engine/race.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const stream = JSON.parse(read("data/monza-2024.stream.json"));
const golden = JSON.parse(read("tests/golden/race-queries.json"));
const SQL = await initSqlJs();
const fresh = () => new RaceDB(SQL, read("shared/race_schema.sql"), read("shared/race_queries.sql"), stream.drivers);
const events: RaceEvent[] = stream.events;

function full(evts = events) {
  const db = fresh();
  for (let i = 0; i < evts.length; i += 50) db.ingest(evts.slice(i, i + 50));
  return db;
}

test("every golden query matches the Python sqlite3 output", () => {
  const db = full();
  for (const g of golden) assert.deepEqual(db.query(g.query, g.params), g.rows, `${g.query} ${JSON.stringify(g.params)}`);
});

test("duplicates are no-ops and a conflict rolls back the whole batch", () => {
  const db = full(events.slice(0, -1));
  assert.deepEqual(db.ingest(events.slice(0, 10)), { inserted: 0, duplicates: 10 });
  const last = events[events.length - 1];
  assert.throws(() => db.ingest([last, { ...events[0], t: 99 }]), /Conflicting/);
  assert.equal(db.db.exec("SELECT COUNT(*) FROM fact_lap WHERE event_id = ?", [last.event_id])[0].values[0][0], 0);
  assert.equal(db.stats.rejected_batches, 1);
});

test("out-of-order delivery gives the same answers", () => {
  const shuffled = [...events];
  let seed = 7;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const a = full();
  const b = full(shuffled);
  for (const q of ["tower", "lapchart", "degradation"]) assert.deepEqual(a.query(q, { as_of: 2500 }), b.query(q, { as_of: 2500 }));
});

test("time travel equals partial ingest", () => {
  const a = full();
  const b = full(events.filter((e) => eventTime(e) <= 1500));
  assert.deepEqual(a.query("tower", { as_of: 1500 }), b.query("tower", { as_of: 1500 }));
});

test("rejects unknown groups, params and malformed events", () => {
  const db = full();
  assert.throws(() => db.query("rollup", { as_of: 1, grp: "team'--", lap_from: 1, lap_to: 2, clean_only: 0 }));
  assert.throws(() => db.query("tower", {}));
  assert.throws(() => db.ingest([{ type: "lap", event_id: "x", driver_number: 1, lap_number: 1, t_end: 1, lap_s: NaN, pit_out: 0 }]));
});
