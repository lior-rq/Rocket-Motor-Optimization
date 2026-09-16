import { motion } from "motion/react";
import type { ReactNode } from "react";

export function StepHead({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-4 mb-5 flex-wrap">
      <div>
        <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                   transition={{ delay: 0.05 }} className="text-[26px] font-semibold tracking-tight">
          {title}
        </motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.12 }}
                  className="text-ink-2 text-[13.5px]">{sub}</motion.p>
      </div>
      {children}
    </header>
  );
}
