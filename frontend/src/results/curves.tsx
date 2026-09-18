/* Time-series panels: thrust, pressure and Kn, per-grain flux and Mach. */

import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";
import { Plot } from "@/components/charts/Plot";
import { LIMIT, SERIES, axis, baseLayout, css, hline, ramp } from "@/components/charts/theme";
import { Empty } from "@/components/ui";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import type { Ctx } from "./context";

export function ThrustCurve({ ctx }: { ctx: Ctx }) {
  const theme = useApp(s => s.theme);
  const { data, layout } = useMemo(() => {
    const d = ctx.design, b = ctx.baseline, c = ctx.compare;
    const series = SERIES();
    const data: Data[] = [];
    if (b?.curves) data.push({ x: b.curves.time, y: b.curves.thrust, mode: "lines", type: "scatter", name: "your motor",
      line: { color: css("--ink-3"), width: 1.5, dash: "dot" } });
    if (d?.curves) data.push({ x: d.curves.time, y: d.curves.thrust, mode: "lines", type: "scatter", name: "optimized",
      line: { color: series[0], width: 2.2 } });
    if (c?.curves) data.push({ x: c.curves.time, y: c.curves.thrust, mode: "lines", type: "scatter",
      name: "Option " + ((ctx.compareIndex ?? 0) + 1), line: { color: LIMIT(), width: 2, dash: "dash" } });
    const layout: Partial<Layout> = { ...baseLayout(), showlegend: true,
      xaxis: axis("Time (s)"), yaxis: axis("Thrust (N)", { rangemode: "tozero" }) };
    return { data, layout };
  }, [ctx.design, ctx.baseline, ctx.compare, ctx.compareIndex, theme]);
  if (!data.length) return <Empty>No curves yet.</Empty>;
  return <Plot data={data} layout={layout} />;
}

export function PressureKn({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const d = ctx.design;
  const { data, layout } = useMemo(() => {
    if (!d?.curves) return { data: [] as Data[], layout: {} as Partial<Layout> };
    const U = units.sys;
    const series = SERIES();
    const t = baseLayout();
    const data: Data[] = [
      { x: d.curves.time, y: d.curves.pressure.map(p => p / U.pressure.scale), mode: "lines", type: "scatter", name: "pressure",
        line: { color: series[1], width: 2 }, xaxis: "x", yaxis: "y" },
      { x: d.curves.time, y: d.curves.kn, mode: "lines", type: "scatter", name: "Kn",
        line: { color: series[2], width: 2 }, xaxis: "x2", yaxis: "y2" },
    ];
    const c = ctx.compare;
    if (c?.curves) {
      const label = "Option " + ((ctx.compareIndex ?? 0) + 1);
      data.push({ x: c.curves.time, y: c.curves.pressure.map(p => p / U.pressure.scale), mode: "lines", type: "scatter",
        name: label + " pressure", xaxis: "x", yaxis: "y", line: { color: LIMIT(), width: 1.6, dash: "dash" } });
      data.push({ x: c.curves.time, y: c.curves.kn, mode: "lines", type: "scatter", name: label + " Kn",
        xaxis: "x2", yaxis: "y2", line: { color: LIMIT(), width: 1.6, dash: "dash" } });
    }
    const shapes = ctx.constraints.flatMap(con =>
      con.metric === "max_pressure" ? [hline(con.value / U.pressure.scale, "y")]
      : con.metric === "peak_kn" ? [hline(con.value, "y2")] : []);
    const layout: Partial<Layout> = {
      ...t,
      grid: { rows: 2, columns: 1, pattern: "independent", roworder: "top to bottom" },
      margin: { l: 54, r: 16, t: 8, b: 38 },
      xaxis: { ...(t.xaxis as object), anchor: "y", showticklabels: false },
      yaxis: { ...(t.yaxis as object), title: { text: U.pressure.label }, domain: [0.56, 1] },
      xaxis2: { ...(t.xaxis as object), anchor: "y2", title: { text: "Time (s)" } },
      yaxis2: { ...(t.yaxis as object), title: { text: "Kn" }, domain: [0, 0.44] },
      shapes,
    };
    return { data, layout };
  }, [d, ctx.compare, ctx.compareIndex, ctx.constraints, units, theme]);
  if (!data.length) return <Empty>No curves for this design yet.</Empty>;
  return <Plot data={data} layout={layout} />;
}

function perGrain(ctx: Ctx, key: "mass_flux" | "mach", scale: number, title: string, limitMetric: string) {
  const d = ctx.design;
  const rows = d?.curves?.[key];
  if (!d?.curves || !rows?.length) return null;
  const n = rows.length;
  const R = ramp();
  const data: Data[] = rows.map((series, i) => ({
    x: d.curves!.time, y: series.map(v => v / scale), mode: "lines", type: "scatter", name: "grain " + (i + 1),
    line: { color: R[Math.round(i * (R.length - 1) / Math.max(n - 1, 1))], width: 1.8 },
  }));
  const shapes = ctx.constraints.filter(c => c.metric === limitMetric).map(c => hline(c.value / scale, "y"));
  const layout: Partial<Layout> = { ...baseLayout(), showlegend: true, shapes,
    xaxis: axis("Time (s)"), yaxis: axis(title, { rangemode: "tozero" }) };
  return { data, layout };
}

export function GrainFlux({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const built = useMemo(() => perGrain(ctx, "mass_flux", units.sys.mass_flux.scale, units.sys.mass_flux.label, "peak_mass_flux"),
    [ctx, units, theme]);
  if (!built) return <Empty>No flux data.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}

export function GrainMach({ ctx }: { ctx: Ctx }) {
  const theme = useApp(s => s.theme);
  const built = useMemo(() => perGrain(ctx, "mach", 1, "Mach", "peak_mach"), [ctx, theme]);
  if (!built) return <Empty>No Mach data.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}
