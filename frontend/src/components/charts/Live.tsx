/* The running screen's pieces: the population as it moves, what is blocking
   designs, how fast it is going, and the best so far. */

import type { Data, Layout } from "plotly.js";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import type { Telemetry } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { Plot, Plotly } from "./Plot";
import { LIMIT, SERIES, axis, baseLayout, css } from "./theme";

export type Range = { x: [number, number]; y: [number, number] };

/** Impulse reads as the horizontal axis and thrust as the vertical one, so
    the pair is always drawn that way whichever order the run reports. */
export function orderAxes(pair: string[]): [string, string] {
  const [a, b] = pair;
  return (b === "total_impulse" && a !== "total_impulse") ? [b, a] : [a, b];
}

/** A snapshot arrives in SI. Everything drawn from it is in display units. */
export interface ShownSnap {
  metrics: [string, string];
  points: [number, number, boolean][];
  front: [number, number][];
  best: [number, number] | null;
  baseline: [number, number] | null;
  trace: { a: number; b: number }[];
  seed_index: number;
}

export function useShownSnap(raw: Telemetry | null): ShownSnap | null {
  const units = useUnits();
  const motor = useApp(s => s.motor);
  return useMemo(() => {
    if (!raw) return null;
    const [mx, my] = raw.metrics;
    const cx = (v: number) => units.metricToDisplay(mx, v), cy = (v: number) => units.metricToDisplay(my, v);
    let baseline: [number, number] | null = null;
    if (motor) {
      const bx = motor[mx] as number, by = motor[my] as number;
      if (Number.isFinite(bx) && Number.isFinite(by)) baseline = [cx(bx), cy(by)];
    }
    return {
      metrics: raw.metrics,
      points: (raw.points ?? []).map(p => [cx(p[0]), cy(p[1]), p[2]] as [number, number, boolean]),
      front: (raw.front ?? []).map(p => [cx(p[0]), cy(p[1])] as [number, number]),
      best: raw.best ? [cy(raw.best[0]), cx(raw.best[1])] : null,
      baseline,
      trace: (raw.trace ?? []).map(r => ({ a: cy(r.a), b: cx(r.b) })),
      seed_index: raw.seed_index,
    };
  }, [raw, units, motor]);
}

/** Everything drawn, plus a tenth of the span so nothing sits on the frame. */
export function fitRange(t: ShownSnap): Range | null {
  const [ax] = orderAxes(t.metrics);
  const flip = ax !== t.metrics[0];
  const xs: number[] = [], ys: number[] = [];
  const add = (p: [number, number, ...unknown[]]) => { xs.push(flip ? p[1] : p[0]); ys.push(flip ? p[0] : p[1]); };
  t.points.forEach(add);
  t.front.forEach(add);
  if (t.baseline) add(t.baseline);
  if (!xs.length) return null;
  const span = (v: number[]): [number, number] => {
    const lo = Math.min(...v), hi = Math.max(...v);
    const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.01, 1e-9);
    return [lo - pad, hi + pad];
  };
  return { x: span(xs), y: span(ys) };
}

