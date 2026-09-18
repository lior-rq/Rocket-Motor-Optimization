/* The chrome around the wizard: brand, motor chip, units, theme, the run
   button, the stepper, the footer and the toasts. */

import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { showFiles } from "@/lib/desktop";
import { RUNNING, SETTINGS, STEPS, useApp } from "@/store/app";
import { canRun, furthestAllowed, gateReason, isRunning, stepDone } from "@/store/select";
import { Button, Segmented, cx, spring, LiveDot } from "./ui";

const STEP_NAMES = ["Motor", "Variables", "Constraints", "Optimize", "Settings", "Running", "Results"];

export function Topbar() {
  const s = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const running = isRunning(s);
  const ready = canRun(s) && !running;
  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}
      className="glass-bar sticky top-3 z-40 mx-4 mt-3 px-4 py-2.5 flex items-center gap-4 rounded-2xl"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Mark />
        <div className="leading-tight min-w-0">
          <div className="font-semibold text-[14px] tracking-tight truncate">
            Lior's Really Good&trade; Rocket Optimizer
          </div>
          <div className="text-[11px] text-ink-3 flex items-center gap-2">
            <span>Created by Lior Benshoshan</span>
            {s.version && <span className="num rounded-full bg-surface-3 px-1.5 text-[10px]">v{s.version}</span>}
          </div>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-2 border border-line text-[12.5px] min-w-0">
        <span className="font-medium truncate">{s.motor?.name ?? (s.bootError ? "no motor loaded" : "loading…")}</span>
        {s.motor?.designation && (
          <>
            <span className="text-ink-3">&middot;</span>
            <span className="num text-accent">{s.motor.designation}</span>
          </>
        )}
        <button type="button" className="link ml-1" onClick={() => fileInput.current?.click()}>Change</button>
        <input ref={fileInput} type="file" accept=".ric" hidden
               onChange={e => { const f = e.target.files?.[0]; if (f) s.uploadMotor(f); e.target.value = ""; }} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Segmented value={s.unit} onChange={s.setUnit}
                   options={[{ value: "in", label: "inch" }, { value: "mm", label: "mm" }]} />
        {s.desktop && (
          <Button variant="ghost" onClick={showFiles} title="Open the reports and motor folder">Files</Button>
        )}
        <Button variant="ghost" onClick={s.toggleTheme} title="Light / dark" className="w-9 px-0">
          {s.theme === "dark" ? "☾" : "☀"}
        </Button>
        <Button variant="primary" disabled={!ready} onClick={s.startRun}
                title={ready ? "" : running ? "A search is running" : "Available on the Settings step"}>
          {running ? <><LiveDot tone="good" /> Working…</> : "Optimize"}
        </Button>
      </div>
    </motion.header>
  );
}

function Mark() {
  return (
    <motion.div
      className="relative w-9 h-9 rounded-xl grid place-items-center shrink-0"
      style={{ background: "linear-gradient(135deg, var(--accent) 0%, var(--accent) 45%, var(--warn) 150%)",
               boxShadow: "0 0 24px var(--accent-glow)" }}
      animate={{ rotate: [0, 2, -2, 0] }}
      transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--bg)" strokeWidth="2.2"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3c3 3 4 7 4 11l-4 4-4-4c0-4 1-8 4-11z" />
        <path d="M8 14l-3 3M16 14l3 3M12 18v3" />
      </svg>
    </motion.div>
  );
}

export function Progress() {
  const job = useApp(s => s.job);
  const cancel = useApp(s => s.cancelRun);
  const live = job && (job.status === "running" || job.status === "queued");
  return (
    <AnimatePresence>
      {live && (
        <motion.div
          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }} transition={spring}
          className="mx-4 mt-3 overflow-hidden"
        >
          <div className="glass px-4 py-2.5 flex items-center gap-4">
            <LiveDot tone="good" />
            <div className="track flex-1"><motion.div className="fill" animate={{ width: (job.fraction * 100) + "%" }}
              transition={{ type: "spring", stiffness: 80, damping: 20 }} /></div>
            <span className="text-[12px] text-ink-2 num whitespace-nowrap">
              {job.message} &middot; {job.elapsed}s
            </span>
            <button type="button" className="link" onClick={cancel}>Cancel</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Stepper() {
  const s = useApp();
  const reach = furthestAllowed(s);
  return (
    <nav className="mx-4 mt-4 flex gap-1 overflow-x-auto pb-1" aria-label="Steps">
      {STEP_NAMES.map((name, i) => {
        const active = i === s.step;
        const done = i < s.step && stepDone(s, i);
        const disabled = i > reach;
        return (
          <button key={name} type="button" disabled={disabled} onClick={() => s.goTo(i)}
            className={cx("relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap transition-colors",
                          active ? "text-ink" : done ? "text-ink-2 hover:text-ink" : "text-ink-3",
                          disabled && "opacity-40 cursor-not-allowed")}>
            {active && (
              <motion.span layoutId="step-pill" transition={spring}
                className="absolute inset-0 -z-10 rounded-xl glass-strong" />
            )}
            <span className={cx("num grid place-items-center w-5 h-5 rounded-full text-[11px] font-semibold border",
                                active ? "border-accent text-accent bg-accent-2"
                                       : done ? "border-good text-good bg-good-2"
                                              : "border-line text-ink-3")}>
              {done ? "✓" : i + 1}
            </span>
            {name}
            {i === RUNNING && isRunning(s) && <LiveDot tone="good" />}
          </button>
        );
      })}
    </nav>
  );
}

export function Footer() {
  const s = useApp();
  const last = s.step === STEPS - 1;
  const done = stepDone(s, s.step);
  if (last) return null;
  return (
    <motion.footer
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}
      className="glass-bar sticky bottom-3 z-30 mx-4 mb-3 px-4 py-2.5 flex items-center gap-4 rounded-2xl"
    >
      <Button variant="ghost" disabled={s.step === 0} onClick={() => s.goTo(s.step - 1)}>Back</Button>
      <span className="text-[12px] text-ink-3 num">Step {s.step + 1} of {STEPS}</span>
      <AnimatePresence mode="wait">
        {!done && (
          <motion.p key={gateReason(s, s.step)} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }} className="text-[12.5px] text-warn truncate flex-1">
            {gateReason(s, s.step)}
          </motion.p>
        )}
      </AnimatePresence>
      <Button variant="primary" className="ml-auto" disabled={!done || (s.step === SETTINGS && isRunning(s))}
              onClick={() => s.step === SETTINGS ? s.startRun() : s.goTo(s.step + 1)}>
        {s.step === SETTINGS ? "Optimize" : "Next"}
      </Button>
    </motion.footer>
  );
}

export function Toasts() {
  const toasts = useApp(s => s.toasts);
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={spring}
            className="glass-strong px-4 py-2 text-[13px] rounded-xl max-w-[80vw] text-center">
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
