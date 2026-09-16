import { AnimatePresence, motion } from "motion/react";
import { Button, Card, Check, Empty, Pill, TextField, cx, rise, stagger } from "@/components/ui";
import { supExp } from "@/lib/format";
import { parseNumber } from "@/lib/units";
import type { Sizing } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { StepHead } from "./StepHead";

export function ConstraintsStep() {
  const s = useApp();
  const units = useUnits();
  const spec = s.spec;
  if (!spec) return null;
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Constraints" sub="Set the limits the design must respect" />
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="Design constraints"
              actions={<button type="button" className="link" onClick={() => s.edit(sp => {
                sp.constraints.push({ metric: "peak_kn", op: "<=", value: 225, enabled: true, margin: 0, label: "" });
              })}>+ add</button>}>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {spec.constraints.map((c, i) => {
                const shown = units.metricToDisplay(c.metric, c.value);
                const dp = Math.abs(shown) < 10 ? 3 : 0;
                return (
                  <motion.div key={i} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, x: 24, height: 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
                              className={cx("glass-strong !rounded-xl p-3 flex flex-col gap-2", !c.enabled && "opacity-55")}>
                    <div className="flex items-center gap-2">
                      <Check checked={c.enabled} onChange={on => s.edit(sp => { sp.constraints[i].enabled = on; })} />
                      <select className="input flex-1" value={c.metric} title={s.metrics[c.metric]?.help}
                              onChange={e => s.edit(sp => { sp.constraints[i].metric = e.target.value; sp.constraints[i].label = ""; })}>
                        {Object.entries(s.metrics).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                      </select>
                      <button type="button" title="Remove" className="text-ink-3 hover:text-bad text-lg leading-none px-1"
                              onClick={() => s.edit(sp => { sp.constraints.splice(i, 1); })}>&times;</button>
                    </div>
                    <div className="grid grid-cols-[64px_1fr_auto] gap-2 items-center pl-7">
                      <select className="input" value={c.op}
                              onChange={e => s.edit(sp => { sp.constraints[i].op = e.target.value as "<=" | ">="; })}>
                        <option value="<=">≤</option><option value=">=">≥</option>
                      </select>
                      <TextField align="right" value={shown.toFixed(dp)}
                        onLive={t => { const p = parseNumber(t); if (!isNaN(p)) s.edit(sp => { sp.constraints[i].value = units.metricToSI(c.metric, p); }); }}
                        onCommit={t => { const p = parseNumber(t); if (!isNaN(p)) s.edit(sp => { sp.constraints[i].value = units.metricToSI(c.metric, p); }); }} />
                      <span className="text-[12px] text-ink-3 min-w-10">{units.metricUnit(c.metric)}</span>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {!spec.constraints.length && <Empty>No limits yet. Add one, or run without any.</Empty>}
          </div>
          <Dupes />
        </Card>

        <div className="flex flex-col gap-4 min-w-0">
          <BaselineCheck />
          <SizingCard />
        </div>
      </div>
    </motion.div>
  );
}

// Two limits on one metric are not an error, but only the tighter one binds,
// and a contradictory pair rules out every design.
function Dupes() {
  const spec = useApp(s => s.spec);
  const units = useUnits();
  if (!spec) return null;
  const seen: Record<string, typeof spec.constraints> = {};
  spec.constraints.forEach(c => { if (c.enabled) (seen[c.metric] = seen[c.metric] || []).push(c); });
  const notes = Object.keys(seen).filter(m => seen[m].length > 1).map(m => {
    const rows = seen[m];
    const label = units.metricLabel(m);
    const ops = rows.map(c => c.op);
    const opposed = ops.includes("<=") && ops.includes(">=");
    const values = rows.map(c => (c.op === "<=" ? "≤ " : "≥ ") + units.fmtMetric(m, c.value)).join(" and ");
    if (opposed) {
      const hi = Math.min(...rows.filter(c => c.op === "<=").map(c => c.value));
      const lo = Math.max(...rows.filter(c => c.op === ">=").map(c => c.value));
      return lo > hi
        ? { cls: "err", text: <><strong>{label}</strong> is limited twice, {values}, and no value satisfies both.</> }
        : { cls: "note", text: <><strong>{label}</strong> is limited twice, {values}. Together they are a band.</> };
    }
    const binding = rows[0].op === "<=" ? Math.min(...rows.map(c => c.value)) : Math.max(...rows.map(c => c.value));
    return { cls: "note", text: <><strong>{label}</strong> is limited twice, {values}. Only {rows[0].op === "<=" ? "≤ " : "≥ "}{units.fmtMetric(m, binding)} has any effect.</> };
  });
  if (!notes.length) return null;
  return <div className="flex flex-col gap-1.5">{notes.map((n, i) => <div key={i} className={cx("problem", n.cls)}>{n.text}</div>)}</div>;
}

function BaselineCheck() {
  const m = useApp(s => s.motor);
  const spec = useApp(s => s.spec);
  const units = useUnits();
  if (!m || !spec) return null;
  const num = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  let unknown = 0;
  const rows = spec.constraints.filter(c => c.enabled).map((c, i) => {
    const raw = m[c.metric] as number | undefined;
    if (raw === undefined || raw === null || Number.isNaN(raw)) { unknown++; return null; }
    const have = units.metricToDisplay(c.metric, raw);
    const want = units.metricToDisplay(c.metric, c.value);
    const ok = c.op === "<=" ? have <= want : have >= want;
    return (
      <motion.div key={i} layout className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 text-[13px]">
        <span className="text-ink-2 truncate">{units.metricLabel(c.metric)}</span>
        <span className="num">{num(have)}</span>
        <span className="num text-ink-3">{c.op === "<=" ? "≤" : "≥"} {num(want)}</span>
        <Pill tone={ok ? "good" : "bad"}>{ok ? "ok" : "over"}</Pill>
      </motion.div>
    );
  }).filter(Boolean);
  return (
    <Card title={"Loaded motor: " + m.name} sub="How the baseline stands against each limit">
      {rows.length ? <div className="flex flex-col gap-2">{rows}</div> : <Empty>No limits are enabled.</Empty>}
      {unknown > 0 && <p className="text-[12px] text-ink-3">{unknown} limit{unknown > 1 ? "s are" : " is"} only measured during a run.</p>}
    </Card>
  );
}

export function SizingCard() {
  const s = useApp();
  const units = useUnits();
  const sizing = s.validation.sizing;
  return (
    <Card title="Possible configurations" busy={s.validating}>
      {sizing ? <SizingBody sizing={sizing} fmtLen={units.fmtLen.bind(units)} onTighten={s.tighten} /> : <Empty>Checking…</Empty>}
    </Card>
  );
}

function SizingBody({ sizing, fmtLen, onTighten }: { sizing: Sizing; fmtLen: (m: number) => string; onTighten: () => void }) {
  const num = (b?: { count: number | null; count_exact?: string }) => b && b.count_exact
    ? Number(b.count_exact).toLocaleString() : (b && b.count === null ? "continuous" : "—");
  const rows: { k: string; v: string; why?: string }[] = [];
  if (sizing.counts) rows.push({ k: "Grain counts", v: String(sizing.counts.length),
    why: sizing.counts.map(c => `${c.n} grains: ${c.total_text ?? "—"}`).join(" · ") });
  if (sizing.cores) rows.push({ k: "Core arrangements", v: num(sizing.cores), why: sizing.cores.note });
  if (sizing.nozzle) rows.push({ k: "Throat + exit", v: num(sizing.nozzle), why: sizing.nozzle.note });
  (sizing.others ?? []).forEach(o => rows.push({ k: o.name, v: o.held ? "held" : (o.values === null ? "continuous" : o.values.toLocaleString()) }));
  const red = sizing.reduction;
  const changes = red?.tightened?.changes ?? [];
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-3">
      <motion.div variants={rise}>
        <span className="num text-[30px] font-semibold leading-none text-accent"
              dangerouslySetInnerHTML={{ __html: supExp(sizing.total_text ?? "—") }} />
        <span className="text-[12.5px] text-ink-3 ml-2">distinct motors from {sizing.free_variables} free
          {sizing.free_variables === 1 ? " dimension" : " dimensions"}{sizing.held_variables ? `, ${sizing.held_variables} held` : ""}</span>
      </motion.div>
      <div className="flex flex-col gap-1.5 text-[12.5px]">
        {rows.map(r => (
          <motion.div key={r.k} variants={rise} className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-ink-2">{r.k}</span>
            <span className="num text-right">{r.v}</span>
            {r.why && <span className="col-span-2 text-[11.5px] text-ink-3" dangerouslySetInnerHTML={{ __html: supExp(r.why) }} />}
          </motion.div>
        ))}
      </div>
      <motion.p variants={rise} className="text-[12.5px] text-ink-2" dangerouslySetInnerHTML={{ __html: supExp(sizing.continuous
        ? "Every value in range is allowed, so there is no finite count. Set a <strong>step</strong> on each dimension to see one."
        : `The search simulates <b>${(sizing.evaluated ?? 0).toLocaleString()}</b> of them — ${sizing.fraction_text ?? ""}. Trying all of them one at a time would take <b>${sizing.brute_force_text ?? "—"}</b>, which is why this uses a genetic search rather than brute force.`) }} />
      {red && red.legal_text && !sizing.continuous && (
        <motion.div variants={rise} className="flex flex-col gap-2 pt-2 border-t border-line">
          {[["Geometry alone", red.total_text], ["After limits that rule bounds out", red.after_bounds_text],
            ["Passing Kn and port/throat", red.legal_text]].map(([k, v], i) => (
            <div key={k} className={cx("flex justify-between gap-3 text-[12.5px]", i === 2 && "text-ink font-medium")}>
              <span className={i === 2 ? "" : "text-ink-2"}>{k}</span>
              <b className="num" dangerouslySetInnerHTML={{ __html: supExp(v) }} />
            </div>
          ))}
          {changes.map((c, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr] gap-x-3 text-[12.5px]">
              <span className="text-ink-2">{c.variable === "cores" ? "Core ceiling" : "Throat floor"}</span>
              <span className="num text-right">{fmtLen(c.to)}</span>
              <span className="col-span-2 text-[11.5px] text-ink-3">{c.why}</span>
            </div>
          ))}
          {(red.equivalences ?? []).map((e, i) => (
            <div key={i} className="text-[12.5px]"><span className="text-ink-2">{e.title}</span>
              <span className="block text-[11.5px] text-ink-3">{e.detail}</span></div>
          ))}
          {changes.length > 0 && <div><Button onClick={onTighten}>Apply tighter bounds</Button></div>}
        </motion.div>
      )}
    </motion.div>
  );
}
