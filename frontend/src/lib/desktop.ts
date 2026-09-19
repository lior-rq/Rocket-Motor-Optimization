/* The pywebview bridge. Present only in the desktop build; every call here
   degrades to what a browser tab can do. */

interface DesktopApi {
  save_file(filename: string, data_b64: string):
    Promise<{ saved?: string; cancelled?: boolean; error?: string }>;
  open_report(job_id: string): Promise<{ opened?: string; error?: string }>;
  show_files(): Promise<{ opened?: string; error?: string }>;
}

declare global {
  interface Window { pywebview?: { api?: DesktopApi } }
}

export const isDesktopShell = () => typeof window !== "undefined" && !!window.pywebview;

/** Runs once the bridge exists. On Windows pywebview injects it only after
    the page's own scripts have run, so a check at boot alone misses it. */
export function onDesktopReady(fn: () => void): void {
  if (isDesktopShell()) { fn(); return; }
  window.addEventListener("pywebviewready", fn, { once: true });
}

const bridge = () => window.pywebview?.api;

// JS objects crossing the bridge are JSON, and a Blob is not one.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export type SaveResult = { ok: true; path?: string } | { ok: false; cancelled?: boolean; error?: string };

/** A native Save dialog in the desktop build, a browser download otherwise. */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveResult> {
  const desktop = bridge();
  if (desktop?.save_file) {
    const result = await desktop.save_file(filename, await blobToBase64(blob));
    if (result.error) return { ok: false, error: result.error };
    if (result.cancelled) return { ok: false, cancelled: true };
    return { ok: true, path: result.saved };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { ok: true };
}

export async function openReport(jobId: string): Promise<string | null> {
  const desktop = bridge();
  if (desktop?.open_report) {
    const result = await desktop.open_report(jobId);
    return result.error ?? null;
  }
  window.open(`/api/jobs/${jobId}/report`, "_blank");
  return null;
}

export function showFiles(): void {
  bridge()?.show_files();
}
