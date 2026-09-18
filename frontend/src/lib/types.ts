/* Shapes the FastAPI server sends and accepts. SI throughout. */

export type Unit = "in" | "mm";
export type MetricKind = "pressure" | "mass_flux" | null;

export interface MetricMeta {
  label: string;
  unit: string;
  kind: MetricKind;
  places?: number;
  help?: string;
}

export interface VariableSpec {
  name: string;
  label?: string;
  free: boolean;
  low: number;
  high: number;
  step: number;
  fixed_value?: number | null;
}

export interface ObjectiveSpec {
  metric: string;
  direction: "max" | "min" | "target";
  weight: number;
  target: number | null;
  enabled: boolean;
}

export interface ConstraintSpec {
  metric: string;
  op: "<=" | ">=";
  value: number;
  enabled: boolean;
  margin: number;
  label: string;
}

export interface OrderingSpec {
  mode: string;
  min_step?: number;
  groups?: number[];
}

export interface GrainCountSpec {
  free: boolean;
  n_min: number;
  n_max: number;
}

/** The rocket and rail behind the rail exit speed metric. */
export interface RailSpec {
  hardware_mass: number | null;
  length: number;
  angle_deg: number;
}

export interface RunSpec {
  variables: VariableSpec[];
  objectives: ObjectiveSpec[];
  constraints: ConstraintSpec[];
  ordering: OrderingSpec;
  grain_count: GrainCountSpec;
  rail: RailSpec;
  effort: string;
  budget_simulations: number | null;
  seeds: number | null;
  workers: number | null;
  mode: "fast" | "pareto";
  expert: boolean;
  display_units: { length: string; pressure: string; mass_flux: string };
  [key: string]: unknown;
}

export interface Curves {
  time: number[];
  thrust: number[];
  pressure: number[];
  kn: number[];
  mass_flux?: number[][];
  mach?: number[][];
}

export interface MotorSummary {
  name: string;
  grain_count: number;
  stack_length: number;
  grain_diameter: number;
  grain_lengths: number[];
  cores: number[];
  throat: number;
  exit: number;
  propellant: string;
  throat_length: number;
  inhibited_ends: string;
  designation: string;
  ok: boolean;
  initial_thrust: number;
  total_impulse: number;
  isp: number;
  burn_time: number;
  max_pressure: number;
  peak_kn: number;
  initial_kn: number;
  peak_mass_flux: number;
  port_throat: number;
  prop_mass: number;
  warnings: string[];
  [key: string]: unknown;
}

export interface Hardware {
  grain_diameter: number;
  grain_length: number;
  grain_count: number;
  inhibited_ends: string;
  overridden: boolean;
}

export interface EffortLevel {
  budget: number;
  seeds: number;
  samples: number;
  label: string;
  seconds: number;
}

export interface ToleranceSpec {
  field: string;
  sigma: number;
  enabled: boolean;
}

export interface ToleranceField {
  label: string;
  kind: "absolute" | "relative";
  help?: string;
}

export interface Machine {
  cores?: number;
  default_workers?: number;
  platform?: "mac" | "windows" | "linux";
}

export interface Defaults {
  motor: MotorSummary;
  spec: RunSpec;
  metrics: Record<string, MetricMeta>;
  ordering_modes: Record<string, string>;
  effort_levels: Record<string, EffortLevel>;
  tolerance_fields: Record<string, ToleranceField>;
  tolerances: ToleranceSpec[];
  machine: Machine;
  hardware: Hardware;
  curves: Curves;
}

export interface Estimate {
  simulations?: number;
  seconds?: number;
  measured?: boolean;
  seeds?: number;
  pop?: number;
  gen?: number;
  grain_counts?: number;
  stage_one?: number;
  carried?: number;
  rounds?: number;
  initial?: number;
  infill?: number;
  model_runs?: number;
  openmotor_runs?: number;
}

export interface SizingBlock {
  count: number | null;
  count_exact?: string;
  note?: string;
}

