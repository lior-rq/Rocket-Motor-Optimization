/* Panels and the profiles that group them. A profile is just a list of
   panel ids, so adding one is a one-line change. */

import type { ComponentType } from "react";
import type { Ctx } from "./context";
import { GrainFlux, GrainMach, PressureKn, ThrustCurve } from "./curves";
import { ConstraintActivity, Convergence, GrainCounts, Importance, Parity, Tornado } from "./diagnostics";
import { RobustnessPanel, RobustnessSpread } from "./robustness";
import { CrossSection, MarginBars, OptionsTable, SpecSheet } from "./tables";
import { ObjectiveSpread, ParallelCoords, ParetoFront, PopulationCloud } from "./tradeoff";

export interface PanelDef {
  title: string;
  sub: string;
  Component: ComponentType<{ ctx: Ctx }>;
}

export const PANELS: Record<string, PanelDef> = {
  thrustCurve: { title: "Thrust curve", sub: "Selected design, simulated at full fidelity", Component: ThrustCurve },
  pressureKn: { title: "Chamber pressure and Kn", sub: "Two stacked panels — never two scales on one axis", Component: PressureKn },
  crossSection: { title: "Motor cutaway", sub: "To scale, forward at left. Drag to orbit.", Component: CrossSection },
  specSheet: { title: "Specification", sub: "Optimized design against your current motor", Component: SpecSheet },
  marginBars: { title: "How close it runs to each limit", sub: "Full bar means the limit is reached exactly", Component: MarginBars },
  paretoFront: { title: "Your options", sub: "Click any point to load that motor into Design Review", Component: ParetoFront },
  populationCloud: { title: "Every design tried", sub: "Grey failed a limit; blue met them all", Component: PopulationCloud },
  parallelCoords: { title: "What the good designs have in common", sub: "Each line is one legal design, coloured by how well it scored", Component: ParallelCoords },
  objectiveSpread: { title: "Spread of results", sub: "Where the search spent its time", Component: ObjectiveSpread },
  convergence: { title: "Search progress", sub: "Best legal score found, against simulations spent", Component: Convergence },
  parity: { title: "Model accuracy", sub: "Predicted against simulated, on designs held back from training", Component: Parity },
  importance: { title: "Which dimension matters most", sub: "Drop in model accuracy when that value is shuffled", Component: Importance },
  grainCounts: { title: "Grain counts", sub: "The stack cut each way: checked on paper, tried briefly, searched in full", Component: GrainCounts },
  constraintActivity: { title: "Which limit is holding you back", sub: "Share of legal designs sitting within 2% of each limit", Component: ConstraintActivity },
  compareThrust: { title: "Before and after", sub: "Your motor against the selected design", Component: ThrustCurve },
  grainFlux: { title: "Mass flux in each grain", sub: "The aft grain always runs hottest — that is the one the limit is about", Component: GrainFlux },
  grainMach: { title: "Core Mach in each grain", sub: "Gas speed down the port; past Mach 1 the core chokes", Component: GrainMach },
  tornado: { title: "What moves the needle", sub: "Change in the leading goal from one step either way", Component: Tornado },
  robustness: { title: "What happens when you build it", sub: "The same design made many times, with your tolerances applied", Component: RobustnessPanel },
  robustnessSpread: { title: "Where the builds land", sub: "The limit that goes over most often, across every simulated build", Component: RobustnessSpread },
  optionsTable: { title: "All options found", sub: "Click a row to inspect it, vs to compare it, .ric to export it", Component: OptionsTable },
};

export const PROFILES: { id: string; label: string; panels: [string, 1 | 2][] }[] = [
  { id: "design", label: "Design Review",
    panels: [["thrustCurve", 1], ["pressureKn", 1], ["crossSection", 2], ["specSheet", 1], ["marginBars", 1]] },
  { id: "tradeoff", label: "Trade-off Explorer",
    panels: [["paretoFront", 1], ["populationCloud", 1], ["parallelCoords", 2], ["objectiveSpread", 1], ["optionsTable", 1]] },
  { id: "diagnostics", label: "Optimizer Diagnostics",
    panels: [["convergence", 1], ["constraintActivity", 1], ["grainCounts", 2], ["parity", 1], ["importance", 1]] },
  { id: "compare", label: "Compare & Safety",
    panels: [["compareThrust", 2], ["specSheet", 1], ["grainFlux", 1], ["grainMach", 1], ["robustness", 1],
             ["robustnessSpread", 1], ["tornado", 2]] },
];
