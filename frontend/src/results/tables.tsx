/* The specification delta, the margin bars, the options table, and the
   cutaway of the selected design. */

import { motion } from "motion/react";
import { Bar, Button, Empty, cx } from "@/components/ui";
import type { ConstraintSpec, Design } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { Motor3D } from "@/three/Motor3D";
import type { Ctx } from "./context";

const SPEC_ROWS: [string, string, string | null, number | null][] = [
  ["n_grains", "Grains", "", 0],
  ["initial_thrust", "Initial thrust", "N", 0],
  ["total_impulse", "Total impulse", "N·s", 0],
  ["peak_thrust", "Peak thrust", "N", 0],
  ["isp", "Specific impulse", "s", 1],
  ["burn_time", "Burn time", "s", 2],
  ["max_pressure", "Peak pressure", null, null],
  ["initial_kn", "Initial Kn", "", 0],
  ["peak_kn", "Peak Kn", "", 0],
  ["peak_mass_flux", "Peak mass flux", null, null],
  ["peak_mach", "Peak core Mach", "M", 2],
  ["port_throat", "Port/throat", "", 2],
  ["prop_mass", "Propellant", "kg", 3],
  ["residual_pct", "Residual propellant", "%", 2],
];

export function SpecSheet({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const d = ctx.design, b = ctx.baseline;
  if (!d) return <Empty>Run the optimizer to compare.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead><tr><th></th><th className="n">yours</th><th className="n">optimized</th><th className="n">&Delta;</th><th></th></tr></thead>
        <tbody>
          {SPEC_ROWS.map(([key, label, fixedUnit, fixedDp]) => {
            if (d[key] === undefined || d[key] === null) return null;
            // A null unit means the row follows the chosen system.
            const unit = fixedUnit === null ? units.metricUnit(key) : fixedUnit;
            const dp = fixedDp === null ? units.metricDigits(key) : fixedDp;
            const a = b && b[key] !== undefined ? units.metricToDisplay(key, b[key] as number) : null;
            const v = units.metricToDisplay(key, d[key] as number);
            const pct = a ? (v / a - 1) * 100 : null;
            const cls = pct === null || Math.abs(pct) < 0.05 ? "" : (pct > 0 ? "pos" : "neg");
            return (
              <tr key={key}><td>{label}</td>
                <td className="n">{a !== null ? a.toFixed(dp) : "—"}</td>
                <td className="n font-semibold">{v.toFixed(dp)}</td>
                <td className={cx("n", cls)}>{pct === null ? "" : (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"}</td>
                <td className="text-ink-3">{unit}</td></tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MarginBars({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const d = ctx.design;
  if (!d) return null;
  const rows = ctx.constraints.map(c => marginRow(c, d, units)).filter(Boolean);
  if (!rows.length) return <Empty>No limits set.</Empty>;
  return <div className="flex flex-col gap-3">{rows}</div>;
}

function marginRow(c: ConstraintSpec, design: Design, units: ReturnType<typeof useUnits>) {
  const value = design[c.metric] as number | undefined;
  if (value === undefined || value === null) return null;
  const limit = c.value;
  const ratio = c.op === "<=" ? value / limit : limit / Math.max(value, 1e-9);
  const tone = ratio > 1.0005 ? "bad" : (ratio > 0.97 ? "warn" : "accent");
  const shown = units.metricToDisplay(c.metric, value);
  const limitShown = units.metricToDisplay(c.metric, limit);
  const dp = limitShown < 10 ? 3 : 0;
  return (
    <div key={c.metric + c.op} className="flex flex-col gap-1">
      <div className="flex justify-between text-[12.5px]">
        <span className="text-ink-2">{c.label || units.metricLabel(c.metric)}</span>
        <span className={cx("num", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{shown.toFixed(dp)} / {limitShown.toFixed(dp)}</span>
      </div>
      <Bar fraction={Math.min(ratio, 1)} tone={tone} />
    </div>
  );
}

export function CrossSection({ ctx }: { ctx: Ctx }) {
  const d = ctx.design ?? ctx.baseline;
  return <Motor3D motor={d} height={300} />;
}

export function OptionsTable({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const s = useApp();
  const designs = ctx.designs;
  if (!designs.length) return <Empty>No feasible designs found.</Empty>;
  const [ax, ay] = ctx.axes;
  const b = ctx.baseline;
  const counted = !!ctx.grainCounts?.free;
  const U = units.sys;
  const sort = s.optionSort;
  // Rows keep their original index so a click still selects the right design.
  type Row = Design & { _i: number; _rank: number };
  const value = (d: Row, key: string) => key === "rank" ? d._rank : (d[key] === undefined ? null : +(d[key] as number));
  const order: Row[] = designs.map((d, i) => ({ ...d, _i: i, _rank: i + 1 }));
  order.sort((p, q) => {
    const a = value(p, sort.key), c = value(q, sort.key);
    if (a === null || c === null) return Number(a === null) - Number(c === null);
    return (a - c) * sort.dir || p._rank - q._rank;
  });
  const Th = ({ k, label }: { k: string; label: string }) => {
    const on = sort.key === k;
    return (
      <th className={cx("n sortable", on && "on")} onClick={() => s.setOptionSort(k)} title={"Sort by " + label}>
        {label}{on ? (sort.dir > 0 ? " ▴" : " ▾") : ""}
      </th>
    );
  };
  const pct = (d: Design, v: string) => b && b[v] ? ((d[v] as number) / (b[v] as number) - 1) * 100 : null;
  const cell = (d: Design, v: string) => {
    const p = pct(d, v);
    return p === null ? <td className="n"></td>
      : <td className={cx("n", p >= 0 ? "pos" : "neg")}>{p >= 0 ? "+" : ""}{p.toFixed(2)}%</td>;
  };
  return (
    <div className="overflow-auto max-h-[340px] rounded-lg">
      <table className="data-table">
        <thead><tr>
          <Th k="rank" label="#" /><th>class</th>{counted && <Th k="n_grains" label="grains" />}
          <Th k={ax} label={units.metricLabel(ax)} /><th className="n">&Delta;</th>
          <Th k={ay} label={units.metricLabel(ay)} /><th className="n">&Delta;</th>
          <Th k="max_pressure" label={U.pressure.label} /><Th k="peak_kn" label="Kn" /><Th k="peak_mass_flux" label="flux" /><th></th>
        </tr></thead>
        <tbody>
          {order.map(d => {
            const i = d._i;
            return (
              <motion.tr key={i} layout="position"
                className={cx("clickable", i === ctx.selected && "pick", i === ctx.compareIndex && "vs", i === ctx.hover && "hover")}
                onClick={ev => { if (ev.shiftKey) s.compareDesign(i); else s.selectDesign(i); }}>
                <td className="n">{d._rank}</td>
                <td>{d.designation || "Option " + (i + 1)}</td>
                {counted && <td className="n">{d.n_grains || ""}</td>}
                <td className="n">{units.metricToDisplay(ax, d[ax] as number).toFixed(0)}</td>{cell(d, ax)}
                <td className="n">{units.metricToDisplay(ay, d[ay] as number).toFixed(0)}</td>{cell(d, ay)}
                <td className="n">{units.metricToDisplay("max_pressure", d.max_pressure).toFixed(U.pressure.dp)}</td>
                <td className="n">{d.peak_kn.toFixed(0)}</td>
                <td className="n">{units.metricToDisplay("peak_mass_flux", d.peak_mass_flux).toFixed(U.mass_flux.dp)}</td>
                <td className="flex gap-1">
                  <Button title="Compare with the selected design" on={i === ctx.compareIndex}
                          onClick={ev => { ev.stopPropagation(); s.compareDesign(ctx.compareIndex === i ? null : i); }}>
                    {i === ctx.compareIndex ? "vs ✓" : "vs"}</Button>
                  <Button onClick={ev => { ev.stopPropagation(); s.exportDesign(i); }}>.ric</Button>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
