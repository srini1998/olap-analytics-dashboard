import { useEffect, useRef, useState } from "react";
import type { RaceDB, Row } from "./engine/race.ts";
import { Replay } from "./replay.ts";
import { LapChart, PaceChart, TyreChip } from "./Charts.tsx";

export interface Boot {
  db: RaceDB;
  replay: Replay;
  meta: { source: string; license: string; drivers: { driver_number: number; code: string; name: string; team: string; colour: string }[]; result: { position: number | null; driver_number: number; number_of_laps: number; dnf: boolean }[] };
}

const SPEEDS = [10, 30, 60, 120];
const TOTAL_LAPS = 53;
const GROUP_LABEL: Record<string, string> = { driver: "Driver", team: "Team", compound: "Compound", stint: "Stint", lap_window: "10-lap window" };

const fmtLap = (v: number | null | undefined) => {
  if (v == null) return "—";
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
};
const fmtGap = (v: number | null | undefined) => (v == null ? "" : `+${v.toFixed(3)}`);
const fmtClock = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};

function useReducedMotion() {
  const [r] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  return r;
}

export default function App({ boot }: { boot: Boot }) {
  const { db, replay, meta } = boot;
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(30);
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState<string[]>(["LEC", "PIA", "NOR"]);
  const [grp, setGrp] = useState("compound");
  const [lapFrom, setLapFrom] = useState(1);
  const [lapTo, setLapTo] = useState(TOTAL_LAPS);
  const [clean, setClean] = useState(true);
  const [dup, setDup] = useState(false);
  const [late, setLate] = useState(false);
  const [note, setNote] = useState("Replaying the 2024 Italian Grand Prix from recorded timing.");
  const playRef = useRef(playing);
  const speedRef = useRef(speed);
  playRef.current = playing;
  speedRef.current = speed;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      const dt = Math.min(200, now - last);
      last = now;
      if (playRef.current) {
        replay.seek(replay.clock + (dt / 1000) * speedRef.current);
        if (replay.clock >= replay.endTime + 20) setPlaying(false);
      }
      acc += dt;
      if (acc >= 250) {
        acc = 0;
        setTick((x) => x + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [replay]);

  const asOf = Math.round(replay.clock * 1000) / 1000;
  const t0 = performance.now();
  const tower = db.query("tower", { as_of: asOf });
  const lapchart = db.query("lapchart", { as_of: asOf });
  const rolling = db.query("rolling", { as_of: asOf });
  const sectors = db.query("sectors", { as_of: asOf });
  const rollup = db.query("rollup", { as_of: asOf, grp, lap_from: Math.min(lapFrom, lapTo), lap_to: Math.max(lapFrom, lapTo), clean_only: clean ? 1 : 0 });
  const degradation = db.query("degradation", { as_of: asOf });
  const tumbling = db.query("tumbling", { as_of: asOf, width: 10 });
  const queryMs = performance.now() - t0;
  const leaderLaps = (tower[0]?.laps as number) ?? 0;
  const inFlight = replay.inFlightBefore(asOf);
  const fastest = sectors.find((s) => s.sector === "Lap");
  const finished = replay.clock >= replay.endTime;
  const st = db.stats;

  const toggleDriver = (code: string) =>
    setSelected((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s.slice(-3), code]));

  const teams = [...new Set(tumbling.map((r) => r.team as string))];
  const windows = [...new Set(tumbling.map((r) => r.window_start as number))];
  const tumbleRange = tumbling.length ? [Math.min(...tumbling.map((r) => r.avg_lap as number)), Math.max(...tumbling.map((r) => r.avg_lap as number))] : [0, 1];

  return (
    <>
      <a className="skip" href="#tower">Skip to timing</a>
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i className="soft" />
            <i className="medium" />
            <i className="hard" />
          </span>
          <div>
            <p className="eyebrow">Pitwall Replay · streaming OLAP</p>
            <h1>2024 Italian Grand Prix, Monza</h1>
          </div>
        </div>
        <div className="clock" aria-live="off">
          <span className="lapno num">
            LAP {Math.min(TOTAL_LAPS, leaderLaps + (finished ? 0 : 1))}
            <small>/{TOTAL_LAPS}</small>
          </span>
          <span className="num">{fmtClock(replay.clock)}</span>
        </div>
      </header>

      <p className="lede">
        Real lap, sector, pit and tyre timing from one race (OpenF1), replayed as an event stream into a SQL star schema in your
        browser. Every panel is a live, parameterised query evaluated as of the replay clock: rewind and the answers rewind; deliver
        events twice or late and the answers stay correct.
      </p>

      <section className="transport" aria-label="Replay controls">
        <button type="button" className="play" onClick={() => {
            if (!playing && finished) replay.seek(0);
            setPlaying(!playing);
          }} aria-pressed={playing}>
          {playing ? "Pause" : finished ? "Watch again" : "Play"}
        </button>
        <div className="seg" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>×{s}</button>
          ))}
        </div>
        <label className="scrub">
          <span className="sr">Race time (scrub to time-travel)</span>
          <input
            type="range"
            min={0}
            max={Math.ceil(replay.endTime + 20)}
            step={1}
            value={Math.floor(replay.clock)}
            onChange={(e) => {
              replay.seek(Number(e.target.value));
              setTick((x) => x + 1);
            }}
            aria-valuetext={`${fmtClock(replay.clock)}, lap ${leaderLaps}`}
          />
        </label>
        <button type="button" className="ghost" onClick={() => { replay.seek(0); setTick((x) => x + 1); }}>To lights out</button>
      </section>

      <main className="wall">
        <section id="tower" className="tower panel" aria-labelledby="tower-h">
          <h2 id="tower-h" className="ph">Timing tower <span className="sub">as of {fmtClock(asOf)}</span></h2>
          <table>
            <caption className="sr">Positions from lap-completion events; select drivers to compare</caption>
            <thead>
              <tr>
                <th scope="col">P</th>
                <th scope="col">Driver</th>
                <th scope="col" className="r">Gap</th>
                <th scope="col" className="r hide-s">Int</th>
                <th scope="col" className="r">Last</th>
                <th scope="col" className="r hide-s">Best</th>
                <th scope="col">Tyre</th>
                <th scope="col" className="r hide-s">Pit</th>
              </tr>
            </thead>
            <tbody>
              {tower.length === 0 && (
                <tr><td colSpan={8} className="empty">Cars on the formation lap. Press Play.</td></tr>
              )}
              {tower.map((r) => {
                const sel = selected.includes(r.code as string);
                return (
                  <tr key={r.driver_number} className={`${sel ? "sel" : ""} ${r.stale ? "stale" : ""}`}>
                    <td className="num pos">{r.pos}</td>
                    <td>
                      <button type="button" className="drv" aria-pressed={sel} onClick={() => toggleDriver(r.code as string)} title={`${r.team}`}>
                        <i style={{ background: r.colour as string }} aria-hidden="true" />
                        {r.code}
                      </button>
                    </td>
                    <td className="num r">{r.pos === 1 ? "Leader" : (r.laps_down as number) > 0 ? `+${r.laps_down} L` : fmtGap(r.gap as number)}</td>
                    <td className="num r hide-s">{r.pos === 1 ? "" : (r.laps_down as number) > 0 ? "" : fmtGap(r.interval as number)}</td>
                    <td className={`num r ${fastest && r.last_lap === fastest.best && r.code === fastest.code ? "fl" : ""}`}>{fmtLap(r.last_lap as number)}</td>
                    <td className="num r hide-s">{fmtLap(r.best_lap as number)}</td>
                    <td><TyreChip compound={r.compound as string} age={r.tyre_age as number} /></td>
                    <td className="num r hide-s">{r.stale && finished === false ? "OUT?" : r.pits}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="fine">Order = laps completed, then time the lap was completed. "OUT?" = no timing for 200 s of race time.</p>
        </section>

        <section className="health panel" aria-labelledby="health-h">
          <h2 id="health-h" className="ph">Stream</h2>
          <dl className="kv">
            <div><dt>Events received</dt><dd className="num">{st.received}</dd></div>
            <div><dt>Rows stored</dt><dd className="num">{st.inserted}</dd></div>
            <div><dt>Duplicates absorbed</dt><dd className="num">{st.duplicates}</dd></div>
            <div><dt>Batches rejected</dt><dd className="num">{st.rejected_batches}</dd></div>
            <div><dt>Watermark</dt><dd className="num">{fmtClock(st.watermark)}</dd></div>
            <div><dt>Last batch</dt><dd className="num">{replay.lastBatch.size} ev · {replay.lastBatch.ms.toFixed(1)} ms</dd></div>
            <div><dt>7 queries</dt><dd className="num">{queryMs.toFixed(1)} ms</dd></div>
            <div><dt>Late, not yet in</dt><dd className={`num ${inFlight ? "warn" : ""}`}>{inFlight}</dd></div>
          </dl>
          <fieldset className="faults">
            <legend>Inject faults</legend>
            <label><input type="checkbox" checked={dup} onChange={(e) => { setDup(e.target.checked); replay.duplicate = e.target.checked; }} /> Deliver every batch twice</label>
            <label><input type="checkbox" checked={late} onChange={(e) => { setLate(e.target.checked); replay.late = e.target.checked; }} /> Delay 30% of events by 2–15 s (out of order)</label>
            <button type="button" className="ghost" onClick={() => { setNote(replay.injectConflict()); }}>Send a conflicting correction</button>
          </fieldset>
          <p className="note" role="status">{inFlight > 0 ? `${inFlight} late events belong before this watermark, so the tower is provisional until they land. ` : ""}{note}</p>
          <dl className="bests">
            {sectors.map((s) => (
              <div key={s.sector as string}>
                <dt>{s.sector === "Lap" ? "Fastest lap" : `Best ${s.sector}`}</dt>
                <dd><span className="num">{s.sector === "Lap" ? fmtLap(s.best as number) : (s.best as number | null)?.toFixed(3) ?? "—"}</span> {s.code ?? ""}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="charts panel" aria-labelledby="charts-h">
          <h2 id="charts-h" className="ph">Lap chart <span className="sub">position at the end of each lap</span></h2>
          <LapChart rows={lapchart} selected={selected} total={TOTAL_LAPS} />
          <h2 className="ph">Rolling pace <span className="sub">5-lap average of clean laps · selected drivers</span></h2>
          <PaceChart rows={rolling} selected={selected} total={TOTAL_LAPS} />
          <p className="fine">Clean = not lap 1, not a pit-in or pit-out lap. Choose up to four drivers in the tower.</p>
        </section>

        <section className="work panel" aria-labelledby="work-h">
          <h2 id="work-h" className="ph">Rollup workbench</h2>
          <form className="wb" onSubmit={(e) => e.preventDefault()}>
            <label>
              <span>Group by</span>
              <select value={grp} onChange={(e) => setGrp(e.target.value)}>
                {Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>
              <span>From lap</span>
              <input type="number" min={1} max={TOTAL_LAPS} value={lapFrom} onChange={(e) => setLapFrom(Math.max(1, Math.min(TOTAL_LAPS, Number(e.target.value) || 1)))} />
            </label>
            <label>
              <span>To lap</span>
              <input type="number" min={1} max={TOTAL_LAPS} value={lapTo} onChange={(e) => setLapTo(Math.max(1, Math.min(TOTAL_LAPS, Number(e.target.value) || TOTAL_LAPS)))} />
            </label>
            <label className="chk">
              <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
              <span>Clean laps only</span>
            </label>
          </form>
          <div className="scroll">
            <table className="grid">
              <caption className="sr">Rollup by {GROUP_LABEL[grp]}</caption>
              <thead>
                <tr>
                  <th scope="col">{GROUP_LABEL[grp]}</th>
                  <th scope="col" className="r">Laps</th>
                  <th scope="col" className="r">Avg lap</th>
                  <th scope="col" className="r">Best lap</th>
                  <th scope="col" className="r">S1</th>
                  <th scope="col" className="r">S2</th>
                  <th scope="col" className="r">S3</th>
                  <th scope="col" className="r">Trap km/h</th>
                  <th scope="col" className="r">Tyre age</th>
                </tr>
              </thead>
              <tbody>
                {rollup.length === 0 && <tr><td colSpan={9} className="empty">No laps match yet.</td></tr>}
                {rollup.map((r) => (
                  <tr key={r.dimension as string}>
                    <th scope="row">
                      {grp === "compound" ? <TyreChip compound={r.compound as string} label /> : <><i className="sw" style={{ background: grp === "lap_window" ? "transparent" : (r.colour as string) }} aria-hidden="true" />{r.dimension}</>}
                    </th>
                    <td className="num r">{r.laps}</td>
                    <td className="num r">{fmtLap(r.avg_lap as number)}</td>
                    <td className="num r">{fmtLap(r.best_lap as number)}</td>
                    <td className="num r">{(r.best_s1 as number)?.toFixed(3)}</td>
                    <td className="num r">{(r.best_s2 as number)?.toFixed(3)}</td>
                    <td className="num r">{(r.best_s3 as number)?.toFixed(3)}</td>
                    <td className="num r">{r.avg_trap}</td>
                    <td className="num r">{r.avg_tyre_age}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="sql">
            <summary>SQL executed (values bound, never concatenated)</summary>
            <pre>{db.queries.rollup.sql}</pre>
            <p className="num">
              :as_of = {asOf} · :grp = '{grp}' · :lap_from = {Math.min(lapFrom, lapTo)} · :lap_to = {Math.max(lapFrom, lapTo)} · :clean_only = {clean ? 1 : 0}
            </p>
          </details>
        </section>

        <section className="deg panel" aria-labelledby="deg-h">
          <h2 id="deg-h" className="ph">Stint trend <span className="sub">seconds per lap of tyre age, least-squares, clean laps</span></h2>
          <div className="scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col">Stint</th>
                  <th scope="col">Tyre</th>
                  <th scope="col" className="r">Laps</th>
                  <th scope="col" className="r">Slope</th>
                  <th scope="col" className="r">Avg</th>
                </tr>
              </thead>
              <tbody>
                {degradation.length === 0 && <tr><td colSpan={5} className="empty">Needs five clean laps in a stint.</td></tr>}
                {degradation.slice(0, 14).map((r) => (
                  <tr key={`${r.code}-${r.stint_number}`}>
                    <th scope="row"><i className="sw" style={{ background: r.colour as string }} aria-hidden="true" />{r.code} · {r.stint_number}</th>
                    <td><TyreChip compound={r.compound as string} /></td>
                    <td className="num r">{r.first_lap}–{r.last_lap}</td>
                    <td className={`num r ${(r.slope as number) > 0 ? "up" : "down"}`}>{(r.slope as number) > 0 ? "+" : ""}{(r.slope as number).toFixed(3)}</td>
                    <td className="num r">{fmtLap(r.avg_lap as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine">Raw lap times are not fuel-corrected: cars get lighter every lap, so a negative slope is normal and tyre wear shows up as a less negative or positive slope.</p>
        </section>

        <section className="tumble panel" aria-labelledby="tum-h">
          <h2 id="tum-h" className="ph">Team pace, tumbling 10-lap windows <span className="sub">average clean lap</span></h2>
          <div className="scroll">
            <table className="heat">
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  {windows.map((w) => <th key={w} scope="col" className="r">L{w}–{Math.min(w + 9, TOTAL_LAPS)}</th>)}
                </tr>
              </thead>
              <tbody>
                {teams.map((team) => (
                  <tr key={team}>
                    <th scope="row">{team}</th>
                    {windows.map((w) => {
                      const c = tumbling.find((r) => r.team === team && r.window_start === w);
                      const v = c ? ((c.avg_lap as number) - tumbleRange[0]) / Math.max(0.001, tumbleRange[1] - tumbleRange[0]) : null;
                      return (
                        <td key={w} className="num r" style={v == null ? undefined : { background: `rgba(236, 230, 220, ${0.04 + (1 - v) * 0.3})` }}>
                          {c ? (c.avg_lap as number).toFixed(2) : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {finished && (
          <section className="official panel" aria-labelledby="off-h">
            <h2 id="off-h" className="ph">Timing order vs official classification</h2>
            {replay.lateQueue.length > 0 && (
              <p className="note">{replay.lateQueue.length} delayed events have not arrived yet, so the timing order is still provisional.</p>
            )}
            <ol className="cmp">
              {meta.result
                .filter((r) => r.position != null)
                .sort((a, b) => (a.position as number) - (b.position as number))
                .map((r) => {
                  const ours = tower.find((x) => x.driver_number === r.driver_number);
                  const d = meta.drivers.find((x) => x.driver_number === r.driver_number);
                  const same = ours?.pos === r.position;
                  return (
                    <li key={r.driver_number} className={same ? "" : "diff"}>
                      <span className="num">P{r.position}</span> {d?.code} <span className="num">{same ? "matches" : `timing P${ours?.pos}`}</span>
                    </li>
                  );
                })}
            </ol>
            <p className="fine">
              The official result (OpenF1 session_result) can include decisions that never appear in lap timing, such as time
              penalties. Rows marked differ only where the timing-derived order disagrees.
            </p>
          </section>
        )}

        <section className="about panel" aria-labelledby="about-h">
          <h2 id="about-h" className="ph">What this is</h2>
          <div className="cols">
            <div>
              <h3>Real</h3>
              <p>
                1,008 timed laps with sector times, 50 tyre stints and 30 pit stops from the 2024 Italian Grand Prix, from the OpenF1
                API. The browser runs the same SQLite schema and SQL file as the Python pipeline in the repository; a build-time test
                requires sql.js to reproduce 12 golden query results from Python exactly.
              </p>
            </div>
            <div>
              <h3>Replayed</h3>
              <p>
                The stream is a replay of a stored snapshot, not live timing. Delivery faults are injected by this page. Positions and gaps
                are derived from lap-completion times at the timing line, so they can differ by tenths from broadcast gaps and from the
                official classification.
              </p>
            </div>
            <div>
              <h3>Data terms</h3>
              <p>
                {meta.source}. Licensed {meta.license.split(" (")[0]}; redistributed here for non-commercial use with attribution.
                Unofficial project, not associated with Formula 1. The repository's original sales pipeline still uses labelled synthetic
                events.
              </p>
            </div>
          </div>
          <p className="src">Source: <a href="https://github.com/srini1998/olap-analytics-dashboard">github.com/srini1998/olap-analytics-dashboard</a> · Data: <a href="https://openf1.org">openf1.org</a> (<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>)</p>
        </section>
      </main>
    </>
  );
}
