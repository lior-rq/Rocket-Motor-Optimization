import { AnimatePresence, motion } from "motion/react";
import { Card, Check, Empty, TextField, cx, stagger } from "@/components/ui";
import { parseNumber } from "@/lib/units";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { StepHead } from "./StepHead";

const PRESETS = [
  { id: "tradeoff", name: "Thrust vs impulse",
    why: "Two objectives, so the run returns a curve of options rather than one answer." },
  { id: "thrust", name: "Max initial thrust", why: "Hardest off the rail." },
  { id: "impulse", name: "Max impulse", why: "The largest motor the limits allow." },
  { id: "flat", name: "Flattest curve", why: "Peak thrust closest to average." },
];

export function ObjectivesStep() {
  const s = useApp();
  const units = useUnits();
  const spec = s.spec;
  if (!spec) return null;
  const on = spec.objectives.filter(o => o.enabled);
  const names = on.map(o => units.metricLabel(o.metric).toLowerCase());
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Optimize" sub="Choose what to maximize, minimize, or target" />
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card title="What to optimize"
              actions={<button type="button" className="link" onClick={() => s.edit(sp => {
                sp.objectives.push({ metric: "total_impulse", direction: "max", weight: 1, target: null, enabled: true });
              })}>+ add</button>}>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {spec.objectives.map((o, i) => (
                <motion.div key={i} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, x: 24, height: 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}
                            className={cx("glass-strong !rounded-xl p-3 flex flex-col gap-2", !o.enabled && "opacity-55")}>
                  <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2">
                    <Check checked={o.enabled} onChange={v => s.edit(sp => { sp.objectives[i].enabled = v; })} />
                    <select className="input" value={o.metric} title={s.metrics[o.metric]?.help}
                            onChange={e => s.edit(sp => { sp.objectives[i].metric = e.target.value; })}>
                      {Object.entries(s.metrics).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                    </select>
                    <select className="input w-32" value={o.direction}
                            onChange={e => s.edit(sp => { sp.objectives[i].direction = e.target.value as "max" | "min" | "target"; })}>
                      <option value="max">maximize</option>
                      <option value="min">minimize</option>
                      <option value="target">hit target</option>
                    </select>
                    <button type="button" title="Remove" className="text-ink-3 hover:text-bad text-lg leading-none px-1"
                            onClick={() => s.edit(sp => { sp.objectives.splice(i, 1); })}>&times;</button>
                  </div>
                  {o.direction === "target" && (
                    <div className="grid grid-cols-[64px_1fr_auto] items-center gap-2 pl-7">
                      <span className="text-[12px] text-ink-3">target</span>
                      <TextField align="right"
                        value={o.target !== null && o.target !== undefined ? String(units.metricToDisplay(o.metric, o.target)) : ""}
                        onCommit={t => s.edit(sp => { const p = parseNumber(t); sp.objectives[i].target = isNaN(p) ? null : units.metricToSI(o.metric, p); })} />
                      <span className="text-[12px] text-ink-3 min-w-10">{units.metricUnit(o.metric)}</span>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            {!spec.objectives.length && <Empty>Nothing yet. Pick a preset, or add one.</Empty>}
          </div>
        </Card>

        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Presets">
            <div className="grid gap-2 sm:grid-cols-2">
              {PRESETS.map(p => (
                <motion.button key={p.id} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
                  onClick={() => s.applyPreset(p.id)}
                  className="glass-strong !rounded-xl p-3 text-left hover:border-accent transition-colors">
                  <div className="font-medium text-[13.5px]">{p.name}</div>
                  <div className="text-[12px] text-ink-3 mt-0.5">{p.why}</div>
                </motion.button>
              ))}
            </div>
          </Card>
          <Card title="What this run will return">
            <p className="text-[13px] text-ink-2">
              {!on.length ? "Nothing is selected yet."
                : on.length === 1
                  ? <>One objective, so the run returns a single best motor for <strong>{names[0]}</strong>.</>
                  : <>{on.length} objectives, so the run returns a curve of options trading <strong>{names.join(" against ")}</strong>.
                      Every design on it is buildable; choosing between them is the point.</>}
            </p>
          </Card>
        </div>
      </div>
    </motion.div>
  );
}
