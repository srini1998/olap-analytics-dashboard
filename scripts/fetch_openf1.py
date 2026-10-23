"""One-off snapshot of a historical race from the OpenF1 API (https://openf1.org).

OpenF1 data is licensed CC BY-NC-SA 4.0 (non-commercial). The snapshot is stored in data/
with that license and attribution; the website never calls OpenF1 at runtime.
Free tier limit is 3 req/s and 30 req/min, so requests are spaced 2.5 s apart.

    python scripts/fetch_openf1.py 9590 data/monza-2024.json
"""
import json, sys, time, urllib.request

BASE = "https://api.openf1.org/v1/"


def get(endpoint, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    with urllib.request.urlopen(f"{BASE}{endpoint}?{q}", timeout=60) as r:
        data = json.load(r)
    time.sleep(2.5)
    return data


def main(session_key: int, out: str) -> None:
    session = get("sessions", session_key=session_key)[0]
    drivers = get("drivers", session_key=session_key)
    laps = get("laps", session_key=session_key)
    stints = get("stints", session_key=session_key)
    pits = get("pit", session_key=session_key)
    try:
        result = get("session_result", session_key=session_key)
    except Exception:
        result = []
    snap = {
        "source": "OpenF1 API (https://openf1.org), retrieved " + time.strftime("%Y-%m-%d"),
        "license": "CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/). Non-commercial use only. "
                   "Not affiliated with Formula 1; F1 data, names and trademarks belong to their owners.",
        "session": {k: session[k] for k in ("session_key", "meeting_key", "circuit_short_name", "country_name", "date_start", "year", "session_name")},
        "drivers": [{k: d.get(k) for k in ("driver_number", "name_acronym", "full_name", "team_name", "team_colour")} for d in drivers],
        "laps": [{k: l.get(k) for k in ("driver_number", "lap_number", "date_start", "lap_duration", "duration_sector_1",
                                         "duration_sector_2", "duration_sector_3", "is_pit_out_lap", "st_speed")} for l in laps],
        "stints": [{k: s.get(k) for k in ("driver_number", "stint_number", "lap_start", "lap_end", "compound", "tyre_age_at_start")} for s in stints],
        "pits": [{k: p.get(k) for k in ("driver_number", "lap_number", "pit_duration", "date")} for p in pits],
        "result": [{k: r.get(k) for k in ("position", "driver_number", "number_of_laps", "dnf", "dns", "dsq", "gap_to_leader", "duration")} for r in result],
    }
    with open(out, "w") as f:
        json.dump(snap, f, separators=(",", ":"))
    print(out, {k: len(v) for k, v in snap.items() if isinstance(v, list)})


if __name__ == "__main__":
    main(int(sys.argv[1]), sys.argv[2])
