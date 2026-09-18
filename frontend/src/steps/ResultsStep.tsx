import { AnimatePresence, motion } from "motion/react";
import { AnimatedNumber, Bar, Button, Card, Pill, cx, rise, spring, stagger } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import { useApp } from "@/store/app";
import { useCtx } from "@/results/context";
import { PANELS, PROFILES } from "@/results/panels";
import { Motor3D } from "@/three/Motor3D";
import { StepHead } from "./StepHead";

export function ResultsStep() {
  const s = useApp();
  const ctx = useCtx();
  const m = s.motor;
  const design = ctx?.design;
  const profile = PROFILES.find(p => p.id === s.profile) ?? PROFILES[0];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Results" sub="The designs it found" />

      {s.reportJob && s.job?.status === "done" && <Downloads />}

      <div className="grid gap-3 sm:grid-cols-2">
        <motion.div variants={rise} className="glass px-4 py-3 flex items-center gap-3 flex-wrap">
          <Pill tone="muted">Baseline</Pill>
          <span className="font-medium text-[13.5px]">{m?.name ?? "no motor loaded"}</span>
          {m && <span className="num text-[12.5px] text-ink-2 ml-auto">{fmtInt(m.initial_thrust)} N &middot; {fmtInt(m.total_impulse)} N&middot;s</span>}
        </motion.div>
        <AnimatePresence>
          {design && (
            <motion.div variants={rise} initial="hidden" animate="show" exit={{ opacity: 0 }}
                        className="glass px-4 py-3 flex items-center gap-3 flex-wrap ring-1 ring-accent/40">
              <Pill tone="accent">Loaded</Pill>
              <span className="font-medium text-[13.5px]">Option {s.selected + 1}{design.designation ? " · " + design.designation : ""}</span>
              <span className="num text-[12.5px] text-ink-2 ml-auto">
                <AnimatedNumber value={design.initial_thrust} format={v => fmtInt(v) + " N"} /> &middot;{" "}
                <AnimatedNumber value={design.total_impulse} format={v => fmtInt(v) + " N·s"} />
              </span>
              <Button onClick={() => s.exportDesign(s.selected)}>Download .ric</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {!ctx ? (
        <Card className="items-center text-center !py-10">
          <h3 className="text-[18px] font-semibold">No results yet</h3>
          <p className="text-ink-2 text-[13.5px]">Run the search and the designs it finds appear here.</p>
          <div className="w-full max-w-3xl mt-2"><Motor3D motor={m} height={240} /></div>
        </Card>
      ) : (
        <>
          <motion.nav variants={rise} className="flex gap-1 overflow-x-auto" role="tablist">
            {PROFILES.map(p => (
              <button key={p.id} type="button" role="tab" aria-selected={p.id === profile.id}
                      onClick={() => s.setProfile(p.id)}
                      className={cx("relative px-3.5 py-2 rounded-xl text-[13px] font-medium whitespace-nowrap transition-colors",
                                    p.id === profile.id ? "text-ink" : "text-ink-3 hover:text-ink-2")}>
                {p.id === profile.id && <motion.span layoutId="profile-pill" transition={spring} className="absolute inset-0 -z-10 rounded-xl glass-strong" />}
                {p.label}
              </button>
            ))}
          </motion.nav>

          <AnimatePresence>
            {ctx.compare && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden">
                <div className="glass px-4 py-2.5 flex items-center gap-3 flex-wrap text-[13px]">
                  Comparing <b>Option {s.selected + 1}</b> with <b>Option {(ctx.compareIndex ?? 0) + 1}</b> &mdash; dashed in every curve.
                  <span className="text-ink-3">Shift-click a row or point to compare another.</span>
                  <Button className="ml-auto" onClick={() => s.compareDesign(null)}>Clear</Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            <motion.div key={profile.id} variants={stagger} initial="hidden" animate="show" exit={{ opacity: 0 }}
                        className="grid gap-4 lg:grid-cols-2">
              {profile.panels.map(([id, span]) => {
                const def = PANELS[id];
                if (!def) return null;
                const Component = def.Component;
                return (
                  <Card key={id} title={def.title} sub={def.sub} className={cx(span === 2 && "lg:col-span-2")}>
                    <PanelBoundary><Component ctx={ctx} /></PanelBoundary>
                  </Card>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}

function Downloads() {
  const s = useApp();
  const job = s.job!;
  const none = !job.n_designs;
  const busy = s.bundle.active;
  return (
    <Card title="Downloads" actions={
      <div className="flex gap-2 flex-wrap justify-end">
        <Button disabled={!job.report} onClick={s.openReport}>
          {job.report ? "Open this run’s report" : (job.report_error ? "Report could not be written" : "No report")}
        </Button>
        <Button disabled={none || busy} onClick={() => s.downloadBundle("sheets")}>Design sheets (.zip)</Button>
        <Button disabled={none || busy} onClick={() => s.downloadBundle("eng")}>All motors (.eng)</Button>
        <Button disabled={none || busy} onClick={() => s.downloadBundle("ric")}>openMotor files (.zip)</Button>
      </div>}>
      <p className="text-[12.5px] text-ink-2">Sheets are one PDF per design with the dimensions to machine to. The <code>.eng</code> is
        one RASP file holding every design, which OpenRocket and RockSim list as separate motors; total mass is propellant
        only, so add the hardware mass there. The openMotor zip is one <code>.ric</code> per design.</p>
      <AnimatePresence>
        {(busy || s.bundle.message) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-3 overflow-hidden">
            <Bar fraction={s.bundle.fraction} className="flex-1" />
            <span className="text-[12px] text-ink-3 whitespace-nowrap">{s.bundle.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

import { Component as ReactComponent, type ErrorInfo, type ReactNode } from "react";

/** One panel throwing must not take the page with it. */
class PanelBoundary extends ReactComponent<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: Error, info: ErrorInfo) { console.error(err, info.componentStack); }
  render() {
    if (this.state.failed) return <p className="text-ink-3 text-[12.5px]">Could not draw this panel.</p>;
    return this.props.children;
  }
}
