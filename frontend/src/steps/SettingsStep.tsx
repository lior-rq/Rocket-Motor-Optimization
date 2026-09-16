import { motion } from "motion/react";
import { Button, Card, Check, Field, Pill, TextField, cx, stagger } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import { useApp, type Store } from "@/store/app";
import { StepHead } from "./StepHead";

const PRESET_ORDER = ["quick", "standard", "thorough", "extreme"];

function presetBudget(level: { budget: number; seeds: number }) {
  const perSeed = Math.max(Math.floor(level.budget / level.seeds), 80);
  const pop = Math.min(Math.max(Math.floor(perSeed / 50), 40), 240);
  return { pop, gen: Math.max(Math.floor(perSeed / pop), 2) };
}

export function SettingsStep() {
  const s = useApp();
  const spec = s.spec;
  if (!spec) return null;
  const expert = !!spec.expert;
  const level = s.effortLevels[spec.effort] ?? { budget: 0, seeds: 3, label: "", seconds: 0, samples: 0 };
  const machine = s.machine;
  const cores = machine.cores || 4;
  const auto = machine.default_workers || Math.max(1, cores - 2);
  const nSeeds = spec.seeds || level.seeds || 3;
  const workerChoices = [...new Set(Array.from({ length: cores }, (_, i) => i + 1)
    .filter(n => n === 1 || n === cores || n === auto || n % Math.max(1, Math.round(cores / 6)) === 0))]
    .sort((a, b) => a - b);
  const est = s.validation.estimate ?? {};

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Settings" sub="How hard to search, and how long it will take" />

      <Card title="How hard to look">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {PRESET_ORDER.filter(k => s.effortLevels[k]).map(k => {
            const v = s.effortLevels[k];
            const b = presetBudget(v);
            const active = spec.effort === k;
            const measured = s.presetSeconds?.[k];
            return (
              <motion.button key={k} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
                onClick={() => s.edit(sp => { sp.effort = k; sp.budget_simulations = null; sp.seeds = null; })}
                className={cx("relative glass-strong !rounded-xl p-3.5 text-left transition-colors",
                              active ? "border-accent" : "hover:border-ink-3")}>
                {active && <motion.span layoutId="effort-glow" className="absolute inset-0 rounded-xl bg-accent-2 -z-10" />}
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[14px]">{v.label}</span>
                  <span className={cx("num text-[12px]", measured ? "text-accent" : "text-ink-3")}>
                    {measured ? fmtDuration(measured) : "~" + Math.round(v.seconds / 60) + " min"}
                  </span>
                </div>
                <div className="text-[12px] text-ink-2 mt-1 num">{v.budget.toLocaleString()} simulations &middot; {v.seeds} search{v.seeds === 1 ? "" : "es"}</div>
                <div className="text-[11.5px] text-ink-3 num">{b.pop} &times; {b.gen} each</div>
              </motion.button>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Simulation budget" readout={expert ? undefined : (spec.budget_simulations || level.budget || 0).toLocaleString()}>
            {expert && <TextField inputMode="numeric" placeholder={"preset (" + (level.budget || "") + ")"}
              value={spec.budget_simulations ? Number(spec.budget_simulations).toLocaleString() : ""}
              onCommit={t => s.edit(sp => { const n = parseInt(t.replace(/[^0-9]/g, ""), 10); sp.budget_simulations = Number.isFinite(n) && n > 0 ? n : null; })} />}
          </Field>
          <Field label="Independent searches" readout={expert ? undefined : nSeeds + (nSeeds === 1 ? "" : " merged")}>
            {expert && <select className="input" value={nSeeds} onChange={e => s.edit(sp => { sp.seeds = Number(e.target.value); })}>
              {[1, 2, 3, 4, 5, 6, 8].map(n => <option key={n} value={n}>{n === 1 ? "1 — no merging" : n + " merged"}</option>)}
            </select>}
          </Field>
          <Field label="Cores to use" readout={expert ? undefined : (spec.workers || auto) + " of " + cores}>
            {expert && <select className="input" value={spec.workers ?? ""} onChange={e => s.edit(sp => { sp.workers = e.target.value ? Number(e.target.value) : null; })}>
              <option value="">Automatic — {auto} of {cores}</option>
              {workerChoices.map(n => <option key={n} value={n}>{n}{n === cores ? " — all cores" : ""}</option>)}
            </select>}
          </Field>
        </div>
        <Check checked={expert} onChange={on => s.edit(sp => {
          sp.expert = on;
          if (!on) { sp.budget_simulations = null; sp.seeds = null; sp.workers = null; }
        })}>
          I know what I&rsquo;m doing <em className="text-ink-3">(unlocks these three)</em>
        </Check>
        {est.seeds ? <p className="text-[12.5px] text-ink-2"><BudgetSplit /></p> : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <ReadyCard />
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="How long it will take">
            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={s.runDiagnostic} disabled={s.diagRunning}>
                {s.diagnostic ? "Measure again" : "Run the diagnostic"}
              </Button>
              {s.diagRunning && <span className="text-[12px] text-ink-3">measuring&hellip;</span>}
            </div>
            <Estimate />
            <p className="text-[12px] text-ink-3">
              {s.diagnostic
                ? `Measured ${s.diagnostic.rate} simulations a second on ${s.diagnostic.workers} cores.`
                : "A time estimate needs a measurement from this machine. Takes about a minute."}
            </p>
          </Card>
          <Card title="Search method">
            <Check checked={spec.mode === "pareto"} onChange={on => s.edit(sp => { sp.mode = on ? "pareto" : "fast"; })}>
              <span>Surrogate search <Pill tone="accent" className="ml-1">beta</Pill></span>
              <em className="block text-ink-3 text-[12px] mt-1 not-italic">Samples the space, then repeats: train a model on
                every simulation so far, search the model, simulate what it proposes. The burns land where the
                trade-off curve is, so the same budget maps it more fully. Every design reported was simulated;
                the model only chooses what to try.</em>
            </Check>
          </Card>
          <Problems />
        </div>
      </div>
    </motion.div>
  );
}

function BudgetSplit() {
  const est = useApp(s => s.validation.estimate) ?? {};
  if (!est.seeds) return null;
  const counts = (est.grain_counts ?? 0) > 1
    ? <> First a {est.stage_one?.toLocaleString()}-simulation pass across <strong>{est.grain_counts}</strong> grain
        counts, then the full search on the best {est.carried}.</> : null;
  const searches = <><strong>{est.seeds}</strong> search{est.seeds === 1 ? "" : "es"} of {est.pop} &times; {est.gen}</>;
  return est.rounds
    ? <>A {est.initial?.toLocaleString()}-simulation sample, then <strong>{est.rounds}</strong> round{est.rounds === 1 ? "" : "s"} of {searches} against
        the model, each followed by {est.infill} simulations it proposed.{counts}</>
    : <>{searches}, merged into one front.{counts}</>;
}

function Estimate() {
  const est = useApp(s => s.validation.estimate) ?? {};
  const busy = useApp(s => s.validating);
  if (!est.simulations) return null;
  // Predictions and burns cost wildly different amounts; quoting one total
  // made a surrogate run look an hour long when it takes minutes.
  const work = est.model_runs
    ? `${(est.openmotor_runs ?? 0).toLocaleString()} openMotor runs plus ${est.model_runs.toLocaleString()} model evaluations`
    : `${(est.openmotor_runs ?? 0).toLocaleString()} openMotor runs`;
  return (
    <p className={cx("text-[14px]", busy && "busy")}>
      {est.measured
        ? <>roughly <strong className="text-accent num text-[18px]">{fmtDuration(est.seconds)}</strong> &middot; {work}</>
        : <>{work} &middot; <span className="text-ink-3">run the diagnostic for a time estimate</span></>}
    </p>
  );
}

function Problems() {
  const v = useApp(s => s.validation);
  const items = [...(v.problems ?? []).map(p => ({ cls: "err", p })), ...(v.notes ?? []).map(p => ({ cls: "note", p }))];
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it, i) => <motion.div key={i} layout className={cx("problem", it.cls)}>{it.p}</motion.div>)}
    </div>
  );
}

