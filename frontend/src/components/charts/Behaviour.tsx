/* One axis, thrust, with pressure, Kn and mass flux drawn against it. Each
   curve is scaled to the thrust range so the shapes are comparable; the
   tooltip and the legend both carry the real value. */

import type { Data, Layout } from "plotly.js";
import { useMemo } from "react";
import { fmtNum } from "@/lib/format";
import type { ConstraintSpec, Curves } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { Plot } from "./Plot";
import { LIMIT, SERIES, axis, baseLayout, hline } from "./theme";

type Key = "thrust" | "pressure" | "kn" | "mass_flux";

function worstFlux(c: Curves, scale: number): number[] {
  const grains = (c.mass_flux ?? []).filter(g => g && g.length);
  if (!grains.length) return [];
  return c.time.map((_, i) => Math.max(...grains.map(g => (g[i] || 0) / scale)));
}

export function BehaviourStack({ curves, constraints = [], keys, className }:
  { curves: Curves | null | undefined; constraints?: ConstraintSpec[]; keys: Key[]; className?: string }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const { data, layout } = useMemo(() => {
    if (!curves || !curves.time?.length) return { data: [] as Data[], layout: {} as Partial<Layout> };
    const U = units.sys;
    const series = SERIES();
    const rows: Record<Key, { title: string; colour: string; data: number[]; limits: string[]; scale: (v: number) => number }> = {
      thrust: { title: "Thrust (N)", colour: series[0], data: curves.thrust, limits: [], scale: v => v },
      pressure: { title: `Pressure (${U.pressure.label})`, colour: series[1],
                  data: curves.pressure.map(v => v / U.pressure.scale),
                  limits: ["max_pressure", "avg_pressure"], scale: v => v / U.pressure.scale },
      kn: { title: "Kn", colour: series[2], data: curves.kn, limits: ["peak_kn"], scale: v => v },
      mass_flux: { title: `Mass flux (${U.mass_flux.label})`, colour: LIMIT(),
                   data: worstFlux(curves, U.mass_flux.scale), limits: ["peak_mass_flux"],
                   scale: v => v / U.mass_flux.scale },
    };
    const present = keys.filter(k => rows[k].data.length);
    const peak = (arr: number[]) => Math.max(...arr.map(Math.abs)) || 1;
    const anchor = peak(rows.thrust.data.length ? rows.thrust.data : rows[present[0]].data);
    const data: Data[] = present.map(key => {
      const row = rows[key];
      const top = peak(row.data);
      const scale = key === "thrust" ? 1 : anchor / top;
      const unit = row.title.replace(/^[^(]*\(?|\)$/g, "") || "";
      return {
        x: curves.time, y: row.data.map(v => v * scale), customdata: row.data,
        mode: "lines", type: "scatter", line: { color: row.colour, width: 2 },
        name: key === "thrust" ? row.title : row.title + "  •  peak " + fmtNum(top),
        hovertemplate: "%{customdata:,.4~r} " + unit + "<extra></extra>",
      };
    });
    const shapes = constraints.filter(c => c.enabled).flatMap(con => {
      const key = present.find(k => rows[k].limits.includes(con.metric));
      if (!key) return [];
      const scale = key === "thrust" ? 1 : anchor / peak(rows[key].data);
      return [hline(rows[key].scale(con.value) * scale, "y")];
    });
    const layout: Partial<Layout> = {
      ...baseLayout(), showlegend: true, hovermode: "x unified", shapes,
      xaxis: axis("Time (s)"), yaxis: axis("Thrust (N)", { rangemode: "tozero" }),
    };
    return { data, layout };
  }, [curves, constraints, keys, units, theme]);
  if (!data.length) return null;
  return <Plot data={data} layout={layout} className={className} />;
}