export interface Sizing {
  total: number | null;
  total_text?: string;
  total_exact?: string;
  free_variables: number;
  held_variables?: number;
  continuous?: boolean;
  evaluated?: number;
  fraction_text?: string;
  brute_force_text?: string;
  counts?: { n: number; total: number | null; total_text?: string }[];
  cores?: SizingBlock;
  nozzle?: SizingBlock;
  others?: { name: string; held: boolean; values: number | null }[];
  reduction?: {
    total_text?: string;
    after_bounds_text?: string;
    legal_text?: string;
    tightened?: { changes?: { variable: string; to: number; why: string }[] };
    equivalences?: { title: string; detail: string }[];
  } | null;
}

export interface RailFigures {
  baseline_velocity: number | null;
  max_hardware_mass: number | null;
  target: number | null;
}

export interface Validation {
  problems: string[];
  problem_areas?: string[];
  notes?: string[];
  estimate?: Estimate;
  sizing?: Sizing;
  preset_seconds?: Record<string, number> | null;
  rail?: RailFigures | null;
}

export interface Diagnostic {
  rate: number;
  workers: number;
  thermal_derate?: number;
  [key: string]: unknown;
}

export interface BlockingRow {
  metric: string;
  op: string;
  share: number;
}

export interface TraceRow {
  seed: number;
  gen: number;
  a: number;
  b: number;
}

/** One generation of the search, as the runner reports it. */
export interface Telemetry {
  generation: number;
  seed_index: number;
  n_seeds: number;
  metrics: [string, string];
  points: [number, number, boolean][];
  front: [number, number][];
  feasible_fraction: number;
  blocking: BlockingRow[];
  single_objective: boolean;
  surrogate: boolean;
  best: [number, number] | null;
  n_grains?: number;
  stage?: string;
  total_generations?: number;
  simulations_done?: number;
  simulations_total?: number;
  rate?: number;
  workers?: number;
  trace?: TraceRow[];
}

export interface BestSoFar {
  x: number[];
  score: number;
  metric: string;
  value: number;
  values: Record<string, number>;
  n_grains?: number;
  generation: number;
  seed_index: number;
  stage: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  stage: string;
  fraction: number;
  message: string;
  error: string;
  elapsed: number;
  label: string;
  n_designs: number;
  report: string;
  report_error: string;
  bundle_kind: string;
  bundle_status: "idle" | "building" | "ready" | "failed";
  bundle_done: number;
  bundle_total: number;
  bundle_message: string;
  bundle_error: string;
  telemetry?: Telemetry | null;
  best?: BestSoFar | null;
}

export interface Design {
  label?: string;
  x: number[];
  cores: number[];
  grain_diameter: number;
  grain_lengths: number[];
  n_grains: number;
  throat: number;
  exit: number;
  throat_length?: number;
  designation?: string;
  curves?: Curves;
  initial_thrust: number;
  total_impulse: number;
  peak_kn: number;
  max_pressure: number;
  peak_mass_flux: number;
  [key: string]: unknown;
}

export interface PopulationRow {
  feasible: boolean;
  [key: string]: unknown;
}

export interface GrainCountStack {
  n: number;
  grain_length: number;
  dropped?: string;
  carried?: boolean;
  designs?: number;
  simulations?: number;
  stage1?: { rank?: number; score?: number | null; near?: number | null };
}

export interface GrainCountInfo {
  free: boolean;
  stacks?: GrainCountStack[];
  stage_generations?: number;
  stack_length?: number;
}

export interface Results {
  spec: RunSpec;
  baseline: Design;
  designs: Design[];
  population: PopulationRow[];
  convergence: { n: number; best: number }[];
  surrogate?: {
    parity?: Record<string, { actual: number[]; predicted: number[] }>;
    importances?: { feature: string; importance: number }[];
  } | null;
  constraint_activity: { label: string; binding_fraction: number }[];
  sensitivity: { variable: string; up: number; down: number }[];
  stats: {
    seconds?: number;
    objective_labels?: string[];
    searched?: string[];
    grain_counts?: GrainCountInfo | null;
  };
  messages: string[];
}

export interface Robustness {
  available: boolean;
  reason?: string;
  samples: number;
  pass_rate: number;
  pass_low: number;
  pass_high: number;
  per_limit?: {
    label: string;
    metric: string;
    op: "<=" | ">=";
    limit: number;
    exceed_probability: number;
    samples?: number[];
  }[];
}

export interface About {
  version: string;
  desktop: boolean;
  data_dir: string;
  platform: "mac" | "windows" | "linux";
}
