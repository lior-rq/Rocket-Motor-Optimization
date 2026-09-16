/* One store for the whole tool. Everything typed is held in SI and converted
   only for display. Spec edits go through `edit`, which clones, applies, and
   schedules a validate, so no screen can forget to. */

import { create } from "zustand";
import { api, watchJob } from "@/lib/api";
import { isDesktopShell, openReport as bridgeOpenReport, saveBlob } from "@/lib/desktop";
import { Units } from "@/lib/units";
import type {
  BestSoFar, Defaults, Design, Diagnostic, EffortLevel, Hardware, Job,
  Machine, MetricMeta, MotorSummary, Results, Robustness, RunSpec, Telemetry,
  ToleranceField, ToleranceSpec, Unit, Validation, Curves,
} from "@/lib/types";

export const STEPS = 7;
export const SETTINGS = 4, RUNNING = 5, RESULTS = 6;
export type Theme = "dark" | "light";

export interface Toast { id: number; text: string }

export interface Bundle {
  kind: string;
  active: boolean;
  fraction: number;
  message: string;
}

interface State {
  booted: boolean;
  bootError: string | null;
  desktop: boolean;
  version: string;
  unit: Unit;
  theme: Theme;

  spec: RunSpec | null;
  motor: MotorSummary | null;
  metrics: Record<string, MetricMeta>;
  orderingModes: Record<string, string>;
  effortLevels: Record<string, EffortLevel>;
  toleranceFields: Record<string, ToleranceField>;
  tolerances: ToleranceSpec[] | null;
  machine: Machine;
  hardware: Hardware | null;
  baselineCurves: Curves | null;

  validation: Validation;
  validating: boolean;
  presetSeconds: Record<string, number> | null;
  diagnostic: Diagnostic | null;
  diagRunning: boolean;

  ready: Record<string, boolean>;
  battery: { supported: boolean; charging?: boolean; level?: number } | null;
  wakeLock: WakeLockSentinel | null;

  step: number;
  reached: number;

  jobId: string | null;
  job: Job | null;
  liveSnap: Telemetry | null;
  best: BestSoFar | null;
  runStart: number;
  liveRange: { x: [number, number]; y: [number, number] } | null;
  liveEpoch: number;

  results: Results | null;
  selected: number;
  compare: number | null;
  hover: number | null;
  profile: string;
  robustness: Robustness | null;
  robustnessBusy: boolean;
  optionSort: { key: string; dir: 1 | -1 };
  reportJob: string | null;
  bundle: Bundle;

  toasts: Toast[];
}

interface Actions {
  boot(): Promise<void>;
  loadDefaults(payload?: Defaults): Promise<void>;
  setUnit(unit: Unit): void;
  toggleTheme(): void;
  edit(fn: (spec: RunSpec) => void, opts?: { validate?: boolean }): void;
  setTolerances(fn: (rows: ToleranceSpec[]) => void): void;
  validate(): void;
  uploadMotor(file: File): Promise<void>;
  applyHardware(ends: string): Promise<void>;
  resetHardware(): Promise<void>;
  applyPreset(kind: string): void;
  tighten(): Promise<void>;
  runDiagnostic(): Promise<void>;
  markReady(id: string): void;
  requestWakeLock(): Promise<void>;
  recheckMachine(): void;
  goTo(step: number): void;
  startRun(): Promise<void>;
  cancelRun(): Promise<void>;
  attachToRun(id: string): Promise<void>;
  loadResults(): Promise<void>;
  setLiveRange(range: State["liveRange"]): void;
  selectDesign(index: number): Promise<void>;
  compareDesign(index: number | null): Promise<void>;
  highlightDesign(index: number | null): void;
  setProfile(id: string): void;
  setOptionSort(key: string): void;
  checkRobustness(): Promise<void>;
  exportDesign(index: number): Promise<void>;
  downloadBest(): Promise<void>;
  downloadBundle(kind: string): Promise<void>;
  openReport(): Promise<void>;
  toast(text: string, ms?: number): void;
  dismissToast(id: number): void;
}

export type Store = State & Actions;

let validateTimer: ReturnType<typeof setTimeout> | null = null;
let validateSeq = 0;
let watcher: AbortController | null = null;
let toastSeq = 0;
let batteryHandle: BatteryManager | null = null;

interface BatteryManager extends EventTarget {
  charging: boolean;
  level: number;
}

