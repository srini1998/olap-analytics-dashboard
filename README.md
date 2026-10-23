# Real-Time OLAP Dashboard

Repeated events must not rewrite past sales; conflicting batches must not partially commit.

Retry a receipt without double counting. Reject a conflicting ID and roll back all new rows; bind query filter values.

See [review](docs/review.md) and [actual checks](docs/test-results.txt) for data, validation and limitations.

```sh
python -m pytest tests -q
```

No production-readiness or independent model-quality guarantee is claimed.

## Pitwall Replay: real F1 timing as a streaming OLAP workload (live website)

Next-level version: `src/race_stream.py` replays real historical race timing (2024 Italian Grand Prix, OpenF1,
CC BY-NC-SA 4.0, see `data/DATA-LICENSE.md`) as an event-time ordered stream of lap, pit and stint events.
Events go into a SQLite star schema (`shared/race_schema.sql`) in atomic micro-batches with the original guarantees
(exact replays are no-ops; a conflicting replay rolls back the whole batch). Every query in `shared/race_queries.sql`
is parameterised and evaluated **as of an event-time watermark**. That covers the timing tower (position, gap, interval,
tyre, pits), rollups by driver/team/compound/stint/10-lap window, a rolling 5-lap window, per-stint least-squares tyre
trend, a lap chart, sector bests and tumbling team-pace windows. Out-of-order delivery and time travel therefore give
the same answers (tested).

`site/` is the public website. It runs the **same schema and SQL files** in the browser with sql.js (SQLite/WASM).
`site/tests/parity.test.ts` runs during the Vercel build and requires the browser engine to reproduce
12 golden query results exported by the Python tests. Visitors can play/scrub the race, inject duplicate and late deliveries,
send a conflicting correction, and build rollups. At the flag, the timing-derived order is compared with OpenF1's official
classification. Any differences are shown, because penalties are not in lap timing.

Why F1 data: OpenF1's historical data is free, needs no key and is licensed CC BY-NC-SA 4.0 for non-commercial use,
so a stored snapshot can be redistributed with attribution. The site never calls OpenF1 at runtime. The original sales
pipeline (`src/pipeline.py`, synthetic events) is unchanged.

```sh
python -m pytest tests -q                 # sales pipeline + race stream + golden outputs
cd site && npm ci && npm test && npm run build
python scripts/fetch_openf1.py 9590 data/monza-2024.json   # refresh snapshot (rate-limited, optional)
```
