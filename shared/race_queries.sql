-- Named, parameterised queries over the race stream. Every query is "as of" an event-time
-- watermark (:as_of, race seconds), so scrubbing back in time and out-of-order delivery give
-- the same answers. {{base}} expands to the shared lap CTE below. Values are always bound,
-- never concatenated.

-- name: base
lx AS (
  SELECT f.event_id, f.driver_number, f.lap_number, f.t_end, f.lap_s, f.s1, f.s2, f.s3, f.pit_out, f.st_speed,
         dr.code, dr.team, dr.colour,
         s.stint_number, s.compound,
         s.tyre_age_at_start + (f.lap_number - s.lap_start) AS tyre_age,
         CASE WHEN f.lap_number = 1 OR f.pit_out = 1
                OR EXISTS (SELECT 1 FROM fact_pit p WHERE p.driver_number = f.driver_number
                           AND p.lap_number = f.lap_number AND p.t <= :as_of)
              THEN 0 ELSE 1 END AS clean
  FROM fact_lap f
  JOIN dim_driver dr ON dr.driver_number = f.driver_number
  LEFT JOIN dim_stint s ON s.driver_number = f.driver_number AND s.stint_number = (
    SELECT MAX(s2.stint_number) FROM dim_stint s2
    WHERE s2.driver_number = f.driver_number AND s2.lap_start <= f.lap_number AND s2.t <= :as_of)
  WHERE f.t_end <= :as_of
)

-- name: tower
-- params: as_of
WITH {{base}},
cur AS (
  SELECT * FROM lx l WHERE l.lap_number = (SELECT MAX(m.lap_number) FROM lx m WHERE m.driver_number = l.driver_number)
),
ranked AS (
  SELECT cur.*, ROW_NUMBER() OVER (ORDER BY lap_number DESC, t_end ASC) AS pos FROM cur
),
lead AS (SELECT driver_number, lap_number FROM ranked WHERE pos = 1)
SELECT r.pos, r.driver_number, r.code, r.team, r.colour, r.lap_number AS laps,
  ROUND(r.lap_s, 3) AS last_lap,
  (SELECT ROUND(MIN(m.lap_s), 3) FROM lx m WHERE m.driver_number = r.driver_number) AS best_lap,
  (SELECT lap_number FROM lead) - r.lap_number AS laps_down,
  CASE WHEN r.pos = 1 THEN 0.0
       WHEN r.lap_number < (SELECT lap_number FROM lead) THEN NULL
       ELSE ROUND(r.t_end - (SELECT m.t_end FROM lx m WHERE m.driver_number = (SELECT driver_number FROM lead)
                                                    AND m.lap_number = r.lap_number), 3) END AS gap,
  CASE WHEN r.pos = 1 THEN NULL
       ELSE ROUND(r.t_end - (SELECT m.t_end FROM lx m JOIN ranked a ON a.driver_number = m.driver_number
                             WHERE a.pos = r.pos - 1 AND m.lap_number = r.lap_number), 3) END AS interval,
  ts.compound AS compound,
  ts.tyre_age_at_start + MAX(0, r.lap_number - ts.lap_start + 1) AS tyre_age,
  (SELECT COUNT(*) FROM fact_pit p WHERE p.driver_number = r.driver_number AND p.t <= :as_of) AS pits,
  CASE WHEN :as_of - r.t_end > 200 THEN 1 ELSE 0 END AS stale
FROM ranked r
LEFT JOIN dim_stint ts ON ts.driver_number = r.driver_number AND ts.stint_number = (
  SELECT MAX(s.stint_number) FROM dim_stint s WHERE s.driver_number = r.driver_number AND s.t <= :as_of)
ORDER BY r.pos

