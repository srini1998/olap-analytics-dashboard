import type { Row } from "./engine/race.ts";

const LETTER: Record<string, string> = { SOFT: "S", MEDIUM: "M", HARD: "H", INTERMEDIATE: "I", WET: "W" };

export function TyreChip({ compound, age, label }: { compound?: string | null; age?: number | null; label?: boolean }) {
  if (!compound) return <span className="tyre none">—</span>;
  return (
    <span className={`tyre c-${compound.toLowerCase()}`} title={`${compound}${age != null ? `, ${age} laps old` : ""}`}>
      <span className="ring" aria-hidden="true">{LETTER[compound] ?? "?"}</span>
      <span className={label ? "" : "sr"}>{compound.toLowerCase()}</span>
      {age != null && <span className="num age">{age}</span>}
    </span>
  );
}

const W = 720;

function groupBy(rows: Row[]) {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.code as string;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

export function LapChart({ rows, selected, total }: { rows: Row[]; selected: string[]; total: number }) {
  const H = 300;
  const pad = { l: 28, r: 46, t: 10, b: 22 };
  const x = (lap: number) => pad.l + ((lap - 1) / (total - 1)) * (W - pad.l - pad.r);
  const y = (pos: number) => pad.t + ((pos - 1) / 19) * (H - pad.t - pad.b);
  const by = groupBy(rows);
  const order = [...by.keys()].sort((a, b) => Number(selected.includes(a)) - Number(selected.includes(b)));
  const lastLap = rows.length ? (rows[rows.length - 1].lap_number as number) : 0;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lap chart through lap ${lastLap}; highlighted: ${selected.join(", ") || "none"}`}>
      {[1, 5, 10, 15, 20].map((p) => (
        <g key={p} className="axis">
          <line x1={pad.l} x2={W - pad.r} y1={y(p)} y2={y(p)} />
          <text x={pad.l - 6} y={y(p) + 4} textAnchor="end">{p}</text>
        </g>
      ))}
      {[1, 10, 20, 30, 40, 53].map((l) => (
        <text key={l} className="axis" x={x(l)} y={H - 6} textAnchor="middle">{l}</text>
      ))}
      {order.map((code) => {
        const pts = by.get(code)!;
        const on = selected.includes(code);
        const d = pts.map((r, i) => `${i ? "L" : "M"}${x(r.lap_number as number).toFixed(1)},${y(r.pos as number).toFixed(1)}`).join("");
        const last = pts[pts.length - 1];
        return (
          <g key={code} className={on ? "trace on" : "trace"}>
            <path d={d} style={on ? { stroke: last.colour as string } : undefined} />
            {on && (
              <text x={x(last.lap_number as number) + 6} y={y(last.pos as number) + 4} style={{ fill: last.colour as string }}>{code}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function PaceChart({ rows, selected, total }: { rows: Row[]; selected: string[]; total: number }) {
  const H = 220;
  const pad = { l: 46, r: 46, t: 10, b: 22 };
  const sel = rows.filter((r) => selected.includes(r.code as string) && r.avg5 != null);
  const vals = sel.map((r) => r.avg5 as number);
  const lo = vals.length ? Math.floor(Math.min(...vals) * 2) / 2 : 80;
  const hi = vals.length ? Math.ceil(Math.max(...vals) * 2) / 2 : 90;
  const x = (lap: number) => pad.l + ((lap - 1) / (total - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + ((v - lo) / Math.max(0.5, hi - lo)) * (H - pad.t - pad.b);
  const by = groupBy(sel);
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rolling five-lap pace for ${selected.join(", ") || "no drivers"}; faster is higher`}>
      {ticks.map((v) => (
        <g key={v} className="axis">
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(1)}</text>
        </g>
      ))}
      {[1, 10, 20, 30, 40, 53].map((l) => (
        <text key={l} className="axis" x={x(l)} y={H - 6} textAnchor="middle">{l}</text>
      ))}
      {[...by.entries()].map(([code, pts]) => {
        const colour = pts[0].colour as string;
        const last = pts[pts.length - 1];
        return (
          <g key={code} className="trace on">
            <path d={pts.map((r, i) => `${i ? "L" : "M"}${x(r.lap_number as number).toFixed(1)},${y(r.avg5 as number).toFixed(1)}`).join("")} style={{ stroke: colour }} />
            {pts.map((r) => (
              <circle key={r.lap_number as number} cx={x(r.lap_number as number)} cy={y(r.avg5 as number)} r="2.6" className={`pt c-${String(r.compound).toLowerCase()}`} />
            ))}
            <text x={x(last.lap_number as number) + 6} y={y(last.avg5 as number) + 4} style={{ fill: colour }}>{code}</text>
          </g>
        );
      })}
      {!sel.length && <text className="axis" x={W / 2} y={H / 2} textAnchor="middle">Select drivers in the timing tower</text>}
    </svg>
  );
}
