export function fmtDuration(seconds?: number | null): string {
  if (!seconds) return "a moment";
  if (seconds < 90) return Math.round(seconds) + " s";
  if (seconds < 5400) return Math.round(seconds / 60) + " min";
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60);
}

export function fmtNum(v: number): string {
  if (v >= 1000) return Math.round(v).toLocaleString();
  if (v >= 10) return v.toFixed(0);
  return v.toFixed(v < 1 ? 3 : 2);
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString();
}

export function shortVar(name: string): string {
  return name.replace("core_", "core ").replace("exit_frac", "exit")
    .replace("n_grains", "grains").replace("_", " ");
}

/** "4.5 × 10^19" with a real superscript, everywhere it appears. */
export function supExp(text?: string | null): string {
  return String(text ?? "").replace(/\^(-?\d+)/g, (_, d) => `<sup>${d}</sup>`);
}

/** Even splits only: how many mandrel sizes, spread as evenly as possible. */
export function partitions(n: number): number[][] {
  const out: number[][] = [];
  for (let k = 1; k <= n; k++) {
    const base = Math.floor(n / k), extra = n % k;
    out.push(Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0)));
  }
  return out;
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined"
    && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
