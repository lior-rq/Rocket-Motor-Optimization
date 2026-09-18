/* The same design built many times, with the user's tolerances applied. The
   tolerances live here rather than earlier in the flow: they are only ever
   read by this check, so this is the one place they matter. */

import type { Data, Layout } from "plotly.js";
import { motion } from "motion/react";
import { useMemo } from "react";
import { Plot } from "@/components/charts/Plot";
import { LIMIT, SERIES, axis, baseLayout } from "@/components/charts/theme";
import { AnimatedNumber, Bar, Button, Check, Empty, TextField, cx } from "@/components/ui";
import { parseNumber } from "@/lib/units";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import type { Ctx } from "./context";

function Tolerances() {
  const s = useApp();
  const units = useUnits();
  const rows = s.tolerances ?? [];
  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-line">
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-semibold">Build tolerances</h4>
        <span className="num text-[11px] text-ink-3">1&sigma;</span>
      </div>
      {rows.map((t, i) => {
        const meta = s.toleranceFields[t.field] ?? {};
        // Absolute tolerances are a length; relative ones are a percentage.
        const abs = meta.kind === "absolute";
        const shown = abs ? units.toDisplay(t.sigma).toFixed(units.lenDigits + 2) : (t.sigma * 100).toFixed(1);
        return (
          <div key={t.field} className={cx("grid grid-cols-[auto_1fr_90px_auto] items-center gap-2 text-[12.5px]", !t.enabled && "opacity-50")}>
            <Check checked={t.enabled} onChange={on => s.setTolerances(r => { r[i].enabled = on; })} />
            <span className="text-ink-2 truncate" title={meta.help}>{meta.label ?? t.field}</span>
            <TextField align="right" value={shown}
              onCommit={text => { const v = parseNumber(text); if (!isNaN(v)) s.setTolerances(r => { r[i].sigma = abs ? units.toSI(v) : v / 100; }); }} />
            <span className="text-ink-3 min-w-6">{abs ? units.sys.length.label : "%"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function RobustnessPanel({ ctx }: { ctx: Ctx }) {
  const s = useApp();
  const r = ctx.robustness;
  if (s.robustnessBusy) {
    return <motion.p animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}
                     className="text-ink-2 text-[13px]">Building 400 motors and firing them&hellip;</motion.p>;
  }
  if (!r) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">The optimizer works from nominal dimensions, so every design it returns sits
          exactly on whatever limits you set. This simulates the design as it would actually come out of the shop and
          reports how often it still stays legal.</p>
        <Tolerances />
        <div><Button onClick={s.checkRobustness}>Check robustness</Button></div>
      </div>
    );
  }
  if (!r.available) return <Empty>{r.reason ?? "No robustness data."}</Empty>;
  const pct = 100 * r.pass_rate;
  const tone = pct >= 90 ? "text-good" : pct >= 70 ? "text-warn" : "text-bad";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <AnimatedNumber value={pct} format={v => v.toFixed(0) + "%"} className={cx("text-[40px] font-semibold leading-none", tone)} />
        <span className="text-[12.5px] text-ink-2">of {r.samples} builds stay inside every limit<br />
          95% confidence {(100 * r.pass_low).toFixed(0)}–{(100 * r.pass_high).toFixed(0)}%</span>
      </div>
      <div className="flex flex-col gap-2">
        {(r.per_limit ?? []).map(l => {
          const p = 100 * l.exceed_probability;
          return (
            <div key={l.label} className="flex flex-col gap-1">
              <div className="flex justify-between text-[12.5px]"><span className="text-ink-2">{l.label}</span>
                <span className="num">{p.toFixed(0)}% over</span></div>
              <Bar fraction={p / 100} tone={p < 1 ? "good" : p < 10 ? "warn" : "bad"} />
            </div>
          );
        })}
      </div>
      <Tolerances />
      <div><Button onClick={s.checkRobustness}>Run again</Button></div>
    </div>
  );
}

export function RobustnessSpread({ ctx }: { ctx: Ctx }) {
  const units = useUnits();
  const theme = useApp(s => s.theme);
  const r = ctx.robustness;
  const built = useMemo(() => {
    if (!r?.available || !r.per_limit?.length) return null;
    const worst = r.per_limit[0];
    const toShown = (v: number) => units.metricToDisplay(worst.metric, v);
    const shown = (worst.samples ?? []).map(toShown);
    const limit = toShown(worst.limit);
    const over = shown.filter(v => worst.op === "<=" ? v > limit : v < limit);
    const under = shown.filter(v => worst.op === "<=" ? v <= limit : v >= limit);
    return {
      data: [
        { x: under, type: "histogram", name: "legal", marker: { color: SERIES()[0] }, opacity: 0.85, nbinsx: 44 } as Data,
        { x: over, type: "histogram", name: "over the limit", marker: { color: LIMIT() }, opacity: 0.85, nbinsx: 44 } as Data,
      ] as Data[],
      layout: {
        ...baseLayout(), barmode: "overlay", showlegend: true,
        shapes: [{ type: "line", xref: "x", yref: "paper", x0: limit, x1: limit, y0: 0, y1: 1,
                   line: { color: LIMIT(), width: 1.6, dash: "dash" } }],
        xaxis: axis(units.axisTitle(worst.metric)), yaxis: axis("builds"),
      } as Partial<Layout>,
    };
  }, [r, units, theme]);
  if (!built) return <Empty>Run the robustness check to see this.</Empty>;
  return <Plot data={built.data} layout={built.layout} />;
}
