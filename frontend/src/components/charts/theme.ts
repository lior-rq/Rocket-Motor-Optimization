/* One look for every Plotly chart, read from the page's own tokens so a
   theme switch redraws them in step. */

import type { Layout, Shape } from "plotly.js";

export const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const SERIES = () => [css("--series-1"), css("--series-2"), css("--series-3")];
export const LIMIT = () => css("--limit");
export const RAMP = ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
export const RAMP_DARK = ["#3b6ea8", "#3f80c4", "#4b93de", "#62a8f0", "#84bdf8", "#a9d3ff"];

export const ramp = () =>
  document.documentElement.dataset.theme === "light" ? RAMP : RAMP_DARK;

export function baseLayout(): Partial<Layout> {
  const axis = {
    gridcolor: css("--line-2"), zerolinecolor: css("--line"),
    linecolor: css("--line"), automargin: true,
    tickfont: { size: 10.5, color: css("--ink-3") },
  };
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    // Solid, so nothing behind the page can read as a gridline.
    plot_bgcolor: css("--plot-bg"),
    font: { family: css("--sans") || "system-ui, sans-serif", size: 11, color: css("--ink-2") },
    margin: { l: 58, r: 16, t: 10, b: 46 },
    xaxis: { ...axis },
    yaxis: { ...axis },
    legend: { orientation: "h", y: -0.30, yanchor: "top", xanchor: "center", x: 0.5,
              font: { size: 10.5 } },
    hoverlabel: { bgcolor: css("--bg-2"), bordercolor: css("--line"),
                  font: { size: 11, color: css("--ink") } },
    showlegend: false,
  };
}

export const axis = (title?: string, extra: Record<string, unknown> = {}) =>
  ({ ...(baseLayout().xaxis as object), title: title ? { text: title } : undefined, ...extra });

/** A legend below the plot lands on the x-axis title unless the bottom
    margin grows to hold both. */
export function makeRoom(layout: Partial<Layout>): Partial<Layout> {
  if (!layout.showlegend) return layout;
  const legend = layout.legend ?? {};
  if (legend.orientation !== "h" || (legend.y ?? 0) >= 0) return layout;
  return { ...layout, margin: { ...(layout.margin ?? {}), b: Math.max(layout.margin?.b ?? 0, 78) } };
}

export function hline(y: number, yref: string): Partial<Shape> {
  return { type: "line", xref: "paper", x0: 0, x1: 1, yref: yref as "y", y0: y, y1: y,
           line: { color: LIMIT(), width: 1, dash: "dot" } };
}

export const CONFIG = { displayModeBar: false, responsive: true } as const;
