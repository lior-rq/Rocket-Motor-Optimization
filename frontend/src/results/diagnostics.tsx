/* How the optimiser behaved: convergence, model accuracy, importances,
   binding limits, grain counts, and the tornado. */

import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";
import { Plot } from "@/components/charts/Plot";
import { LIMIT, SERIES, axis, baseLayout, css } from "@/components/charts/theme";
import { Empty } from "@/components/ui";
import { shortVar } from "@/lib/format";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import type { Ctx } from "./context";

export function Convergence({ ctx }: { ctx: Ctx }) {
  const theme = useApp(s => s.theme);
  const c = ctx.convergence;
  const built = useMemo(() => ({
    data: [{ x: c.map(p => p.n), y: c.map(p => p.best), mode: "lines", type: "scatter",
             line: { color: SERIES()[0], width: 2 }, name: "best so far" }] as Data[],
    layout: { ...baseLayout(), xaxis: axis("simulations", { type: "log" }), yaxis: axis("score") } as Partial<Layout>,
  }), [c, theme]);
  if (!c.length) return <Empty>No convergence data.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function Parity({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const s = ctx.surrogate;
  const built = useMemo(() => {
    if (!s?.parity) return null;
    const key = ctx.axes[0] in s.parity ? ctx.axes[0] : Object.keys(s.parity)[0];
    const p = s.parity[key];
    const lo = Math.min(...p.actual), hi = Math.max(...p.actual);
    return {
      data: [
        { x: p.actual, y: p.predicted, mode: "markers", type: "scatter", name: key,
          marker: { size: 4, color: SERIES()[0], opacity: 0.35 }, hoverinfo: "skip" },
        { x: [lo, hi], y: [lo, hi], mode: "lines", type: "scatter", name: "perfect",
          line: { color: css("--ink-3"), width: 1, dash: "dash" }, hoverinfo: "skip" },
      ] as Data[],
      layout: { ...baseLayout(), xaxis: axis("simulated " + units.metricLabel(key)), yaxis: axis("predicted") } as Partial<Layout>,
    };
  }, [s, ctx.axes, units, theme]);
  if (!built) return <Empty>Only trained in full trade-off mode. Turn on the surrogate search to see this.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function Importance({ ctx }: { ctx: Ctx }) {
  const theme = useApp(s => s.theme);
  const s = ctx.surrogate;
  const built = useMemo(() => {
    if (!s?.importances) return null;
    const rows = s.importances.slice(0, 10).reverse();
    return {
      data: [{ type: "bar", orientation: "h", y: rows.map(r => shortVar(r.feature)), x: rows.map(r => r.importance),
               marker: { color: SERIES()[0] }, hovertemplate: "%{y}: %{x:.3f}<extra></extra>" }] as Data[],
      layout: { ...baseLayout(), margin: { l: 108, r: 16, t: 8, b: 38 },
                xaxis: axis("importance"), yaxis: axis(undefined, { automargin: true }) } as Partial<Layout>,
    };
  }, [s, theme]);
  if (!built) return <Empty>Only measured in full trade-off mode.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function ConstraintActivity({ ctx }: { ctx: Ctx }) {
  const theme = useApp(s => s.theme);
  const rows = ctx.constraintActivity;
  const built = useMemo(() => {
    const sorted = rows.slice().sort((a, b) => a.binding_fraction - b.binding_fraction);
    return {
      data: [{ type: "bar", orientation: "h", y: sorted.map(r => r.label), x: sorted.map(r => r.binding_fraction * 100),
               marker: { color: sorted.map(r => r.binding_fraction > 0.4 ? LIMIT() : SERIES()[0]) },
               hovertemplate: "%{y}: %{x:.0f}% of legal designs are up against it<extra></extra>" }] as Data[],
      layout: { ...baseLayout(), margin: { l: 130, r: 16, t: 8, b: 38 },
                xaxis: axis("% of legal designs at the limit"), yaxis: axis(undefined, { automargin: true }) } as Partial<Layout>,
    };
  }, [rows, theme]);
  if (!rows.length) return <Empty>No limits set.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function Tornado({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const rows = ctx.sensitivity.slice(0, 9).reverse();
  const built = useMemo(() => {
    const series = SERIES();
    return {
      data: [
        { type: "bar", orientation: "h", name: "one step smaller", y: rows.map(r => shortVar(r.variable)), x: rows.map(r => r.down),
          marker: { color: series[1] }, hovertemplate: "%{y} smaller: %{x:+,.1f}<extra></extra>" },
        { type: "bar", orientation: "h", name: "one step larger", y: rows.map(r => shortVar(r.variable)), x: rows.map(r => r.up),
          marker: { color: series[0] }, hovertemplate: "%{y} larger: %{x:+,.1f}<extra></extra>" },
      ] as Data[],
      layout: { ...baseLayout(), barmode: "overlay", showlegend: true, margin: { l: 108, r: 16, t: 8, b: 38 },
                xaxis: axis("change in " + units.metricLabel(ctx.axes[0]), { zeroline: true }),
                yaxis: axis(undefined, { automargin: true }) } as Partial<Layout>,
    };
  }, [rows, ctx.axes, units, theme]);
  if (!rows.length) return <Empty>No sensitivity data.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function GrainCounts({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const info = ctx.grainCounts;
  if (!info || !info.free) return <Empty>The grain count was held at the file's value.</Empty>;
  const multi = (ctx.results.stats?.objective_labels ?? []).length > 1;
  const live = (info.stacks ?? []).filter(s => !s.dropped).length;
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead><tr><th className="n">grains</th><th className="n">length</th><th>outcome</th>
          <th className="n">{multi ? "hypervolume" : "best score"}</th><th></th><th className="n">sims</th></tr></thead>
        <tbody>
          {(info.stacks ?? []).map(s => {
            const s1 = s.stage1 ?? {};
            let outcome: string, why: string, cls = "";
            if (s.dropped) { outcome = "screened out"; why = s.dropped; }
            else if (s.carried) { outcome = "searched in full"; cls = "pick"; why = `${s.designs} legal design${s.designs === 1 ? "" : "s"}`; }
            else { outcome = "tried, not carried"; why = s1.rank ? `ranked ${s1.rank} of ${live} after ${info.stage_generations} generations` : ""; }
            const score = s1.score !== null && s1.score !== undefined ? s1.score.toFixed(3)
              : (s1.near !== null && s1.near !== undefined ? "no legal design" : "—");
            return (
              <tr key={s.n} className={cls}><td className="n">{s.n}</td><td className="n">{units.fmtLen(s.grain_length)}</td>
                <td>{outcome}</td><td className="n">{score}</td><td className="text-ink-3">{why}</td>
                <td className="n">{(s.simulations ?? 0).toLocaleString()}</td></tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[12px] text-ink-3 mt-2">Score is after the first {info.stage_generations} generations, on the
        same axes for every count. The {units.fmtLen(info.stack_length ?? 0)} stack length was held throughout.</p>
    </div>
  );
}