/* What the machine has to be for the run not to take far longer than it
   should. `sensed` says whether the browser can see the answer or only the
   user can, because a list that mixes the two without saying so reads as
   generic. */
interface ReadyCheck {
  id: string; icon: string; title: string;
  sensed: (s: Store) => boolean;
  warn: (s: Store) => string;
  done: (s: Store) => string;
  action: (s: Store) => string;
  run?: (s: Store) => void;
  check: (s: Store) => boolean;
}

const READY: ReadyCheck[] = [
  {
    id: "power", icon: "⚡", title: "Power adapter",
    sensed: s => !!s.battery?.supported,
    warn: () => "Running on battery. The processor is capped, so the search will take far longer.",
    done: s => s.battery?.supported ? "Plugged in." : "Confirmed by you.",
    action: () => "I plugged it in",
    check: s => !!(s.battery?.supported && s.battery.charging) || (!s.battery?.supported && !!s.ready.power),
  },
  {
    id: "awake", icon: "◑", title: "Sleep during the run",
    sensed: () => !!navigator.wakeLock,
    warn: () => navigator.wakeLock
      ? "Nothing is stopping the screen sleeping. A search interrupted part way through has to start again."
      : "This browser cannot hold the screen awake. Turn sleep off yourself.",
    done: s => s.wakeLock ? "This page is holding the screen awake." : "Confirmed by you.",
    action: () => navigator.wakeLock ? "Keep awake" : "I turned sleep off",
    run: navigator.wakeLock ? s => s.requestWakeLock() : undefined,
    check: s => !!s.wakeLock || !!s.ready.awake,
  },
  {
    id: "power-mode", icon: "⚙", title: "Power mode",
    sensed: () => false,
    warn: s => {
      const p = s.machine.platform;
      if (p === "mac") return "Set System Settings → Battery → Energy Mode to High Power. No browser can read this setting, so it needs confirming.";
      if (p === "windows") return "Set Settings → System → Power & battery → Power mode to Best performance. No browser can read this setting, so it needs confirming.";
      return "Set the CPU governor or power profile to performance. No browser can read this setting, so it needs confirming.";
    },
    done: () => "Confirmed by you.",
    action: () => "I set it",
    check: s => !!s.ready["power-mode"],
  },
];

