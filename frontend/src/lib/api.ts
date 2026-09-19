/* Every route the server exposes, typed. Errors carry the server's detail. */

import type {
  About, Defaults, Design, Diagnostic, Estimate, Job, Results, Robustness,
  RunSpec, ToleranceSpec, Validation,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail || res.statusText;
  } catch {
    return res.statusText;
  }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Retries dropped requests only: fetch rejects those with a TypeError.
    A 4xx/5xx or a bad body is an answer, not a dropped request. */
export async function retrying<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof TypeError) || i >= attempts) throw err;
      await sleep(800);
    }
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  return res.json();
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  return res.json();
}

async function postBlob(url: string, body: unknown): Promise<Blob> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await detail(res));
  return res.blob();
}

export const api = {
  about: () => getJson<About>("/api/about"),
  defaults: () => getJson<Defaults>("/api/defaults"),
  uploadMotor: (name: string, content: string) =>
    postJson<Defaults>("/api/motor/upload", { name, content }),
  setHardware: (inhibited_ends: string) =>
    postJson<Defaults>("/api/hardware", { inhibited_ends }),
  resetHardware: () => postJson<Defaults>("/api/hardware/reset"),
  validate: (spec: RunSpec) => postJson<Validation>("/api/validate", { spec }),
  tighten: (spec: RunSpec) =>
    postJson<{ spec: RunSpec; changes?: { variable: string; to: number }[] }>(
      "/api/tighten", { spec }),
  diagnostic: (spec: RunSpec) =>
    postJson<{ diagnostic: Diagnostic; estimate: Estimate }>("/api/diagnostic", { spec }),
  run: (spec: RunSpec) => postJson<Job>("/api/run", { spec }),
  live: (id: string) => getJson<Job>(`/api/jobs/${id}/live`),
  cancel: (id: string) => postJson<{ ok: boolean }>(`/api/jobs/${id}/cancel`),
  results: (id: string) => getJson<Results>(`/api/jobs/${id}/results`),
  startBundle: (id: string, kind: string) =>
    postJson<Job>(`/api/jobs/${id}/bundle?kind=${kind}`),
  bundle: (id: string) => fetch(`/api/jobs/${id}/bundle`),
  bestRic: (id: string) => fetch(`/api/jobs/${id}/best.ric`),
  export: (spec: RunSpec, design: Design, name: string) =>
    postBlob("/api/export", { spec, x: design.x, n_grains: design.n_grains || null, name }),
  curves: (spec: RunSpec, design: Design) =>
    postJson<Design>("/api/curves", { spec, x: design.x, n_grains: design.n_grains || null }),
  robustness: (spec: RunSpec, design: Design, tolerances: ToleranceSpec[], samples = 400) =>
    postJson<Robustness>("/api/robustness", {
      spec, x: design.x, n_grains: design.n_grains || null, tolerances, samples,
    }),
};

/** Server-sent stream of a job, falling back to polling if the browser
    cannot hold the connection. `onJob` gets every frame; the promise resolves
    on the terminal one. */
export function watchJob(id: string, onJob: (job: Job) => void,
                         signal: AbortSignal): Promise<Job> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (job: Job) => {
      if (done) return;
      done = true;
      resolve(job);
    };
    const terminal = (job: Job) =>
      job.status === "done" || job.status === "failed" || job.status === "cancelled";

    const poll = async () => {
      while (!done && !signal.aborted) {
        try {
          const job = await api.live(id);
          onJob(job);
          if (terminal(job)) { finish(job); return; }
        } catch (err) {
          if (!done) { done = true; reject(err); return; }
        }
        await sleep(900);
      }
    };

    if (typeof EventSource === "undefined") { poll(); return; }
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = ev => {
      const job = JSON.parse(ev.data) as Job;
      onJob(job);
      if (terminal(job)) { source.close(); finish(job); }
    };
    source.onerror = () => {
      source.close();
      // A stream that never opened falls back to polling; one that dropped
      // mid-run does the same, so a flaky proxy cannot strand the screen.
      if (!done) poll();
    };
    signal.addEventListener("abort", () => { source.close(); done = true; });
  });
}
