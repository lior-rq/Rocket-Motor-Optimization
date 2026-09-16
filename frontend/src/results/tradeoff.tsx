/* The trade-off explorer: the front, the whole population, parallel
   coordinates and the spread. */

import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";
import { Plot } from "@/components/charts/Plot";
import { LIMIT, SERIES, axis, baseLayout, css, ramp } from "@/components/charts/theme";
import { Empty } from "@/components/ui";
import { shortVar } from "@/lib/format";
import type { PopulationRow } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import type { Ctx } from "./context";

export function ParetoFront({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const select = useApp(s => s.selectDesign);
  const compare = useApp(s => s.compareDesign);
  const highlight = useApp(s => s.highlightDesign);
  const designs = ctx.designs;
  const { data, layout } = useMemo(() => {
    const [ax, ay] = ctx.axes;
    const sel = ctx.selected, cmp = ctx.compareIndex;
    const series = SERIES();
    const mv = (d: PopulationRow | typeof designs[number], k: string) => units.metricToDisplay(k, d[k] as number);
    const data: Data[] = [{
      x: designs.map(d => mv(d, ax)), y: designs.map(d => mv(d, ay)),
      mode: "lines+markers", type: "scatter",
      marker: {
        size: designs.map((_, i) => i === sel ? 15 : (i === cmp ? 13 : 9)),
        color: designs.map((_, i) => i === cmp ? LIMIT() : series[0]),
        line: { color: designs.map((_, i) => i === sel ? css("--ink") : css("--bg")),
                width: designs.map((_, i) => i === sel ? 2.5 : 1.5) },
      },
      line: { color: series[0], width: 1.5 },
      text: designs.map((d, i) => (d.designation || "Option " + (i + 1))
        + (i === sel ? " · selected" : i === cmp ? " · comparing" : "")),
      name: "options",
      hovertemplate: "%{text}<br>" + units.metricLabel(ax) + ": %{x:,.0f}<br>" + units.metricLabel(ay) + ": %{y:,.0f}<extra></extra>",
    }];
    if (ctx.baseline) data.push({
      x: [mv(ctx.baseline, ax)], y: [mv(ctx.baseline, ay)], mode: "markers", type: "scatter", name: "your motor",
      marker: { size: 13, symbol: "diamond", color: LIMIT(), line: { color: css("--bg"), width: 1.5 } },
      hovertemplate: "your motor<extra></extra>",
    });
    const layout: Partial<Layout> = { ...baseLayout(), showlegend: true,
      xaxis: axis(units.axisTitle(ax)), yaxis: axis(units.axisTitle(ay)) };
    return { data, layout };
  }, [designs, ctx.axes, ctx.selected, ctx.compareIndex, ctx.baseline, units, theme]);
  if (!designs.length) return <Empty>No feasible designs.</Empty>;
  return (
    <Plot data={data} layout={layout}
      onClick={ev => {
        const p = ev.points[0];
        if (p.curveNumber !== 0) return;
        const shift = (ev.event as MouseEvent | undefined)?.shiftKey;
        if (shift) compare(p.pointIndex); else select(p.pointIndex);
      }}
      onHover={ev => { const p = ev.points[0]; if (p.curveNumber === 0) highlight(p.pointIndex); }}
      onUnhover={() => highlight(null)} />
  );
}

export function PopulationCloud({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const pop = ctx.population;
  const { data, layout } = useMemo(() => {
    const [ax, ay] = ctx.axes;
    const series = SERIES();
    const mv = (r: PopulationRow, k: string) => units.metricToDisplay(k, r[k] as number);
    const ok = pop.filter(r => r.feasible), bad = pop.filter(r => !r.feasible);
    const data: Data[] = [
      { x: bad.map(r => mv(r, ax)), y: bad.map(r => mv(r, ay)), mode: "markers", type: "scatter", name: "over a limit",
        marker: { size: 3.5, color: css("--ink-3"), opacity: 0.5 }, hoverinfo: "skip" },
      { x: ok.map(r => mv(r, ax)), y: ok.map(r => mv(r, ay)), mode: "markers", type: "scatter", name: "legal",
        marker: { size: 4, color: series[0], opacity: 0.55 }, hoverinfo: "skip" },
    ];
    if (ctx.baseline) data.push({
      x: [units.metricToDisplay(ax, ctx.baseline[ax] as number)], y: [units.metricToDisplay(ay, ctx.baseline[ay] as number)],
      mode: "markers", type: "scatter", name: "your motor",
      marker: { size: 13, symbol: "diamond", color: LIMIT(), line: { color: css("--bg"), width: 1.5 } },
    });
    const layout: Partial<Layout> = { ...baseLayout(), showlegend: true,
      xaxis: axis(units.axisTitle(ax)), yaxis: axis(units.axisTitle(ay)) };
    return { data, layout };
  }, [pop, ctx.axes, ctx.baseline, units, theme]);
  if (!pop.length) return <Empty>No population recorded.</Empty>;
  return <Plot data={data} layout={layout} />;
}

export function ObjectiveSpread({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const pop = ctx.population;
  const { data, layout } = useMemo(() => {
    const key = ctx.axes[0];
    const mv = (r: PopulationRow) => units.metricToDisplay(key, r[key] as number);
    const data: Data[] = [
      { x: pop.filter(r => !r.feasible).map(mv), type: "histogram", name: "over a limit",
        marker: { color: css("--ink-3") }, opacity: 0.6, nbinsx: 40 } as Data,
      { x: pop.filter(r => r.feasible).map(mv), type: "histogram", name: "legal",
        marker: { color: SERIES()[0] }, opacity: 0.85, nbinsx: 40 } as Data,
    ];
    const layout: Partial<Layout> = { ...baseLayout(), barmode: "overlay", showlegend: true,
      xaxis: axis(units.axisTitle(key)), yaxis: axis("designs") };
    return { data, layout };
  }, [pop, ctx.axes, units, theme]);
  if (!pop.length) return <Empty>No population recorded.</Empty>;
  return <Plot data={data} layout={layout} />;
}

/** Each line is one legal design, coloured by how well it scored. Each axis
    gets its own scale; a shared one would flatten every dimension whose
    range is small next to the largest. */
export function ParallelCoords({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const pop = ctx.population.filter(r => r.feasible);
  if (pop.length < 5) return <Empty>Not enough legal designs to compare yet.</Empty>;
  const vars = ctx.searched.filter(v => pop[0][v] !== undefined);
  if (!vars.length) return <Empty>No searched dimensions.</Empty>;
  const colourBy = ctx.axes[0];
  const W = 760, H = 312, padL = 26, padR = 26, padT = 48, padB = 46;
  const n = vars.length;
  const step = (W - padL - padR) / Math.max(n - 1, 1);
  const y0 = padT, y1 = H - padB;
  const scales = vars.map(v => {
    const values = pop.map(r => r[v] as number);
    let lo = Math.min(...values), hi = Math.max(...values);
    if (hi - lo < 1e-12) hi = lo + 1;
    return { lo, hi };
  });
  const R = ramp();
  const cValues = pop.map(r => units.metricToDisplay(colourBy, r[colourBy] as number));
  const cLo = Math.min(...cValues), cHi = Math.max(...cValues);
  const colourAt = (v: number) => {
    const t = (cHi - cLo) < 1e-12 ? 1 : (v - cLo) / (cHi - cLo);
    return R[Math.min(R.length - 1, Math.floor(t * R.length))];
  };
  const shown = pop.length > 700 ? pop.filter((_, i) => i % Math.ceil(pop.length / 700) === 0) : pop;
  const fmt = (v: string, q: number) => v === "exit_frac" ? q.toFixed(2)
    : v === "n_grains" ? String(Math.round(q)) : units.toDisplay(q).toFixed(units.lenDigits);
  const keyX = padL + 34;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full max-w-[900px] mx-auto" role="img"
         aria-label="Parallel coordinates of legal designs">
      {shown.map((r, k) => (
        <polyline key={k} fill="none" strokeWidth="0.9" opacity="0.42"
          stroke={colourAt(units.metricToDisplay(colourBy, r[colourBy] as number))}
          points={vars.map((v, i) => {
            const s = scales[i];
            const y = y1 - (((r[v] as number) - s.lo) / (s.hi - s.lo)) * (y1 - y0);
            return (padL + i * step).toFixed(1) + "," + y.toFixed(1);
          }).join(" ")} />
      ))}
      {vars.map((v, i) => {
        const x = padL + i * step, s = scales[i];
        return (
          <g key={v}>
            <line x1={x} y1={y0} x2={x} y2={y1} stroke="var(--line)" strokeWidth="1" />
            <text x={x} y={y0 - 9} fontSize="8.5" fill="var(--ink-3)" textAnchor="middle" fontFamily="var(--mono)">{fmt(v, s.hi)}</text>
            <text x={x} y={y1 + 13} fontSize="8.5" fill="var(--ink-3)" textAnchor="middle" fontFamily="var(--mono)">{fmt(v, s.lo)}</text>
            <text x={x} y={y1 + 30} fontSize="9.5" fill="var(--ink-2)" textAnchor="middle" fontFamily="var(--sans)">{shortVar(v)}</text>
          </g>
        );
      })}
      {R.map((c, i) => <rect key={i} x={keyX + i * 14} y="10" width="13" height="6" fill={c} />)}
      <text x={keyX - 5} y="16" fontSize="8.5" fill="var(--ink-3)" textAnchor="end" fontFamily="var(--sans)">worse</text>
      <text x={keyX + R.length * 14 + 5} y="16" fontSize="8.5" fill="var(--ink-3)" fontFamily="var(--sans)">better</text>
    </svg>
  );
}
