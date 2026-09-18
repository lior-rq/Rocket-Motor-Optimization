/* Derived state: what each step needs before it lets you past it. */

import { useMemo } from "react";
import { Units } from "@/lib/units";
import { RUNNING, SETTINGS, STEPS, useApp, type Store } from "./app";

// Which step can fix each kind of problem, so a fault never blocks a step
// that cannot resolve it.
const AREA_STEP: Record<string, number> = {
  variables: 1, constraints: 2, objectives: 3, settings: SETTINGS,
};

export function problemsFor(s: Store, i: number): string[] {
  const areas = s.validation.problem_areas ?? [];
  return (s.validation.problems ?? [])
    .filter((_, n) => (AREA_STEP[areas[n]] ?? SETTINGS) === i);
}

export function stepDone(s: Store, i: number): boolean {
  const spec = s.spec;
  if (!spec) return false;
  switch (i) {
    case 0: return !!s.motor;
    case 1: return spec.variables.some(v => v.free) && !problemsFor(s, 1).length;
    case 2: return !problemsFor(s, 2).length;
    case 3: return spec.objectives.some(o => o.enabled) && !problemsFor(s, 3).length;
    case SETTINGS: return (s.validation.problems ?? []).length === 0;
    case RUNNING: return !!s.results;
    default: return true;
  }
}

export function furthestAllowed(s: Store): number {
  let i = 0;
  while (i < STEPS - 1 && stepDone(s, i)) i++;
  // One past the furthest step actually visited, so the flow is walked
  // rather than jumped, and never behind it, so nothing can trap the user.
  return Math.min(i, s.reached + 1);
}

export function gateReason(s: Store, i: number): string {
  switch (i) {
    case 0: return "Load a .ric file to continue.";
    case 1: return problemsFor(s, 1)[0] || "At least one dimension has to be free to change.";
    case 2: return problemsFor(s, 2)[0] || "Resolve the problems above.";
    case 3: return problemsFor(s, 3)[0] || "Pick at least one thing to optimize.";
    case SETTINGS: return (s.validation.problems ?? [])[0] || "Resolve the problems above.";
    case RUNNING: return s.jobId && s.job && (s.job.status === "running" || s.job.status === "queued")
      ? "The search is still running." : "Run the search first.";
    default: return "";
  }
}

/** Only from the settings step, so the flow is walked rather than skipped. */
export function canRun(s: Store): boolean {
  return s.step >= SETTINGS && [0, 1, 2, 3].every(i => stepDone(s, i))
    && (s.validation.problems ?? []).length === 0;
}

export function isRunning(s: Store): boolean {
  return !!s.job && (s.job.status === "running" || s.job.status === "queued");
}

export function useUnits(): Units {
  const unit = useApp(s => s.unit);
  const metrics = useApp(s => s.metrics);
  return useMemo(() => new Units(unit, metrics), [unit, metrics]);
}

export const isCore = (v: { name: string }) => v.name.startsWith("core");
