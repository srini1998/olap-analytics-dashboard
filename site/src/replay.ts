// Delivers the recorded event stream to the in-browser OLAP store on a replay clock,
// with optional fault injection (duplicate delivery, late/out-of-order delivery, conflicts).
import { RaceDB, eventTime, type RaceEvent } from "./engine/race.ts";

class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export interface BatchInfo { size: number; inserted: number; duplicates: number; ms: number }

export class Replay {
  db: RaceDB;
  events: RaceEvent[];
  clock = 0;
  cursor = 0;
  duplicate = false;
  late = false;
  lateQueue: { due: number; e: RaceEvent }[] = [];
  rng = new Rng(2024);
  batches = 0;
  lastBatch: BatchInfo = { size: 0, inserted: 0, duplicates: 0, ms: 0 };
  endTime: number;
  constructor(db: RaceDB, events: RaceEvent[]) {
    this.db = db;
    this.events = events;
    this.endTime = eventTime(events[events.length - 1]);
  }
  /** Move the replay clock. Going back is pure time travel: nothing is deleted, queries are as-of. */
  seek(t: number) {
    t = Math.max(0, Math.min(this.endTime + 20, t));
    if (t <= this.clock) {
      this.clock = t;
      return;
    }
    this.clock = t;
    const batch: RaceEvent[] = [];
    while (this.cursor < this.events.length && eventTime(this.events[this.cursor]) <= t) {
      const e = this.events[this.cursor++];
      if (this.late && this.rng.next() < 0.3) this.lateQueue.push({ due: eventTime(e) + 2 + this.rng.next() * 13, e });
      else batch.push(e);
    }
    for (const x of this.lateQueue) if (x.due <= t) batch.push(x.e);
    this.lateQueue = this.lateQueue.filter((x) => x.due > t);
    if (!batch.length) return;
    const started = performance.now();
    let inserted = 0;
    let duplicates = 0;
    for (let i = 0; i < batch.length; i += 4000) {
      const r = this.db.ingest(batch.slice(i, i + 4000));
      inserted += r.inserted;
      duplicates += r.duplicates;
      if (this.duplicate) {
        const again = this.db.ingest(batch.slice(i, i + 4000));
        duplicates += again.duplicates;
      }
    }
    this.batches++;
    this.lastBatch = { size: batch.length * (this.duplicate ? 2 : 1), inserted, duplicates, ms: performance.now() - started };
  }
  /** Late events whose event time is already at or before the watermark but have not arrived. */
  inFlightBefore(asOf: number) {
    return this.lateQueue.filter((x) => eventTime(x.e) <= asOf).length;
  }
  /** Re-send a delivered lap with a different lap time: must be rejected and rolled back. */
  injectConflict(): string {
    const delivered = this.events.slice(0, this.cursor).filter((e) => e.type === "lap");
    if (!delivered.length) return "No laps delivered yet; let the race run first.";
    const e = delivered[Math.floor(this.rng.next() * delivered.length)];
    const altered = { ...e, lap_s: Math.round(((e.lap_s as number) + 0.5) * 1000) / 1000 };
    const next = this.events[this.cursor];
    const batch = next ? [next, altered] : [altered];
    try {
      this.db.ingest(batch);
      return "Unexpected: the conflicting event was accepted.";
    } catch (err) {
      return `Rejected ${e.event_id}: lap time ${e.lap_s} → ${altered.lap_s}. The whole ${batch.length}-event batch rolled back${next ? " (including one valid new event, which arrives later as normal)" : ""}; stored value kept. (${(err as Error).message})`;
    }
  }
}
