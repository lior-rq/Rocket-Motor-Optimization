import { AnimatePresence, motion } from "motion/react";
import { Button, Card, Check, Field, TextField, cx, stagger } from "@/components/ui";
import { partitions } from "@/lib/format";
import { parseNumber } from "@/lib/units";
import type { VariableSpec } from "@/lib/types";
import { useApp } from "@/store/app";
import { isCore, useUnits } from "@/store/select";
import { StepHead } from "./StepHead";

// Grain lengths a builder can cast and handle, as a multiple of the outer
// diameter. Outside this the count is allowed, but the page says so.
const GRAIN_LD = [0.5, 3.0];

// What each rule costs or buys, since the choice moves the result by more
// than most of the bounds do.
const ORDERING_WHY: Record<string, string> = {
  none: "No rule. Tends to choke the aft grain, and rules out nothing.",
  nondecreasing: "The default. Keeps the aft port open without forcing six different mandrels.",
  strict: "Every core wider than the one ahead. Costs roughly 0.8% of thrust against allowing ties.",
  paired: "A few sizes shared across the grains. Fewer mandrels to buy or turn.",
};

export function VariablesStep() {
  const s = useApp();
  const units = useUnits();
  const spec = s.spec, m = s.motor;
  if (!spec || !m) return null;
  const gc = spec.grain_count ?? { free: false, n_min: 4, n_max: 8 };
  const collapse = !!gc.free;
  const vars = spec.variables;

  // Each row edits a group of variables: every core at once when collapsed.
  type Row = { shared: boolean; v: VariableSpec; label: string; index: number };
  const rows: Row[] = [];
  vars.forEach((v, i) => {
    if (collapse && isCore(v)) {
      if (!rows.some(r => r.shared)) rows.push({ shared: true, v, label: "Grain cores (all)", index: i });
      return;
    }
    rows.push({ shared: false, v, label: v.label || v.name, index: i });
  });

  const apply = (row: Row, key: "free" | "low" | "high" | "step", raw: string | boolean) =>
    s.edit(sp => {
      const targets = row.shared ? sp.variables.filter(isCore) : [sp.variables[row.index]];
      targets.forEach(v => {
        if (key === "free") v.free = raw as boolean;
        else if (key === "step") {
          const p = parseNumber(raw as string);
          v.step = isNaN(p) ? 0 : units.toSI(p);
        } else {
          const p = parseNumber(raw as string);
          if (!isNaN(p)) v[key] = units.toSI(p);
        }
      });
    });

  const dp = units.lenDigits;
  const stack = m.stack_length || m.grain_lengths.reduce((a, b) => a + b, 0);
  const ld = (n: number) => stack / n / m.grain_diameter;
  const tooLong = gc.free && ld(gc.n_min) > GRAIN_LD[1];
  const tooShort = gc.free && ld(gc.n_max) < GRAIN_LD[0];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Variables" sub="Choose what may change, and by how much" />
      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr] lg:items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="What may change"
                actions={<>
                  <button type="button" className="link" onClick={() => s.edit(sp => sp.variables.forEach(v => { v.free = true; }))}>all free</button>
                  <button type="button" className="link" onClick={() => s.edit(sp => sp.variables.forEach(v => { v.free = collapse && isCore(v); }))}>all fixed</button>
                </>}>
            <p className="text-[12.5px] text-ink-2">Untick a row to hold a dimension at its current value.
              <strong> Step</strong> is the machining grid. Accepts <code>1/16</code> or <code>0.05</code>,
              or leave blank for any size.</p>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[13px] border-separate border-spacing-y-1">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-ink-3">
                    <th className="w-8"></th><th className="text-left font-medium">Dimension</th>
                    <th className="text-right font-medium">Min</th><th className="text-right font-medium">Max</th>
                    <th className="text-right font-medium">Step</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const v = row.v;
                    return (
                      <motion.tr key={row.label} layout="position"
                                 className={cx("transition-opacity", !v.free && "opacity-55")}>
                        <td className="px-1">
                          <Check checked={v.free} disabled={row.shared}
                                 title={row.shared ? "Every core is free while the count is" : undefined}
                                 onChange={on => apply(row, "free", on)} />
                        </td>
                        <td className="px-1 font-medium whitespace-nowrap">{row.label}</td>
                        <td className="px-1 w-28"><TextField align="right" disabled={!v.free}
                          value={units.toDisplay(v.low).toFixed(dp)}
                          onLive={t => apply(row, "low", t)} onCommit={t => apply(row, "low", t)} /></td>
                        <td className="px-1 w-28"><TextField align="right" disabled={!v.free}
                          value={units.toDisplay(v.high).toFixed(dp)}
                          onLive={t => apply(row, "high", t)} onCommit={t => apply(row, "high", t)} /></td>
                        <td className="px-1 w-28"><TextField align="right" disabled={!v.free} placeholder="any"
                          value={v.step ? units.toDisplay(v.step).toFixed(dp) : ""}
                          onLive={t => apply(row, "step", t)} onCommit={t => apply(row, "step", t)} /></td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] text-ink-3 mr-1">Set every step to</span>
              {units.sys.steps.map(([size, label]) => (
                <Button key={label} onClick={() => s.edit(sp => sp.variables.forEach(v => { v.step = units.toSI(size); }))}>
                  {label}
                </Button>
              ))}
            </div>
          </Card>
          <Card title="Bounds preview" sub="Every grain's wall, the band a core may sit in, and where the loaded core is now">
            <BoundsPreview />
          </Card>
        </div>

        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Grain count">
            <Check checked={!!gc.free} onChange={on => s.edit(sp => {
              sp.grain_count = { ...gc, free: on };
              // With the count free there may be any number of grains, so the
              // cores share one row and one set of bounds. Every core is free.
              if (on) sp.variables.forEach(v => { if (isCore(v)) v.free = true; });
            })}>
              Let the search choose how many grains
            </Check>
            <p className="text-[12.5px] text-ink-2">
              {!gc.free
                ? `Held at ${m.grain_count} grains of ${units.fmtLen(m.grain_lengths[0])}, as the file has it.`
                : <>The {units.fmtLen(stack)} stack is cut into every count from {gc.n_min} to {gc.n_max}
                    ({units.fmtLen(stack / gc.n_max)} to {units.fmtLen(stack / gc.n_min)} each).
                    Each count gets a short search; the best go on to the full one.</>}
            </p>
            <AnimatePresence>
              {gc.free && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <Field label="Fewest"><TextField inputMode="numeric" value={String(gc.n_min)}
                      onCommit={t => s.edit(sp => setCount(sp.grain_count, "n_min", t))} /></Field>
                    <Field label="Most"><TextField inputMode="numeric" value={String(gc.n_max)}
                      onCommit={t => s.edit(sp => setCount(sp.grain_count, "n_max", t))} /></Field>
                  </div>
                  {(tooLong || tooShort) && (
                    <p className="text-[12.5px] text-warn mt-2">
                      {tooLong
                        ? `${gc.n_min} grains means ${units.fmtLen(stack / gc.n_min)} each, ${ld(gc.n_min).toFixed(1)}× the diameter. Long grains are hard to cast and handle; the model does not care.`
                        : `${gc.n_max} grains means ${units.fmtLen(stack / gc.n_max)} each, ${ld(gc.n_max).toFixed(1)}× the diameter. Very short grains burn mostly on their faces; the model allows it.`}
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </Card>

          <Card title="Grain cores">
            <select className="input" value={spec.ordering.mode}
                    onChange={e => s.edit(sp => { sp.ordering.mode = e.target.value; })}>
              {Object.entries(s.orderingModes).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <p className="text-[12.5px] text-ink-2">{ORDERING_WHY[spec.ordering.mode] ?? ""}</p>
            {spec.ordering.mode === "strict" && (
              <Field label="Minimum increase per grain">
                <TextField inputMode="decimal" placeholder={units.sys.stepHint}
                  value={spec.ordering.min_step ? units.toDisplay(spec.ordering.min_step).toFixed(dp) : ""}
                  onCommit={t => s.edit(sp => { const p = parseNumber(t); sp.ordering.min_step = isNaN(p) ? 0 : units.toSI(p); })} />
              </Field>
            )}
            {spec.ordering.mode === "paired" && (
              <Field label="Mandrel sizes">
                <select className="input" value={(spec.ordering.groups ?? partitions(m.grain_count)[0]).join(",")}
                        onChange={e => s.edit(sp => { sp.ordering.groups = e.target.value.split(",").map(Number); })}>
                  {partitions(m.grain_count).map(g => (
                    <option key={g.join(",")} value={g.join(",")}>
                      {g.length} size{g.length > 1 ? "s" : ""} — {g.join(" + ")} grains
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </Card>

          <FreeSummary />
        </div>
      </div>
    </motion.div>
  );
}

function setCount(gc: { n_min: number; n_max: number }, key: "n_min" | "n_max", text: string) {
  const v = parseInt(text, 10);
  if (!isNaN(v) && v > 0) gc[key] = v;
  if (gc.n_max < gc.n_min) gc[key === "n_min" ? "n_max" : "n_min"] = gc[key];
}

function FreeSummary() {
  const spec = useApp(s => s.spec);
  const units = useUnits();
  if (!spec) return null;
  const vars = spec.variables;
  const free = vars.filter(v => v.free);
  const gc = spec.grain_count ?? { free: false, n_min: 0, n_max: 0 };
  const steps = [...new Set(free.map(v => v.step || 0))];
  const listed = gc.free
    ? [{ ...(vars.find(isCore) ?? vars[0]), label: "Grain cores (all)" }, ...vars.filter(v => !isCore(v))]
    : vars;
  return (
    <Card title="Free dimensions">
      <div className="flex items-baseline gap-2">
        <span className="num text-[34px] font-semibold leading-none text-accent">{free.length + (gc.free ? 1 : 0)}</span>
        <span className="text-ink-3 text-[13px]">of {vars.length + (gc.free ? 1 : 0)} free</span>
      </div>
      <div className="flex flex-col gap-1 text-[12.5px]">
        {gc.free && (
          <div className="flex justify-between gap-3"><span className="text-ink-2">Grain count</span>
            <span className="num">{gc.n_min} – {gc.n_max}</span></div>
        )}
        {listed.map(v => (
          <div key={v.label || v.name} className={cx("flex justify-between gap-3", !v.free && "opacity-50")}>
            <span className="text-ink-2">{v.label || v.name}</span>
            <span className="num">{v.free ? units.fmtLen(v.low) + " – " + units.fmtLen(v.high)
                                          : "held at " + units.fmtLen(v.fixed_value || 0)}</span>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-ink-3">
        {steps.length === 1
          ? "Every free dimension is on a " + (steps[0] ? units.fmtLen(steps[0]) : "continuous") + " grid."
          : "Mixed machining grids across the free dimensions."}
      </p>
    </Card>
  );
}

/** The stack as the bounds describe it. Redrawn on every keystroke, so the
    bounds are seen rather than imagined. */
function BoundsPreview() {
  const spec = useApp(s => s.spec);
  const m = useApp(s => s.motor);
  const units = useUnits();
  if (!spec || !m) return null;
  const gc = spec.grain_count ?? { free: false, n_min: 0, n_max: 0 };
  const cores = spec.variables.filter(isCore);
  if (!cores.length) return null;
  const stack = m.stack_length || m.grain_lengths.reduce((a, b) => a + b, 0);
  const bore = m.grain_diameter;
  const n = gc.free ? gc.n_max : m.grain_count;
  const lengths = gc.free ? Array(n).fill(stack / n) : m.grain_lengths;
  const W = 640, pad = 12, H = 150;
  const sx = (W - 2 * pad) / stack;
  const sy = Math.min((H - 2 * pad) / bore, sx);
  const cy = H / 2, gap = 3;
  const r = (q: number) => Math.max(q * sy / 2, 0);
  let x = pad;
  const parts = lengths.map((L: number, i: number) => {
    const v = gc.free ? cores[0] : (cores[i] || cores[0]);
    const w = Math.max(L * sx - gap, 2);
    const fixed = v.free ? null : (v.fixed_value ?? m.cores[i] ?? m.cores[0]);
    const now = m.cores[i];
    const x0 = x;
    x += L * sx;
    return (
      <g key={i}>
        <rect x={x0} y={cy - r(bore)} width={w} height={2 * r(bore)} rx="3"
              fill="var(--surface-3)" stroke="var(--line)" />
        {v.free ? (
          <>
            <motion.rect x={x0} width={w} fill="var(--accent)" opacity=".18"
              animate={{ y: cy - r(v.high), height: 2 * r(v.high) }} transition={{ type: "spring", stiffness: 200, damping: 26 }} />
            <motion.rect x={x0} width={w} fill="var(--accent)" opacity=".45"
              animate={{ y: cy - r(v.low), height: 2 * r(v.low) }} transition={{ type: "spring", stiffness: 200, damping: 26 }} />
          </>
        ) : (
          <rect x={x0} y={cy - r(fixed!)} width={w} height={2 * r(fixed!)} fill="var(--ink-3)" opacity=".55" />
        )}
        {now !== undefined && !gc.free && (
          <>
            <line x1={x0} x2={x0 + w} y1={cy - r(now)} y2={cy - r(now)} stroke="var(--ink)" strokeWidth="1" strokeDasharray="3 3" />
            <line x1={x0} x2={x0 + w} y1={cy + r(now)} y2={cy + r(now)} stroke="var(--ink)" strokeWidth="1" strokeDasharray="3 3" />
          </>
        )}
      </g>
    );
  });
  const c0 = cores[0];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Core bounds preview" className="w-full">{parts}</svg>
      <p className="text-[12px] text-ink-3 num mt-1">
        {gc.free
          ? `${gc.n_min}–${gc.n_max} grains · cores ${units.fmtLen(c0.low)}–${units.fmtLen(c0.high)}`
          : `${m.grain_count} grains · core band per grain, dashed line is the loaded core`}
      </p>
    </div>
  );
}
