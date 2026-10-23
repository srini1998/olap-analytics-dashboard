-- Star schema for a replayed race stream. Shared verbatim by Python sqlite3 and browser sql.js.
CREATE TABLE IF NOT EXISTS dim_driver (
  driver_number INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  colour TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dim_stint (
  event_id TEXT PRIMARY KEY,
  driver_number INTEGER NOT NULL,
  stint_number INTEGER NOT NULL,
  lap_start INTEGER NOT NULL,
  compound TEXT NOT NULL,
  tyre_age_at_start INTEGER NOT NULL,
  t REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_lap (
  event_id TEXT PRIMARY KEY,
  driver_number INTEGER NOT NULL,
  lap_number INTEGER NOT NULL,
  t_end REAL NOT NULL,
  lap_s REAL NOT NULL,
  s1 REAL,
  s2 REAL,
  s3 REAL,
  pit_out INTEGER NOT NULL,
  st_speed REAL
);
CREATE TABLE IF NOT EXISTS fact_pit (
  event_id TEXT PRIMARY KEY,
  driver_number INTEGER NOT NULL,
  lap_number INTEGER NOT NULL,
  t REAL NOT NULL,
  pit_s REAL
);
CREATE INDEX IF NOT EXISTS idx_lap_t ON fact_lap(t_end);
CREATE INDEX IF NOT EXISTS idx_lap_driver ON fact_lap(driver_number, lap_number);
CREATE INDEX IF NOT EXISTS idx_stint_driver ON dim_stint(driver_number, stint_number);
CREATE INDEX IF NOT EXISTS idx_pit_driver ON fact_pit(driver_number, lap_number);