const storedUnit = (): Unit => {
  try { return (localStorage.getItem("units") as Unit) || "in"; } catch { return "in"; }
};
const storedTheme = (): Theme => {
  try { return (localStorage.getItem("theme") as Theme) || "dark"; } catch { return "dark"; }
};

export const useApp = create<Store>((set, get) => ({
  booted: false,
  bootError: null,
  desktop: false,
  version: "",
  unit: storedUnit(),
  theme: storedTheme(),

  spec: null,
  motor: null,
  metrics: {},
  orderingModes: {},
  effortLevels: {},
  toleranceFields: {},
  tolerances: null,
  machine: {},
  hardware: null,
  baselineCurves: null,

  validation: { problems: [] },
  validating: false,
  presetSeconds: null,
  diagnostic: null,
  diagRunning: false,

  ready: {},
  battery: null,
  wakeLock: null,

  step: 0,
  reached: 0,

  jobId: null,
  job: null,
  liveSnap: null,
  best: null,
  runStart: 0,
  liveRange: null,
  liveEpoch: 0,

  results: null,
  selected: 0,
  compare: null,
  hover: null,
  profile: "design",
  robustness: null,
  robustnessBusy: false,
  optionSort: { key: "rank", dir: 1 },
  reportJob: null,
  bundle: { kind: "sheets", active: false, fraction: 0, message: "" },

  toasts: [],

  /* ------------------------------------------------------------ boot */

  async boot() {
    document.documentElement.dataset.theme = get().theme;
    readBattery(set);
    try {
      const about = await api.about();
      set({ desktop: isDesktopShell() || about.desktop, version: about.version || "" });
    } catch { /* an old server without this route; carry on */ }
    try {
      await get().loadDefaults();
    } catch (err) {
      set({ bootError: (err as Error).message || "Could not read the default motor." });
    }
    // ?step=N opens on that step and ?job=ID reopens a held run, for
    // screenshots and the field guide.
    const params = new URLSearchParams(location.search);
    if (params.get("profile")) set({ profile: params.get("profile")! });
    const job = params.get("job");
    const step = Number(params.get("step"));
    if (job) { set({ reached: STEPS - 1 }); await get().attachToRun(job); }
    if (Number.isInteger(step) && step > 0 && step < STEPS && params.has("step")) {
      set({ reached: Math.max(get().reached, step) });
      get().goTo(step);
    }
    set({ booted: true });
  },

  async loadDefaults(payload?: Defaults) {
    const data = payload ?? await api.defaults();
    const units = new Units(get().unit, data.metrics);
    const spec = { ...data.spec, display_units: units.displayUnits() };
    set(s => ({
      spec,
      motor: data.motor,
      metrics: data.metrics,
      orderingModes: data.ordering_modes,
      effortLevels: data.effort_levels,
      baselineCurves: data.curves,
      hardware: data.hardware ?? null,
      toleranceFields: data.tolerance_fields ?? {},
      machine: data.machine ?? {},
      tolerances: s.tolerances ?? data.tolerances ?? [],
      bootError: null,
      results: null,
      robustness: null,
    }));
    get().validate();
  },

  setUnit(unit) {
    try { localStorage.setItem("units", unit); } catch { /* fine */ }
    set(s => {
      if (!s.spec) return { unit };
      const units = new Units(unit, s.metrics);
      return { unit, spec: { ...s.spec, display_units: units.displayUnits() }, liveRange: null };
    });
  },

  toggleTheme() {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", theme); } catch { /* fine */ }
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  /* ------------------------------------------------------------ spec */

  edit(fn, opts) {
    const current = get().spec;
    if (!current) return;
    const next = structuredClone(current);
    fn(next);
    set({ spec: next });
    if (opts?.validate !== false) get().validate();
  },

  setTolerances(fn) {
    const rows = structuredClone(get().tolerances ?? []);
    fn(rows);
    set({ tolerances: rows });
  },

  validate() {
    if (validateTimer) clearTimeout(validateTimer);
    set({ validating: true });
    const seq = ++validateSeq;
    validateTimer = setTimeout(async () => {
      const spec = get().spec;
      if (!spec) { set({ validating: false }); return; }
      try {
        const data = await api.validate(spec);
        if (seq !== validateSeq) return;   // a newer edit is already in flight
        set({
          validation: data,
          validating: false,
          // Only once measured: before that the preset's own nominal figure
          // is closer to the truth than a rate this machine has never run.
          presetSeconds: data.estimate?.measured ? data.preset_seconds ?? null : null,
        });
      } catch (err) {
        if (seq !== validateSeq) return;
        set({ validating: false,
              validation: { problems: [(err as Error).message || "Could not validate."] } });
      }
    }, 220);
  },

  async uploadMotor(file) {
    const content = await file.text();
    try {
      const data = await api.uploadMotor(file.name, content);
      await get().loadDefaults(data);
      get().toast("Loaded " + file.name);
    } catch {
      get().toast("Could not read that .ric file.");
    }
  },

  async applyHardware(ends) {
    try {
      const data = await api.setHardware(ends);
      await get().loadDefaults(data);
      get().toast("Hardware applied. Bounds and baseline updated.");
    } catch {
      get().toast("Could not apply that hardware.");
    }
  },

  async resetHardware() {
    try {
      const data = await api.resetHardware();
      await get().loadDefaults(data);
      get().toast("Reloaded the motor exactly as the file has it");
    } catch {
      get().toast("Could not reset.");
    }
  },

  applyPreset(kind) {
    get().edit(s => {
      s.objectives.forEach(o => { o.enabled = false; });
      const on = (metric: string, direction: "max" | "min") => {
        let row = s.objectives.find(o => o.metric === metric);
        if (!row) {
          row = { metric, direction, weight: 1, target: null, enabled: true };
          s.objectives.push(row);
        }
        Object.assign(row, { enabled: true, direction, weight: 1 });
      };
      if (kind === "thrust") on("initial_thrust", "max");
      if (kind === "impulse") on("total_impulse", "max");
      if (kind === "flat") on("thrust_variation", "min");
      if (kind === "tradeoff") { on("initial_thrust", "max"); on("total_impulse", "max"); }
      s.mode = kind === "tradeoff" ? "pareto" : "fast";
    });
  },

  async tighten() {
    const spec = get().spec;
    if (!spec) return;
    try {
      const data = await api.tighten(spec);
      const units = new Units(get().unit, get().metrics);
      set({ spec: { ...data.spec, display_units: units.displayUnits() } });
      get().validate();
      const what = (data.changes ?? []).map(c => `${c.variable} to ${units.fmtLen(c.to)}`).join(", ");
      get().toast(what ? `Narrowed ${what}. Nothing legal was removed.` : "Already as tight as it gets");
    } catch {
      get().toast("Could not tighten those bounds.");
    }
  },

  async runDiagnostic() {
    const spec = get().spec;
    if (!spec) return;
    set({ diagRunning: true });
    try {
      const data = await api.diagnostic(spec);
      set({ diagnostic: data.diagnostic });
      get().toast("Measured " + data.diagnostic.rate + " simulations a second.");
    } catch (err) {
      get().toast((err as Error).message || "The diagnostic could not run.");
    } finally {
      set({ diagRunning: false });
      get().validate();
    }
  },

  markReady(id) {
    set(s => ({ ready: { ...s.ready, [id]: true } }));
  },

  async requestWakeLock() {
    try {
      const lock = await navigator.wakeLock.request("screen");
      // The browser drops the lock whenever the tab goes to the background.
      lock.addEventListener("release", () => set({ wakeLock: null }));
      set({ wakeLock: lock });
    } catch {
      set({ wakeLock: null });
      get().toast("This browser will not hold the screen awake.");
    }
  },

  // chargingchange does not always fire in every browser, so arriving on the
  // settings step re-reads rather than trusting the last event.
  recheckMachine() {
    if (batteryHandle) {
      set({ battery: { supported: true, charging: batteryHandle.charging,
                       level: batteryHandle.level } });
    }
    const lock = get().wakeLock;
    if (lock && lock.released) set({ wakeLock: null });
  },

  /* ---------------------------------------------------------- wizard */

  goTo(i) {
    const step = Math.max(0, Math.min(i, STEPS - 1));
    set(s => ({ step, reached: Math.max(s.reached, step) }));
    if (step === SETTINGS) get().recheckMachine();
    window.scrollTo({ top: 0, behavior: "smooth" });
  },

  /* ------------------------------------------------------ run + watch */

  async startRun() {
    const spec = get().spec;
    if (!spec) return;
    let job: Job;
    try {
      job = await api.run(spec);
    } catch (err) {
      get().toast((err as Error).message || "Could not start.");
      return;
    }
    set(s => ({
      jobId: job.id, job, results: null, liveSnap: null, best: null,
      liveRange: null, liveEpoch: s.liveEpoch + 1, runStart: Date.now(),
      robustness: null, reportJob: null,
    }));
    get().goTo(RUNNING);
    watch(job.id, set, get);
  },

  async cancelRun() {
    const id = get().jobId;
    if (!id) return;
    try { await api.cancel(id); } catch { /* already finished */ }
  },

  async attachToRun(id) {
    let job: Job;
    try {
      job = await api.live(id);
    } catch {
      get().toast("That run is no longer held.");
      return;
    }
    set({ jobId: id, job });
    if (job.status === "done") {
      set({ reportJob: job.id });
      await get().loadResults();
      return;
    }
    if (job.status === "running" || job.status === "queued") {
      set(s => ({ liveSnap: job.telemetry ?? null, best: job.best ?? null,
                  liveEpoch: s.liveEpoch + 1, runStart: Date.now() - job.elapsed * 1000 }));
      get().goTo(RUNNING);
      watch(id, set, get);
      return;
    }
    get().toast("That run " + job.status + ".");
  },

  async loadResults() {
    const id = get().jobId;
    if (!id) return;
    let results: Results;
    try {
      results = await api.results(id);
    } catch {
      get().toast("Could not fetch results.");
      return;
    }
    set({ results, selected: 0, compare: null, robustness: null, hover: null });
    if (!results.designs.length) {
      get().toast(results.messages[0] || "No design met every limit.", 6000);
    } else {
      get().toast(`Found ${results.designs.length} option${
        results.designs.length > 1 ? "s" : ""} in ${results.stats.seconds}s`);
      set({ reached: STEPS - 1 });
      get().goTo(RESULTS);
    }
  },

  setLiveRange(range) { set({ liveRange: range }); },

  /* --------------------------------------------------------- results */

  async selectDesign(index) {
    const designs = get().results?.designs ?? [];
    const design = designs[index];
    if (!design) return;
    set(s => ({ selected: index, compare: s.compare === index ? null : s.compare,
                robustness: null }));
    await ensureCurves(design, index, set, get);
    set({ profile: "design" });
    get().toast("Option " + (index + 1) + " loaded as the optimized motor.");
  },

  async compareDesign(index) {
    const designs = get().results?.designs ?? [];
    if (index === null || index === get().selected || !designs[index]) {
      set({ compare: null });
      return;
    }
    set({ compare: index });
    await ensureCurves(designs[index], index, set, get);
    const p = get().profile;
    if (p !== "design" && p !== "compare") set({ profile: "design" });
  },

  highlightDesign(index) { set({ hover: index }); },
  setProfile(id) { set({ profile: id }); },

  setOptionSort(key) {
    set(s => {
      const now = s.optionSort;
      // Same column again flips the direction; a new column starts descending
      // for metrics, since bigger is usually what is being looked for.
      return { optionSort: now.key === key
        ? { key, dir: (-now.dir) as 1 | -1 }
        : { key, dir: key === "rank" || key === "n_grains" ? 1 : -1 } };
    });
  },

  async checkRobustness() {
    const s = get();
    const design = s.results?.designs[s.selected];
    if (!design || !s.results) { s.toast("Run the optimizer first."); return; }
    set({ robustnessBusy: true });
    try {
      const report = await api.robustness(s.results.spec || s.spec!, design, s.tolerances ?? []);
      set({ robustness: report });
    } catch {
      s.toast("Could not run the check.");
    } finally {
      set({ robustnessBusy: false });
    }
  },

  async exportDesign(index) {
    const s = get();
    const design = s.results?.designs[index];
    if (!design || !s.spec) return;
    try {
      const blob = await api.export(s.spec, design, "optimized_" + (design.designation || index + 1));
      const filename = "optimized_" + (design.designation || ("option" + (index + 1))) + ".ric";
      const result = await saveBlob(blob, filename);
      if (result.ok) s.toast("Saved .ric. Open it in openMotor.");
      else if (!result.cancelled) s.toast("Could not save: " + (result.error ?? ""));
    } catch {
      s.toast("Export failed.");
    }
  },

  async downloadBest() {
    const s = get();
    if (!s.jobId || !s.best) return;
    const res = await api.bestRic(s.jobId);
    if (!res.ok) { s.toast("No legal design yet."); return; }
    const result = await saveBlob(await res.blob(), "best-so-far.ric");
    if (result.ok) s.toast("Saved the best motor so far. Open it in openMotor.");
  },

  async downloadBundle(kind) {
    const s = get();
    const id = s.reportJob;
    if (!id || s.bundle.active) return;
    set({ bundle: { kind, active: true, fraction: 0, message: "Starting…" } });
    try {
      await api.startBundle(id, kind);
    } catch (err) {
      s.toast((err as Error).message || "Could not start.");
      set({ bundle: { kind, active: false, fraction: 0, message: "" } });
      return;
    }
    const names: Record<string, string> = {
      sheets: "design-sheets.zip", eng: "motors.eng", ric: "ric-files.zip",
    };
    for (;;) {
      const res = await api.bundle(id);
      if (!res.ok) {
        set({ bundle: { kind, active: false, fraction: 0, message: "" } });
        return;
      }
      // Ready, and the file itself is the response rather than a status.
      const disposition = res.headers.get("Content-Disposition") || "";
      if (disposition.startsWith("attachment")) {
        const filename = disposition.replace(/.*filename="([^"]+)".*/, "$1") || names[kind] || "download";
        const result = await saveBlob(await res.blob(), filename);
        const message = result.ok ? (get().desktop ? "Saved." : "Downloaded.")
          : (result.cancelled ? "Cancelled." : "Could not save.");
        set({ bundle: { kind, active: false, fraction: 1, message } });
        return;
      }
      const job = await res.json() as Job;
      if (job.bundle_status === "failed") {
        get().toast(job.bundle_error || "Could not build that download.");
        set({ bundle: { kind, active: false, fraction: 0, message: "" } });
        return;
      }
      const fraction = job.bundle_total ? job.bundle_done / job.bundle_total : 0;
      set({ bundle: { kind, active: true, fraction, message: job.bundle_message || "Working…" } });
      await new Promise(r => setTimeout(r, 900));
    }
  },

  async openReport() {
    const id = get().reportJob;
    if (!id) return;
    const error = await bridgeOpenReport(id);
    if (error) get().toast(error);
  },

  /* ----------------------------------------------------------- toast */

  toast(text, ms = 2600) {
    const id = ++toastSeq;
    set(s => ({ toasts: [...s.toasts.slice(-2), { id, text }] }));
    setTimeout(() => get().dismissToast(id), ms);
  },

  dismissToast(id) {
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
  },
}));