export function LivePlot({ snap, range, epoch, fitKey }:
  { snap: ShownSnap; range: Range | null; epoch: number; fitKey: number }) {
  const units = useUnits();
  const unit = useApp(s => s.unit);
  const ghosts = useRef<{ epoch: number; seed: number; unit: string; frames: [number, number][][] }>(
    { epoch: -1, seed: -1, unit: "", frames: [] });
  const host = useRef<HTMLDivElement>(null);

  const { data, layout } = useMemo(() => {
    const [ax, ay] = orderAxes(snap.metrics);
    // Every series arrives in the run's own metric order, so putting impulse
    // on the horizontal axis has to move the data as well as the labels.
    const flip = ax !== snap.metrics[0];
    type Pt = [number, number, boolean];
    type XY = [number, number];
    const xy = <T extends Pt | XY>(p: T): T => (flip ? [p[1], p[0], ...p.slice(2)] : p) as T;
    const g = ghosts.current;
    // A new seed starts somewhere else entirely; carrying its predecessor's
    // trail over would read as one search teleporting.
    // The range goes out with the first frame only. Re-sending it every
    // frame fought the user's own pan; after that uirevision carries the
    // axes across updates.
    const fresh = g.epoch !== epoch || g.unit !== unit;
    if (fresh || g.seed !== snap.seed_index) { g.frames = []; g.epoch = epoch; g.seed = snap.seed_index; g.unit = unit; }
    const points = snap.points.map(xy);
    const front = snap.front.map(xy);
    const baseline = snap.baseline ? xy(snap.baseline) : null;
    const feas = points.filter(p => p[2]);
    const infeas = points.filter(p => !p[2]);
    g.frames.push(feas.map(p => [p[0], p[1]]));
    if (g.frames.length > 14) g.frames.shift();
    const series = SERIES();
    // Older generations fade out, so the population leaves a wake and you
    // can see which way the search is travelling.
    const trails: Data[] = g.frames.slice(0, -1).map((f, i) => ({
      x: f.map(p => p[0]), y: f.map(p => p[1]), mode: "markers", type: "scatter",
      marker: { size: 4, color: series[0], opacity: 0.05 + 0.16 * (i / Math.max(g.frames.length - 1, 1)) },
      hoverinfo: "skip", showlegend: false,
    }));
    const data: Data[] = [...trails,
      { x: infeas.map(p => p[0]), y: infeas.map(p => p[1]), mode: "markers", name: "over a limit", type: "scatter",
        marker: { size: 5, color: css("--ink-3"), opacity: 0.38 }, hoverinfo: "skip" },
      { x: feas.map(p => p[0]), y: feas.map(p => p[1]), mode: "markers", name: "legal", type: "scatter",
        marker: { size: 7, color: series[0], opacity: 0.9, line: { color: css("--bg"), width: 1 } }, hoverinfo: "skip" },
      { x: baseline ? [baseline[0]] : [], y: baseline ? [baseline[1]] : [], mode: "markers", name: "your motor", type: "scatter",
        marker: { size: 11, color: LIMIT(), symbol: "diamond", line: { color: css("--bg"), width: 1.5 } }, hoverinfo: "skip" },
      { x: front.map(p => p[0]), y: front.map(p => p[1]), mode: "lines+markers", name: "best so far", type: "scatter",
        line: { color: series[1], width: 2 }, marker: { size: 7, color: series[1], line: { color: css("--bg"), width: 1 } },
        hoverinfo: "skip" },
    ];
    const layout: Partial<Layout> = {
      ...baseLayout(), showlegend: true, margin: { l: 70, r: 18, t: 8, b: 52 },
      uirevision: "live-" + unit, dragmode: "pan",
      xaxis: axis(units.axisTitle(ax), fresh && range ? { range: [...range.x] } : {}),
      yaxis: axis(units.axisTitle(ay), fresh && range ? { range: [...range.y] } : {}),
    };
    return { data, layout };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, epoch, unit, units, range]);

  const config = useMemo(() => ({ scrollZoom: true }), []);

  // The range is set once, on the first frame; after that the axes belong
  // to the user, and uirevision carries them across updates.
  useEffect(() => {
    if (!fitKey || !range) return;
    const node = host.current?.firstElementChild as HTMLElement | null;
    if (node) Plotly.relayout(node, { "xaxis.range": [range.x[0], range.x[1]], "yaxis.range": [range.y[0], range.y[1]] });
  }, [fitKey, range]);

  return (
    <div ref={host}>
      <Plot data={data} layout={layout} className="tall" freshKey={epoch + ":" + unit} config={config} />
    </div>
  );
}

/** A 240-degree sweep on a fixed 0-100 scale. The reading sits under the
    dial rather than inside it, so the needle never crosses its own number. */
const SPEED_MAX = 100;

