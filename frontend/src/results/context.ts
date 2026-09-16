/* What every results panel draws from. Built once per render of the step. */

import { useMemo } from "react";
import { orderAxes } from "@/components/charts/Live";
import type { ConstraintSpec, Design, GrainCountInfo, PopulationRow, Results, Robustness } from "@/lib/types";
import { useApp } from "@/store/app";

export interface Ctx {
  results: Results;
  design: Design | undefined;
  compare: Design | null;
  compareIndex: number | null;
  designs: Design[];
  baseline: Design;
  population: PopulationRow[];
  convergence: { n: number; best: number }[];
  surrogate: Results["surrogate"];
  constraintActivity: Results["constraint_activity"];
  sensitivity: Results["sensitivity"];
  constraints: ConstraintSpec[];
  robustness: Robustness | null;
  searched: string[];
  grainCounts: GrainCountInfo | null;
  selected: number;
  hover: number | null;
  axes: [string, string];
}

export function useCtx(): Ctx | null {
  const results = useApp(s => s.results);
  const spec = useApp(s => s.spec);
  const selected = useApp(s => s.selected);
  const compare = useApp(s => s.compare);
  const hover = useApp(s => s.hover);
  const robustness = useApp(s => s.robustness);
  return useMemo(() => {
    if (!results) return null;
    const labels = results.stats?.objective_labels ?? ["initial_thrust"];
    const pair = labels.length > 1 ? labels
      : [labels[0], labels[0] === "total_impulse" ? "initial_thrust" : "total_impulse"];
    return {
      results,
      design: results.designs[selected],
      compare: compare === null ? null : (results.designs[compare] ?? null),
      compareIndex: compare,
      designs: results.designs ?? [],
      baseline: results.baseline,
      population: results.population ?? [],
      convergence: results.convergence ?? [],
      surrogate: results.surrogate,
      constraintActivity: results.constraint_activity ?? [],
      sensitivity: results.sensitivity ?? [],
      constraints: ((results.spec ?? spec)?.constraints ?? []).filter(c => c.enabled),
      robustness,
      searched: results.stats?.searched ?? [],
      grainCounts: results.stats?.grain_counts ?? null,
      selected,
      hover,
      axes: orderAxes(pair),
    };
  }, [results, spec, selected, compare, hover, robustness]);
}
