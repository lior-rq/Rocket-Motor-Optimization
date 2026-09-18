import Plotly from "plotly.js-dist-min";
import type { Config, Data, Layout, PlotMouseEvent } from "plotly.js";
import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { cx } from "@/components/ui";
import { makeRoom } from "./theme";

interface PlotProps {
  data: Data[];
  layout: Partial<Layout>;
  config?: Partial<Config>;
  className?: string;
  onClick?: (ev: PlotMouseEvent) => void;
  onHover?: (ev: PlotMouseEvent) => void;
  onUnhover?: () => void;
  /** Draw with newPlot once per key, then react; the live plot uses this so a
      pan in progress is never interrupted by an arriving generation. */
  freshKey?: string | number;
}

/** A Plotly chart bound to one div. Redraws whenever its props change and
    whenever the theme flips. */
export function Plot({ data, layout, config, className, onClick, onHover, onUnhover, freshKey }: PlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useApp(s => s.theme);
  const drawn = useRef<string | number | undefined>(undefined);
  const handlers = useRef({ onClick, onHover, onUnhover });
  handlers.current = { onClick, onHover, onUnhover };

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const full = makeRoom(layout);
    const conf = { displayModeBar: false, responsive: true, ...(config ?? {}) };
    if (freshKey !== undefined && drawn.current !== freshKey) {
      drawn.current = freshKey;
      Plotly.newPlot(node, data, full, conf);
    } else {
      Plotly.react(node, data, full, conf);
    }
  }, [data, layout, config, theme, freshKey]);

  useEffect(() => {
    const node = ref.current as (HTMLDivElement & {
      on: (ev: string, fn: (e: PlotMouseEvent) => void) => void;
      removeAllListeners?: (ev: string) => void;
    }) | null;
    if (!node) return;
    const click = (e: PlotMouseEvent) => handlers.current.onClick?.(e);
    const hover = (e: PlotMouseEvent) => handlers.current.onHover?.(e);
    const unhover = () => handlers.current.onUnhover?.();
    // Listeners exist only after the first draw, which the effect above did.
    node.on("plotly_click", click);
    node.on("plotly_hover", hover);
    node.on("plotly_unhover", unhover);
    const observer = new ResizeObserver(() => {
      try { Plotly.Plots.resize(node); } catch { /* not drawn yet */ }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      node.removeAllListeners?.("plotly_click");
      node.removeAllListeners?.("plotly_hover");
      node.removeAllListeners?.("plotly_unhover");
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    return () => { if (node) Plotly.purge(node); };
  }, []);

  return <div ref={ref} className={cx("plot", className)} />;
}

export { Plotly };