export function Speedometer({ value, label }: { value: number; label: string }) {
  const W = 180, H = 116, cx = 90, cy = 86, r = 66;
  const START = 210, SWEEP = 240;
  const frac = Math.max(0, Math.min(value / SPEED_MAX, 1));
  const pt = (deg: number, rad: number): [number, number] => {
    const a = deg * Math.PI / 180;
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  const arc = (from: number, to: number, rad: number) => {
    const [x0, y0] = pt(from, rad), [x1, y1] = pt(to, rad);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rad} ${rad} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const end = START - SWEEP;
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const deg = START - SWEEP * i / 4;
    const [x0, y0] = pt(deg, r - 10), [x1, y1] = pt(deg, r - 3), [lx, ly] = pt(deg, r - 20);
    return (
      <g key={i}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--ink-3)" strokeWidth="1.2" opacity=".45" />
        <text x={lx} y={ly + 3} textAnchor="middle" fontFamily="var(--mono)" fontSize="7.5" fill="var(--ink-3)">
          {(SPEED_MAX * i / 4).toFixed(0)}</text>
      </g>
    );
  });
  // The needle's tip springs between readings; motion animates SVG
  // attributes directly, where a transform on <g> is not honoured.
  const [nx, ny] = pt(START - SWEEP * frac, r - 27);
  const total = 2 * Math.PI * r * (SWEEP / 360);
  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[220px]" role="img" aria-label={`${label}: ${value.toFixed(1)}`}>
        <path d={arc(START, end, r)} fill="none" stroke="var(--surface-3)" strokeWidth="8" strokeLinecap="round" />
        <motion.path d={arc(START, end, r)} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 6px var(--accent-glow))" }}
          strokeDasharray={total} initial={false} animate={{ strokeDashoffset: total * (1 - frac) }}
          transition={{ type: "spring", stiffness: 90, damping: 20 }} />
        {ticks}
        <motion.line x1={cx} y1={cy} initial={false} animate={{ x2: nx, y2: ny }}
          transition={{ type: "spring", stiffness: 90, damping: 18 }}
          stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4.5" fill="var(--ink)" />
        <circle cx={cx} cy={cy} r="2" fill="var(--bg)" />
      </svg>
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className="num text-[22px] font-semibold">{value ? value.toFixed(1) : "—"}</span>
        <span className="text-[11.5px] text-ink-3">{label}</span>
      </div>
    </div>
  );
}

/** Which limit is stopping designs right now. */
export function Blocking({ rows }: { rows: Telemetry["blocking"] | undefined }) {
  const units = useUnits();
  if (!rows?.length) return <p className="text-ink-3 text-[12.5px]">Waiting for the first generation&hellip;</p>;
  const sorted = rows.slice().sort((a, b) => b.share - a.share);
  return (
    <div className="flex flex-col gap-2">
      {sorted.map(r => {
        const pct = Math.round(r.share * 100);
        return (
          <motion.div key={r.metric + r.op} layout className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-center text-[12.5px]">
            <span className="text-ink-2 truncate">{units.metricLabel(r.metric)}</span>
            <span className="num">{pct}%</span>
            <div className="track col-span-2"><motion.div className={"fill" + (pct > 60 ? " hot" : "")}
              initial={false} animate={{ width: pct + "%" }} transition={{ type: "spring", stiffness: 120, damping: 24 }} /></div>
          </motion.div>
        );
      })}
      <p className="text-[11.5px] text-ink-3">Share of this generation that each limit rules out. A limit near 100% is the one the search is fighting.</p>
    </div>
  );
}

/** Best-so-far only ever climbs, within a narrow band; the box is fitted to
    that band so every step shows. */
export function Spark({ trace }: { trace: { a: number }[] }) {
  if (!trace || trace.length < 2) return null;
  const running: number[] = [];
  let best = -Infinity;
  trace.forEach(t => { best = Math.max(best, t.a); running.push(best); });
  const lo = Math.min(...running), hi = Math.max(...running);
  const pad = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.004, 1e-6);
  const W = 320, H = 64;
  const x = (i: number) => (i / (running.length - 1)) * W;
  const y = (v: number) => H - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * H;
  let d = `M 0 ${y(running[0]).toFixed(1)}`;
  running.forEach((v, i) => { if (i) d += ` H ${x(i).toFixed(1)} V ${y(v).toFixed(1)}`; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--series-2)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--series-2)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={d + ` V ${H} H 0 Z`} fill="url(#spark-fill)" />
      <motion.path d={d} fill="none" stroke="var(--series-2)" strokeWidth="2" vectorEffect="non-scaling-stroke"
                   initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6 }} />
    </svg>
  );
}
