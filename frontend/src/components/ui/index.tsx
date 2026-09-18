/* Small, motion-aware primitives. Everything else is built from these. */

import { motion, useMotionValue, useSpring, useTransform, type Variants } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { reducedMotion } from "@/lib/format";

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------ motion */

export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const rise: Variants = {
  hidden: { opacity: 0, y: 14, filter: "blur(6px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)",
          transition: { type: "spring", stiffness: 260, damping: 26 } },
};

export const spring = { type: "spring", stiffness: 300, damping: 30 } as const;

/* -------------------------------------------------------------- card */

interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  busy?: boolean;
  id?: string;
  glow?: "accent" | "warn" | "good" | null;
}

export function Card({ title, sub, actions, children, className, busy, id, glow }: CardProps) {
  return (
    <motion.section
      id={id}
      variants={rise}
      layout="position"
      className={cx("glass relative p-5 flex flex-col gap-3 min-w-0",
                    glow === "accent" && "ring-1 ring-accent/40",
                    glow === "warn" && "ring-1 ring-warn/40",
                    glow === "good" && "ring-1 ring-good/40",
                    className)}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {sub && <p className="text-ink-2 text-[12.5px] mt-0.5">{sub}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={cx("flex flex-col gap-3 min-w-0", busy && "busy")}>{children}</div>
    </motion.section>
  );
}

/* ------------------------------------------------------------ button */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "chip" | "link";
  on?: boolean;
}

export function Button({ variant = "chip", on, className, children, ...rest }: ButtonProps) {
  const base = variant === "primary"
    ? "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-[13.5px] font-semibold text-[color:var(--bg)] bg-accent shadow-[0_0_24px_var(--accent-glow)] disabled:opacity-40 disabled:shadow-none transition-shadow"
    : variant === "ghost"
      ? "inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium text-ink-2 border border-line hover:text-ink hover:border-ink-3 disabled:opacity-40 transition-colors"
      : variant === "link" ? "link" : cx("chip", on && "on");
  return (
    <motion.button
      whileTap={rest.disabled ? undefined : { scale: 0.96 }}
      whileHover={rest.disabled || variant === "link" ? undefined : { y: -1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={cx(base, className)}
      type="button"
      {...(rest as object)}
    >
      {children}
    </motion.button>
  );
}

/* ------------------------------------------------------------- field */

export function Field({ label, hint, readout, children, className }:
  { label?: ReactNode; hint?: ReactNode; readout?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5 min-w-0", className)}>
      {label && <span className="text-[12px] text-ink-2 font-medium">{label}</span>}
      {children}
      {readout !== undefined && readout !== null && (
        <span className="num text-[13px] text-ink">{readout}</span>)}
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** A text box that commits on blur or Enter, and optionally reports every
    keystroke. Keeps its own text so the caret survives a parent re-render. */
export function TextField({ value, onCommit, onLive, placeholder, disabled, className,
                            inputMode, align = "left", title }:
  { value: string; onCommit: (text: string) => void; onLive?: (text: string) => void;
    placeholder?: string; disabled?: boolean; className?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
    align?: "left" | "right"; title?: string }) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(value); }, [value]);
  return (
    <input
      type="text"
      className={cx("input", align === "right" && "text-right", className)}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      inputMode={inputMode}
      title={title}
      onFocus={() => { editing.current = true; }}
      onChange={e => { setText(e.target.value); onLive?.(e.target.value); }}
      // Live fields already hold the parent's value, so a blur can snap the
      // text back to its formatted form; commit-only fields wait for the prop.
      onBlur={() => { editing.current = false; onCommit(text); if (onLive) setText(value); }}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function Check({ checked, onChange, disabled, children, title, className }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
    children?: ReactNode; title?: string; className?: string }) {
  return (
    <label className={cx("inline-flex items-start gap-2.5 cursor-pointer select-none", className)} title={title}>
      <input type="checkbox" className="check-box mt-0.5" checked={checked} disabled={disabled}
             onChange={e => onChange(e.target.checked)} />
      {children && <span className="text-[13px] leading-snug">{children}</span>}
    </label>
  );
}

/* --------------------------------------------------------- segmented */

export function Segmented<T extends string>({ value, options, onChange, className }:
  { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx("relative inline-flex p-1 rounded-xl bg-surface-2 border border-line", className)}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cx("relative z-10 px-3 py-1 text-[12.5px] font-medium rounded-lg transition-colors",
                        o.value === value ? "text-ink" : "text-ink-3 hover:text-ink-2")}>
          {o.value === value && (
            <motion.span layoutId="segmented-pill" transition={spring}
              className="absolute inset-0 -z-10 rounded-lg bg-surface-3 border border-line" />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- numbers */

/** Springs from whatever it last showed to the new value. */
export function AnimatedNumber({ value, format, className }:
  { value: number; format: (v: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const sprung = useSpring(mv, { stiffness: 120, damping: 22, mass: 0.6 });
  const text = useTransform(sprung, v => format(v));
  const first = useRef(true);
  useEffect(() => {
    if (first.current || reducedMotion() || !Number.isFinite(value)) {
      first.current = false;
      mv.jump(value);
      return;
    }
    mv.set(value);
  }, [value, mv]);
  return <motion.span className={cx("num", className)}>{text}</motion.span>;
}

/** A bar whose width springs to the fraction. */
export function Bar({ fraction, tone, className, height = 7 }:
  { fraction: number; tone?: "accent" | "warn" | "bad" | "good"; className?: string; height?: number }) {
  const pct = Math.max(0, Math.min(fraction, 1)) * 100;
  return (
    <div className={cx("track", className)} style={{ height }}>
      <motion.div
        className={cx("fill", tone === "bad" && "over", tone === "warn" && "close",
                      tone === "good" && "none")}
        initial={false}
        animate={{ width: pct + "%" }}
        transition={{ type: "spring", stiffness: 120, damping: 24 }}
      />
    </div>
  );
}

export function Pill({ tone = "muted", children, className }:
  { tone?: "muted" | "accent" | "warn" | "good" | "bad"; children: ReactNode; className?: string }) {
  const tones = {
    muted: "bg-surface-3 text-ink-2",
    accent: "bg-accent-2 text-accent",
    warn: "bg-warn-2 text-warn",
    good: "bg-good-2 text-good",
    bad: "bg-bad-2 text-bad",
  };
  return (
    <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
                        tones[tone], className)}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-ink-3 text-[12.5px]">{children}</p>;
}

/** A live dot: breathes while something is happening. */
export function LiveDot({ tone = "accent" }: { tone?: "accent" | "good" | "warn" }) {
  const color = tone === "good" ? "var(--good)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  return (
    <span className="relative inline-flex w-2.5 h-2.5">
      <motion.span className="absolute inset-0 rounded-full" style={{ background: color }}
        animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }} />
      <span className="relative rounded-full w-2.5 h-2.5" style={{ background: color }} />
    </span>
  );
}
