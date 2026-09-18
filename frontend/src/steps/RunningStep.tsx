import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Blocking, LivePlot, Spark, Speedometer, fitRange, useShownSnap } from "@/components/charts/Live";
import { AnimatedNumber, Bar, Button, Card, LiveDot, stagger, cx } from "@/components/ui";
import { fmtClock } from "@/lib/format";
import { useApp } from "@/store/app";
import { isRunning, useUnits } from "@/store/select";
import { Motor3D } from "@/three/Motor3D";
import { StepHead } from "./StepHead";

export function RunningStep() {
  const s = useApp();
  const running = isRunning(s);
  const showLive = running || (!!s.liveSnap && !s.results && s.job?.status !== "failed" && s.job?.status !== "cancelled");
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Running" sub="The search, live">
        {running && <div className="flex items-center gap-2 text-[12.5px] text-good"><LiveDot tone="good" /> live</div>}
      </StepHead>
      {/* Mounted after the step has settled, so these drive their own
          entrance rather than inheriting the parent's finished one. */}
      <AnimatePresence mode="wait">
        {showLive ? <motion.div key="live" variants={stagger} initial="hidden" animate="show" exit={{ opacity: 0 }}><Live /></motion.div>
                  : <motion.div key="empty" variants={stagger} initial="hidden" animate="show" exit={{ opacity: 0 }}><Ready /></motion.div>}
      </AnimatePresence>
    </motion.div>
  );
}

function Ready() {
  const s = useApp();
  return (
    <Card className="items-center text-center !py-10">
      <h3 className="text-[18px] font-semibold">{s.results ? "Search finished" : "Ready to optimize"}</h3>
      <p className="text-ink-2 text-[13.5px]">
        {s.results ? <>The results are on the next step.</>
                   : <>Everything is set. Press <strong>Optimize</strong> to start the search.</>}
      </p>
      <div className="w-full max-w-3xl mt-2"><Motor3D motor={s.motor} height={260} /></div>
    </Card>
  );
}

function Live() {
  const s = useApp();
  const units = useUnits();
  const job = s.job;
  const t = s.liveSnap;
  const shown = useShownSnap(t);
  const [fitKey, setFitKey] = useState(0);

  // The range is fixed on the first frame of a run or unit system, so the
  // search is seen travelling rather than the axes chasing it. Computed here
  // rather than in an effect so that first frame already carries it.
  const range = s.liveRange ?? (shown ? fitRange(shown) : null);
  const setLiveRange = s.setLiveRange;
  useEffect(() => {
    if (range && !s.liveRange) setLiveRange(range);
  }, [range, s.liveRange, setLiveRange]);

  const gen = t?.generation ?? 0, total = t?.total_generations ?? 0;
  const grains = t?.n_grains ? ` · ${t.n_grains} grains` : "";
  const title = !t ? "Starting"
    : t.stage === "stage1" ? `Trying ${t.n_grains} grains (${t.seed_index + 1} of ${t.n_seeds})`
    : t.n_seeds > 1 ? `Search ${t.seed_index + 1} of ${t.n_seeds}${grains}` : "Searching" + grains;
  // The claim "actually been simulated" is only true on the simulator path;
  // in trade-off mode these are model predictions, verified later.
  const dot = t?.surrogate
    ? "Every dot is a motor the trained model has scored. The winners are simulated for real at the end."
    : "Every dot is a motor that has actually been simulated.";
  const best = t?.single_objective ? "the orange marker is the best one found so far."
                                   : "the orange line is the best trade-off found so far.";

  const done = t?.simulations_done ?? 0, sims = t?.simulations_total ?? 0;
  const frac = sims ? Math.min(done / sims, 1) : (job?.fraction ?? 0);
  const left = t && t.rate && t.rate > 0 && sims > done ? (sims - done) / t.rate : null;
  const derate = s.diagnostic?.thermal_derate ?? 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-end justify-between gap-4">
          <div><div className="text-[11px] uppercase tracking-wide text-ink-3">Elapsed</div>
            <div className="num text-[26px] font-semibold leading-none">{fmtClock(job?.elapsed ?? 0)}</div></div>
          <div className="text-right"><div className="text-[11px] uppercase tracking-wide text-ink-3">Remaining</div>
            <div className="num text-[26px] font-semibold leading-none">{left === null ? "—" : fmtClock(left * derate)}</div></div>
        </div>
        <Bar fraction={Math.max(frac, job?.fraction ?? 0)} height={10} />
        <div className="flex justify-between text-[12.5px] text-ink-2">
          <span>{job?.message ?? ""}</span>
          <span className="num">{sims ? `${done.toLocaleString()} / ${sims.toLocaleString()} simulations` : ""}</span>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-[15px] font-semibold">{title}</h3>
              <p className="text-[12px] text-ink-3">{dot} Grey broke a limit; blue met them all; {best}</p>
            </div>
            <div className="flex gap-4">
              <Stat k="generation" v={`${gen}/${total}`} />
              <Stat k="legal" v={`${Math.round(100 * (t?.feasible_fraction ?? 0))}%`} />
              {t?.best && shown?.best && (
                <>
                  <Stat k={units.metricLabel(t.metrics[1])} accent
                        v={<AnimatedNumber value={shown.best[0]} format={v => v.toLocaleString(undefined, { maximumFractionDigits: units.metricDigits(t.metrics[1]) })} />} />
                  <Stat k={units.metricLabel(t.metrics[0])} accent
                        v={<AnimatedNumber value={shown.best[1]} format={v => v.toLocaleString(undefined, { maximumFractionDigits: units.metricDigits(t.metrics[0]) })} />} />
                </>
              )}
            </div>
          </div>
          {shown ? <LivePlot snap={shown} range={range} epoch={s.liveEpoch} fitKey={fitKey} />
                 : <div className="plot tall grid place-items-center text-ink-3 text-[13px]">
                     <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
                       Waiting for the first generation&hellip;</motion.span></div>}
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-ink-3">Drag to pan, scroll to zoom.</span>
            <Button onClick={() => setFitKey(k => k + 1)}>Fit to data</Button>
          </div>
        </Card>

        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Speed">
            <Speedometer value={t?.rate ?? 0} label="sims / second" />
            <p className="text-[12px] text-ink-3 text-center">{t?.workers ? `Across ${t.workers} cores.` : ""}</p>
          </Card>
          <Card title="What is blocking designs"><Blocking rows={t?.blocking} /></Card>
          <Card title="Best so far">
            {shown && shown.trace.length > 1
              ? <><Spark trace={shown.trace} />
                  <p className="text-[12px] text-ink-3">Best {units.metricLabel(t!.metrics[1]).toLowerCase()} found so far.</p></>
              : <p className="text-[12px] text-ink-3">Waiting for the first generation&hellip;</p>}
            {s.best && (
              <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-line">
                <span className="text-[12px] text-ink-2 num">
                  {units.metricLabel(s.best.metric)} {units.metricToDisplay(s.best.metric, s.best.value).toLocaleString(undefined, { maximumFractionDigits: units.metricDigits(s.best.metric) })}
                  {units.metricUnit(s.best.metric) ? " " + units.metricUnit(s.best.metric) : ""}
                  {s.best.n_grains ? ` · ${s.best.n_grains} grains` : ""} &middot; generation {s.best.generation}
                </span>
                <Button onClick={s.downloadBest}>Download it (.ric)</Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, accent }: { k: string; v: React.ReactNode; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[10.5px] uppercase tracking-wide text-ink-3">{k}</div>
      <div className={cx("num text-[18px] font-semibold leading-tight", accent && "text-accent")}>{v}</div>
    </div>
  );
}
