"""
Race stream: real historical F1 timing replayed as a streaming OLAP workload.

A snapshot of one race from OpenF1 (CC BY-NC-SA 4.0, see data/) is turned into an
event stream (lap completions, pit entries, stint starts) ordered by event time. Events
are ingested in micro-batches into a SQLite star schema with the same guarantees as the
sales pipeline: exact replays are no-ops, a conflicting replay of an event id is rejected
and the whole batch rolls back. Every query is evaluated "as of" an event-time watermark,
so out-of-order delivery and scrubbing back in time give consistent answers.

The schema and queries live in shared/*.sql and are executed verbatim by the browser
(sql.js) on the public website; tests/golden holds outputs both runtimes must reproduce.
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import threading
from datetime import datetime
from typing import Dict, List

ROOT = os.path.join(os.path.dirname(__file__), "..")
SHARED = os.path.join(ROOT, "shared")
GROUPS = ("driver", "team", "compound", "stint", "lap_window")
MAX_BATCH = 5000

LAP_COLS = ("event_id", "driver_number", "lap_number", "t_end", "lap_s", "s1", "s2", "s3", "pit_out", "st_speed")
PIT_COLS = ("event_id", "driver_number", "lap_number", "t", "pit_s")
STINT_COLS = ("event_id", "driver_number", "stint_number", "lap_start", "compound", "tyre_age_at_start", "t")
TABLES = {"lap": ("fact_lap", LAP_COLS), "pit": ("fact_pit", PIT_COLS), "stint": ("dim_stint", STINT_COLS)}
COMPOUNDS = {"SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET", "UNKNOWN"}


def load_queries(path: str = os.path.join(SHARED, "race_queries.sql")) -> Dict[str, dict]:
    text = open(path, encoding="utf-8").read()
    parts = re.split(r"^-- name: (\w+)\s*$", text, flags=re.M)
    raw = {parts[i]: parts[i + 1] for i in range(1, len(parts), 2)}
    base = raw.pop("base").strip()
    out = {}
    for name, body in raw.items():
        m = re.search(r"^-- params: (.+)$", body, flags=re.M)
        params = [p.strip() for p in m.group(1).split(",")] if m else []
        sql = "\n".join(l for l in body.strip().splitlines() if not l.startswith("--")).replace("{{base}}", base)
        out[name] = {"sql": sql, "params": params}
    return out


def build_events(snapshot: dict) -> List[dict]:
    """Turn an OpenF1 snapshot into an event-time ordered stream (deterministic ids)."""
    key = snapshot["session"]["session_key"]
    starts = [datetime.fromisoformat(l["date_start"]) for l in snapshot["laps"] if l.get("date_start")]
    t0 = min(starts)
    lap_start_t: Dict[tuple, float] = {}
    events: List[dict] = []
    for l in snapshot["laps"]:
        if not l.get("date_start"):
            continue
        start = round((datetime.fromisoformat(l["date_start"]) - t0).total_seconds(), 3)
        lap_start_t[(l["driver_number"], l["lap_number"])] = start
        if l.get("lap_duration") is None:
            continue  # no completion time recorded (e.g. retirement lap): nothing to emit
        events.append({
            "type": "lap", "event_id": f"lap:{key}:{l['driver_number']}:{l['lap_number']}",
            "driver_number": l["driver_number"], "lap_number": l["lap_number"],
            "t_end": round(start + l["lap_duration"], 3), "lap_s": l["lap_duration"],
            "s1": l.get("duration_sector_1"), "s2": l.get("duration_sector_2"), "s3": l.get("duration_sector_3"),
            "pit_out": 1 if l.get("is_pit_out_lap") else 0, "st_speed": l.get("st_speed"),
        })
    for p in snapshot["pits"]:
        events.append({
            "type": "pit", "event_id": f"pit:{key}:{p['driver_number']}:{p['lap_number']}",
            "driver_number": p["driver_number"], "lap_number": p["lap_number"],
            "t": round((datetime.fromisoformat(p["date"]) - t0).total_seconds(), 3), "pit_s": p.get("pit_duration"),
        })
    for s in snapshot["stints"]:
        t = 0.0 if s["lap_start"] <= 1 else lap_start_t.get((s["driver_number"], s["lap_start"]))
        if t is None:
            continue
        events.append({
            "type": "stint", "event_id": f"stint:{key}:{s['driver_number']}:{s['stint_number']}",
            "driver_number": s["driver_number"], "stint_number": s["stint_number"], "lap_start": s["lap_start"],
            "compound": s.get("compound") or "UNKNOWN", "tyre_age_at_start": s.get("tyre_age_at_start") or 0, "t": t,
        })
    events.sort(key=lambda e: (event_time(e), e["event_id"]))
    return events


def event_time(e: dict) -> float:
    return e["t_end"] if e["type"] == "lap" else e["t"]


def drivers_from(snapshot: dict) -> List[dict]:
    return [{"driver_number": d["driver_number"], "code": d["name_acronym"], "name": d["full_name"],
             "team": d["team_name"], "colour": "#" + (d.get("team_colour") or "888888")} for d in snapshot["drivers"]]


def _num(v, lo, hi, nullable=False):
    if v is None and nullable:
        return True
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and lo <= v <= hi


def validate_event(e: dict) -> None:
    kind = e.get("type")
    if kind not in TABLES:
        raise ValueError("Unknown event type")
    if not isinstance(e.get("event_id"), str) or not 1 <= len(e["event_id"]) <= 80:
        raise ValueError("Invalid event id")
    if not _num(e.get("driver_number"), 1, 99):
        raise ValueError("Invalid driver")
    if kind == "lap":
        ok = (_num(e.get("lap_number"), 1, 200) and _num(e.get("t_end"), 0, 20000) and _num(e.get("lap_s"), 20, 3000)
              and all(_num(e.get(k), 0, 3000, True) for k in ("s1", "s2", "s3", "st_speed")) and e.get("pit_out") in (0, 1))
    elif kind == "pit":
        ok = _num(e.get("lap_number"), 1, 200) and _num(e.get("t"), 0, 20000) and _num(e.get("pit_s"), 0, 3000, True)
    else:
        ok = (_num(e.get("stint_number"), 1, 20) and _num(e.get("lap_start"), 1, 200) and _num(e.get("t"), 0, 20000)
              and e.get("compound") in COMPOUNDS and _num(e.get("tyre_age_at_start"), 0, 200))
    if not ok:
        raise ValueError(f"Invalid {kind} event {e.get('event_id')}")


class RaceStream:
    def __init__(self, drivers: List[dict]):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(open(os.path.join(SHARED, "race_schema.sql"), encoding="utf-8").read())
        self.conn.executemany("INSERT INTO dim_driver VALUES (:driver_number, :code, :name, :team, :colour)", drivers)
        self.conn.commit()
        self.queries = load_queries()
        self.stats = {"received": 0, "inserted": 0, "duplicates": 0, "rejected_batches": 0, "watermark": 0.0}

    def ingest(self, events: List[dict]) -> dict:
        """Atomic micro-batch: exact replays are no-ops; a conflicting replay rolls back everything."""
        if len(events) > MAX_BATCH:
            raise ValueError("Batch too large")
        for e in events:
            validate_event(e)
        inserted = duplicates = 0
        with self._lock:
            try:
                with self.conn:
                    for e in events:
                        table, cols = TABLES[e["type"]]
                        row = tuple(e.get(c) for c in cols)
                        old = self.conn.execute(f"SELECT {', '.join(cols)} FROM {table} WHERE event_id = ?", (e["event_id"],)).fetchone()
                        if old is not None:
                            if tuple(old) != row:
                                raise ValueError(f"Conflicting replay for {e['event_id']}")
                            duplicates += 1
                            continue
                        self.conn.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", row)
                        inserted += 1
            except ValueError:
                self.stats["rejected_batches"] += 1
                self.stats["received"] += len(events)
                raise
        self.stats["received"] += len(events)
        self.stats["inserted"] += inserted
        self.stats["duplicates"] += duplicates
        if events:
            self.stats["watermark"] = max(self.stats["watermark"], max(event_time(e) for e in events))
        return {"inserted": inserted, "duplicates": duplicates}

    def query(self, name: str, **params) -> List[dict]:
        q = self.queries.get(name)
        if q is None:
            raise ValueError("Unknown query")
        if set(params) != set(q["params"]):
            raise ValueError(f"{name} expects {q['params']}")
        if "grp" in params and params["grp"] not in GROUPS:
            raise ValueError("Unsupported group")
        for k in ("as_of", "lap_from", "lap_to", "width", "clean_only"):
            if k in params and not _num(params[k], 0, 20000):
                raise ValueError(f"Invalid {k}")
        if "width" in params and not 1 <= params["width"] <= 53:
            raise ValueError("Invalid width")
        return [dict(r) for r in self.conn.execute(q["sql"], params).fetchall()]


def load_snapshot(name: str = "monza-2024") -> dict:
    with open(os.path.join(ROOT, "data", f"{name}.json"), encoding="utf-8") as f:
        return json.load(f)
