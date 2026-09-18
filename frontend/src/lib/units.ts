/* Storage is SI throughout; these only shape what is shown and parsed, so
   switching between inches and millimetres can never quietly change a design. */

import type { MetricMeta, Unit } from "./types";

export const PA_PER_PSI = 6894.757293168361;
/** Mass flux: kg/m²s per lb/in²s. Not a mass conversion. */
export const KG_PER_LB = 703.0696;
export const M_PER_IN = 0.0254;
export const M_PER_FT = 0.3048;
export const KG_PER_LB_MASS = 0.45359237;

interface Scale {
  scale: number;
  label: string;
  dp: number;
  sep?: string;
}

export interface UnitSystem {
  name: string;
  length: Scale & { sep: string };
  pressure: Scale;
  mass_flux: Scale;
  /** Whole-rocket mass, for the launch rail. */
  mass: Scale;
  /** Rail length: feet or metres, since inches would read in the hundreds. */
  rail: Scale;
  steps: [number, string][];
  stepHint: string;
}

// Digits are what a shop holds: 0.01 in on a reamer, 0.1 mm likewise.
export const SYSTEMS: Record<Unit, UnitSystem> = {
  in: {
    name: "imperial",
    length: { scale: M_PER_IN, label: "″", sep: "", dp: 2 },
    pressure: { scale: PA_PER_PSI, label: "psi", dp: 0 },
    mass_flux: { scale: KG_PER_LB, label: "lb/in²s", dp: 3 },
    mass: { scale: KG_PER_LB_MASS, label: "lb", dp: 2 },
    rail: { scale: M_PER_FT, label: "ft", dp: 1 },
    steps: [[0, "any"], [0.01, "0.01″"], [0.05, "0.05″"],
            [0.1, "0.1″"], [0.0625, "1/16″"]],
    stepHint: "e.g. 0.05",
  },
  mm: {
    name: "metric",
    length: { scale: 0.001, label: "mm", sep: " ", dp: 1 },
    pressure: { scale: 1e6, label: "MPa", dp: 2 },
    mass_flux: { scale: 1, label: "kg/m²s", dp: 0 },
    mass: { scale: 1, label: "kg", dp: 2 },
    rail: { scale: 1, label: "m", dp: 2 },
    steps: [[0, "any"], [0.25, "0.25 mm"], [0.5, "0.5 mm"],
            [1, "1 mm"], [1.5, "1.5 mm"]],
    stepHint: "e.g. 1.5",
  },
};

/** Accepts "1/16", "1 1/2", "0.05", or a number. NaN when unreadable. */
export function parseNumber(text: string | number): number {
  if (typeof text === "number") return text;
  const raw = String(text ?? "").trim().replace(/["″]/g, "");
  if (!raw) return NaN;
  let total = 0;
  for (const part of raw.replace(/(\d)-(\d)/g, "$1 $2").split(/\s+/)) {
    if (part.includes("/")) {
      const [a, b] = part.split("/").map(Number);
      if (!b) return NaN;
      total += a / b;
    } else total += Number(part);
  }
  return total;
}

/** Everything unit-aware, bound to one system and one metric table. */
export class Units {
  constructor(public unit: Unit, private metrics: Record<string, MetricMeta>) {}

  get sys(): UnitSystem { return SYSTEMS[this.unit] ?? SYSTEMS.in; }
  get lengthScale(): number { return this.sys.length.scale; }
  get lenDigits(): number { return this.sys.length.dp; }

  toDisplay(m: number): number { return m / this.lengthScale; }
  toSI(v: number): number { return v * this.lengthScale; }

  fmtLen(m: number): string {
    const u = this.sys.length;
    return this.toDisplay(m).toFixed(u.dp) + u.sep + u.label;
  }

  lenValue(m: number): string { return this.toDisplay(m).toFixed(this.lenDigits); }

  private kindScale(metric: string): Scale | null {
    const kind = this.metrics[metric]?.kind;
    return kind ? this.sys[kind] : null;
  }

  metricToDisplay(metric: string, value: number): number {
    const u = this.kindScale(metric);
    return u ? value / u.scale : value;
  }

  metricToSI(metric: string, value: number): number {
    const u = this.kindScale(metric);
    return u ? value * u.scale : value;
  }

  metricUnit(metric: string): string {
    const u = this.kindScale(metric);
    return u ? u.label : (this.metrics[metric]?.unit ?? "");
  }

  metricDigits(metric: string): number {
    const u = this.kindScale(metric);
    return u ? u.dp : (this.metrics[metric]?.places ?? 0);
  }

  metricLabel(metric: string): string {
    return this.metrics[metric]?.label ?? metric;
  }

  axisTitle(metric: string): string {
    const u = this.metricUnit(metric);
    return this.metricLabel(metric) + (u ? " (" + u + ")" : "");
  }

  fmtMetric(metric: string, value: number): string {
    const shown = this.metricToDisplay(metric, value);
    const unit = this.metricUnit(metric);
    const dp = this.kindScale(metric) ? this.metricDigits(metric) : 3;
    return shown.toLocaleString(undefined, { maximumFractionDigits: dp })
      + (unit ? " " + unit : "");
  }

  /** Pressure and flux names the report understands. */
  displayUnits() {
    return {
      length: this.unit,
      pressure: this.sys.pressure.label,
      mass_flux: this.unit === "in" ? "lb/(in^2*s)" : "kg/(m^2*s)",
    };
  }
}