-- name: rollup
-- params: as_of, grp, lap_from, lap_to, clean_only
WITH {{base}}
SELECT CASE :grp WHEN 'driver' THEN code
                 WHEN 'team' THEN team
                 WHEN 'compound' THEN compound
                 WHEN 'stint' THEN code || ' · stint ' || stint_number
                 WHEN 'lap_window' THEN 'laps ' || (((lap_number - 1) / 10) * 10 + 1) || '–' || (((lap_number - 1) / 10) * 10 + 10)
       END AS dimension,
  MIN(colour) AS colour,
  MIN(compound) AS compound,
  COUNT(*) AS laps,
  ROUND(AVG(lap_s), 3) AS avg_lap,
  ROUND(MIN(lap_s), 3) AS best_lap,
  ROUND(MIN(s1), 3) AS best_s1,
  ROUND(MIN(s2), 3) AS best_s2,
  ROUND(MIN(s3), 3) AS best_s3,
  ROUND(AVG(st_speed), 1) AS avg_trap,
  ROUND(AVG(tyre_age), 1) AS avg_tyre_age
FROM lx
WHERE lap_number BETWEEN :lap_from AND :lap_to AND (:clean_only = 0 OR clean = 1)
GROUP BY dimension
ORDER BY avg_lap ASC, dimension ASC
LIMIT 60

-- name: rolling
-- params: as_of
WITH {{base}}
SELECT driver_number, code, colour, lap_number, ROUND(lap_s, 3) AS lap_s, compound,
  ROUND(AVG(lap_s) OVER (PARTITION BY driver_number ORDER BY lap_number
                         ROWS BETWEEN 4 PRECEDING AND CURRENT ROW), 3) AS avg5
FROM lx WHERE clean = 1
ORDER BY driver_number, lap_number

-- name: degradation
-- params: as_of
WITH {{base}}, c AS (SELECT * FROM lx WHERE clean = 1)
SELECT code, colour, team, stint_number, compound, COUNT(*) AS n,
  MIN(lap_number) AS first_lap, MAX(lap_number) AS last_lap,
  ROUND((COUNT(*) * SUM(tyre_age * lap_s) - SUM(tyre_age) * SUM(lap_s))
        / NULLIF(COUNT(*) * SUM(tyre_age * tyre_age) - SUM(tyre_age) * SUM(tyre_age), 0), 4) AS slope,
  ROUND(AVG(lap_s), 3) AS avg_lap
FROM c
GROUP BY driver_number, stint_number
HAVING COUNT(*) >= 5
ORDER BY slope DESC, code ASC

-- name: lapchart
-- params: as_of
WITH {{base}}
SELECT lap_number, driver_number, code, colour,
  ROW_NUMBER() OVER (PARTITION BY lap_number ORDER BY t_end) AS pos
FROM lx
ORDER BY lap_number, pos

-- name: sectors
-- params: as_of
WITH {{base}}
SELECT 'S1' AS sector, (SELECT code FROM lx WHERE s1 IS NOT NULL ORDER BY s1, t_end LIMIT 1) AS code,
       (SELECT ROUND(MIN(s1), 3) FROM lx) AS best
UNION ALL
SELECT 'S2', (SELECT code FROM lx WHERE s2 IS NOT NULL ORDER BY s2, t_end LIMIT 1), (SELECT ROUND(MIN(s2), 3) FROM lx)
UNION ALL
SELECT 'S3', (SELECT code FROM lx WHERE s3 IS NOT NULL ORDER BY s3, t_end LIMIT 1), (SELECT ROUND(MIN(s3), 3) FROM lx)
UNION ALL
SELECT 'Lap', (SELECT code FROM lx ORDER BY lap_s, t_end LIMIT 1), (SELECT ROUND(MIN(lap_s), 3) FROM lx)

-- name: tumbling
-- params: as_of, width
WITH {{base}}
SELECT ((lap_number - 1) / :width) * :width + 1 AS window_start, team, MIN(colour) AS colour,
  COUNT(*) AS laps, ROUND(AVG(lap_s), 3) AS avg_lap
FROM lx WHERE clean = 1
GROUP BY window_start, team
ORDER BY window_start, avg_lap