function ReadyCard() {
  const s = useApp();
  const outstanding = READY.filter(r => !r.check(s)).length;
  return (
    <Card title="Get the machine ready" glow={outstanding ? "warn" : "good"}
          actions={<Pill tone={outstanding ? "warn" : "good"}>{outstanding ? outstanding + " to do" : "ready"}</Pill>}>
      <div className="flex flex-col gap-2">
        {READY.map(item => {
          const ok = item.check(s);
          const sensed = item.sensed(s);
          return (
            <motion.div key={item.id} layout
              className={cx("flex items-start gap-3 rounded-xl p-3 border", ok ? "border-good/30 bg-good-2/40" : "border-warn/30 bg-warn-2/40")}>
              <span className={cx("grid place-items-center w-7 h-7 rounded-full text-[13px] shrink-0",
                                  ok ? "bg-good-2 text-good" : "bg-warn-2 text-warn")}>{ok ? "✓" : item.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium flex items-center gap-2">{item.title}
                  <span className={cx("text-[10.5px] font-normal uppercase tracking-wide", sensed ? "text-accent" : "text-ink-3")}>
                    {sensed ? "detected" : "cannot be detected"}</span></div>
                <div className="text-[12px] text-ink-2">{ok ? item.done(s) : item.warn(s)}</div>
              </div>
              {!ok && <Button onClick={() => item.run ? item.run(s) : s.markReady(item.id)}>{item.action(s)}</Button>}
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}
