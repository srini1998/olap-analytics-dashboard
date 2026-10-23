// Browser twin of src/race_stream.py: same schema file, same query file, same ingest rules.
// tests/parity.test.ts runs every golden query from the Python suite through sql.js.
import type { Database, SqlJsStatic } from "sql.js";

export type EventType = "lap" | "pit" | "stint";
export interface RaceEvent {
  type: EventType;
  event_id: string;
  driver_number: number;
  [k: string]: unknown;
}
export interface Driver { driver_number: number; code: string; name: string; team: string; colour: string }
export type Row = Record<string, string | number | null>;
export interface Query { sql: string; params: string[] }

export const GROUPS = ["driver", "team", "compound", "stint", "lap_window"] as const;
export const MAX_BATCH = 5000;
const LAP_COLS = ["event_id", "driver_number", "lap_number", "t_end", "lap_s", "s1", "s2", "s3", "pit_out", "st_speed"];
const PIT_COLS = ["event_id", "driver_number", "lap_number", "t", "pit_s"];
const STINT_COLS = ["event_id", "driver_number", "stint_number", "lap_start", "compound", "tyre_age_at_start", "t"];
const TABLES: Record<EventType, [string, string[]]> = {
  lap: ["fact_lap", LAP_COLS],
  pit: ["fact_pit", PIT_COLS],
  stint: ["dim_stint", STINT_COLS],
};
const COMPOUNDS = new Set(["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"]);

export function loadQueries(text: string): Record<string, Query> {
  const parts = text.split(/^-- name: (\w+)\s*$/m);
  const raw: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) raw[parts[i]] = parts[i + 1];
  const base = raw.base.trim();
  delete raw.base;
  const out: Record<string, Query> = {};
  for (const [name, body] of Object.entries(raw)) {
    const m = body.match(/^-- params: (.+)$/m);
    const params = m ? m[1].split(",").map((p) => p.trim()) : [];
    const sql = body.trim().split("\n").filter((l) => !l.startsWith("--")).join("\n").replace("{{base}}", base);
    out[name] = { sql, params };
  }
  return out;
}

export const eventTime = (e: RaceEvent) => (e.type === "lap" ? (e.t_end as number) : (e.t as number));

const num = (v: unknown, lo: number, hi: number, nullable = false) =>
  (nullable && v == null) || (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi);

export function validateEvent(e: RaceEvent) {
  if (!(e.type in TABLES)) throw new Error("Unknown event type");
  if (typeof e.event_id !== "string" || e.event_id.length < 1 || e.event_id.length > 80) throw new Error("Invalid event id");
  if (!num(e.driver_number, 1, 99)) throw new Error("Invalid driver");
  let ok: boolean;
  if (e.type === "lap") {
    ok = num(e.lap_number, 1, 200) && num(e.t_end, 0, 20000) && num(e.lap_s, 20, 3000) &&
      ["s1", "s2", "s3", "st_speed"].every((k) => num(e[k], 0, 3000, true)) && (e.pit_out === 0 || e.pit_out === 1);
  } else if (e.type === "pit") {
    ok = num(e.lap_number, 1, 200) && num(e.t, 0, 20000) && num(e.pit_s, 0, 3000, true);
  } else {
    ok = num(e.stint_number, 1, 20) && num(e.lap_start, 1, 200) && num(e.t, 0, 20000) &&
      COMPOUNDS.has(e.compound as string) && num(e.tyre_age_at_start, 0, 200);
  }
  if (!ok) throw new Error(`Invalid ${e.type} event ${e.event_id}`);
}

export class RaceDB {
  db: Database;
  queries: Record<string, Query>;
  stats = { received: 0, inserted: 0, duplicates: 0, rejected_batches: 0, watermark: 0 };
  constructor(SQL: SqlJsStatic, schema: string, queriesText: string, drivers: Driver[]) {
    this.db = new SQL.Database();
    this.db.run(schema);
    const st = this.db.prepare("INSERT INTO dim_driver VALUES (:driver_number, :code, :name, :team, :colour)");
    for (const d of drivers) st.run({ ":driver_number": d.driver_number, ":code": d.code, ":name": d.name, ":team": d.team, ":colour": d.colour });
    st.free();
    this.queries = loadQueries(queriesText);
  }

  /** Atomic micro-batch: exact replays are no-ops; a conflicting replay rolls back everything. */
  ingest(events: RaceEvent[]): { inserted: number; duplicates: number } {
    if (events.length > MAX_BATCH) throw new Error("Batch too large");
    events.forEach(validateEvent);
    let inserted = 0;
    let duplicates = 0;
    this.db.run("BEGIN");
    try {
      for (const e of events) {
        const [table, cols] = TABLES[e.type];
        const row = cols.map((c) => (e[c] === undefined ? null : (e[c] as string | number | null)));
        const res = this.db.exec(`SELECT ${cols.join(", ")} FROM ${table} WHERE event_id = ?`, [e.event_id]);
        if (res.length && res[0].values.length) {
          const old = res[0].values[0];
          if (old.some((v, i) => v !== row[i])) throw new Error(`Conflicting replay for ${e.event_id}`);
          duplicates++;
          continue;
        }
        this.db.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, row);
        inserted++;
      }
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      this.stats.rejected_batches++;
      this.stats.received += events.length;
      throw err;
    }
    this.stats.received += events.length;
    this.stats.inserted += inserted;
    this.stats.duplicates += duplicates;
    for (const e of events) this.stats.watermark = Math.max(this.stats.watermark, eventTime(e));
    return { inserted, duplicates };
  }

  query(name: string, params: Record<string, string | number>): Row[] {
    const q = this.queries[name];
    if (!q) throw new Error("Unknown query");
    const keys = Object.keys(params).sort();
    if (keys.join() !== [...q.params].sort().join()) throw new Error(`${name} expects ${q.params.join(", ")}`);
    if ("grp" in params && !(GROUPS as readonly string[]).includes(params.grp as string)) throw new Error("Unsupported group");
    for (const k of ["as_of", "lap_from", "lap_to", "width", "clean_only"]) {
      if (k in params && !num(params[k], 0, 20000)) throw new Error(`Invalid ${k}`);
    }
    const bind: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params)) bind[":" + k] = v;
    const st = this.db.prepare(q.sql);
    st.bind(bind);
    const rows: Row[] = [];
    while (st.step()) rows.push(st.getAsObject() as Row);
    st.free();
    return rows;
  }
}
