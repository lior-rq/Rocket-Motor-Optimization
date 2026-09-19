import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { Footer, Progress, Stepper, Toasts, Topbar } from "./components/Shell";
import { useApp } from "./store/app";
import { MotorStep } from "./steps/MotorStep";
import { VariablesStep } from "./steps/VariablesStep";
import { ConstraintsStep } from "./steps/ConstraintsStep";
import { ObjectivesStep } from "./steps/ObjectivesStep";
import { SettingsStep } from "./steps/SettingsStep";
import { RunningStep } from "./steps/RunningStep";
import { ResultsStep } from "./steps/ResultsStep";

const STEPS = [MotorStep, VariablesStep, ConstraintsStep, ObjectivesStep,
               SettingsStep, RunningStep, ResultsStep];

export function App() {
  const boot = useApp(s => s.boot);
  const step = useApp(s => s.step);
  const booted = useApp(s => s.booted);
  const loaded = useApp(s => !!s.spec);
  const bootError = useApp(s => s.bootError);
  useEffect(() => { boot(); }, [boot]);
  const Step = STEPS[step];
  return (
    <div className="min-h-full flex flex-col">
      <div className="backdrop" />
      <Topbar />
      <Progress />
      <Stepper />
      <main className="flex-1 mx-4 my-4">
        {loaded && booted ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 28, filter: "blur(8px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, x: -28, filter: "blur(8px)" }}
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
            >
              <Step />
            </motion.div>
          </AnimatePresence>
        ) : bootError ? (
          <NoMotor message={bootError} />
        ) : (
          <Booting />
        )}
      </main>
      <Footer />
      <Toasts />
    </div>
  );
}

function Booting() {
  return (
    <div className="grid place-items-center py-32 text-ink-3 text-[13px]">
      <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
        Reading the motor&hellip;
      </motion.div>
    </div>
  );
}

function NoMotor({ message }: { message: string }) {
  return (
    <div className="glass max-w-xl mx-auto mt-16 p-8 text-center flex flex-col gap-2">
      <h2 className="text-lg">No motor loaded</h2>
      <p className="text-ink-2 text-[13.5px]">{message} Use <strong>Change</strong> in the
        header to pick a <code>.ric</code> file.</p>
    </div>
  );
}
