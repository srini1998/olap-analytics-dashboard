# Race data

`monza-2024.json` is a snapshot of the 2024 Italian Grand Prix race (OpenF1 session 9590): drivers,
laps (with sector times), stints, pit stops and the session result, retrieved from the OpenF1 API
(https://openf1.org) with `scripts/fetch_openf1.py`. `monza-2024.stream.json` is derived from it by
`src/race_stream.py` (event-time ordered lap, pit and stint events).

OpenF1 publishes this data under **CC BY-NC-SA 4.0** (https://creativecommons.org/licenses/by-nc-sa/4.0/).
Both files are redistributed under the same license, for non-commercial use, with attribution to OpenF1.
This project is unofficial and not associated with Formula 1 companies; F1 names and marks belong to
their owners. The original commerce pipeline (`src/pipeline.py`) still uses authored synthetic events.