type Set = (partial: Partial<State> | ((s: State) => Partial<State>)) => void;
type Get = () => Store;

function watch(id: string, set: Set, get: Get) {
  watcher?.abort();
  watcher = new AbortController();
  watchJob(id, job => {
    set(s => ({
      job,
      liveSnap: job.telemetry ?? s.liveSnap,
      best: job.best ?? s.best,
    }));
  }, watcher.signal).then(async job => {
    if (get().jobId !== id) return;
    if (job.status === "done") {
      set({ reportJob: job.id });
      await get().loadResults();
    } else if (job.status === "failed") {
      get().toast(job.error || "Run failed.");
    } else if (job.status === "cancelled") {
      get().toast("Run cancelled.");
    }
  }).catch(() => {
    get().toast("Lost contact with the run.");
  });
}

/** Only the first few designs come back with curves, so the rest are
    simulated on demand; without them Design Review has nothing to draw. */
async function ensureCurves(design: Design, index: number, set: Set, get: Get) {
  if (design.curves) return;
  const s = get();
  if (!s.spec) return;
  s.toast("Simulating option " + (index + 1) + "…");
  try {
    const full = await api.curves(s.spec, design);
    if (full.curves) {
      set(st => {
        if (!st.results) return {};
        const designs = st.results.designs.slice();
        designs[index] = { ...designs[index], curves: full.curves };
        return { results: { ...st.results, designs } };
      });
    }
  } catch { /* the panels that need curves say so themselves */ }
}

async function readBattery(set: Set) {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (!nav.getBattery) { set({ battery: { supported: false } }); return; }
  try {
    const b = await nav.getBattery();
    batteryHandle = b;
    const sync = () => set({ battery: { supported: true, charging: b.charging, level: b.level } });
    b.addEventListener("chargingchange", sync);
    b.addEventListener("levelchange", sync);
    sync();
  } catch {
    set({ battery: { supported: false } });
  }
}
