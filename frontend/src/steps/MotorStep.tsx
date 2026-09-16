import { motion } from "motion/react";
import { useRef, useState } from "react";
import { BehaviourStack } from "@/components/charts/Behaviour";
import { Button, Card, Pill, stagger } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { Motor3D } from "@/three/Motor3D";
import { StepHead } from "./StepHead";

export function MotorStep() {
  const s = useApp();
  const units = useUnits();
  const m = s.motor;
  const hw = s.hardware;
  const [ends, setEnds] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!m) return null;

  const endsValue = ends ?? hw?.inhibited_ends ?? m.inhibited_ends ?? "Neither";
  const rows: [string, string][] = [
    ["Grains", m.grain_count + " × " + units.fmtLen(m.grain_lengths[0])],
    ["Grain OD (case bore)", units.fmtLen(m.grain_diameter)],
    ["Throat / exit", units.fmtLen(m.throat) + " / " + units.fmtLen(m.exit)],
    ["Throat length", units.fmtLen(m.throat_length)],
    ["Inhibited ends", m.inhibited_ends],
    ["Propellant", m.propellant],
    ["Initial thrust", fmtInt(m.initial_thrust) + " N"],
    ["Total impulse", fmtInt(m.total_impulse) + " N·s"],
    ["Peak pressure", units.fmtMetric("max_pressure", m.max_pressure)],
    ["Kn", m.initial_kn.toFixed(0) + " → " + m.peak_kn.toFixed(0)],
    ["Peak mass flux", units.fmtMetric("peak_mass_flux", m.peak_mass_flux)],
  ];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      <StepHead title="Motor" sub="Load the baseline motor to optimise">
        <div className="glass px-3 py-2 flex items-center gap-3 text-[13px]">
          <Pill tone="accent">Baseline</Pill>
          <span className="font-medium">{m.name}</span>
          <button type="button" className="link" onClick={() => fileInput.current?.click()}>Change</button>
          <input ref={fileInput} type="file" accept=".ric" hidden
                 onChange={e => { const f = e.target.files?.[0]; if (f) s.uploadMotor(f); e.target.value = ""; }} />
        </div>
      </StepHead>

      <Card className="!p-0 overflow-hidden" glow="accent">
        <div className="relative">
          <Motor3D motor={m} height={340} />
          <div className="absolute left-4 top-3 flex items-center gap-2">
            <Pill tone="accent">cutaway</Pill>
            <span className="text-[11.5px] text-ink-3">drag to orbit &middot; scroll to zoom</span>
          </div>
          <div className="absolute right-4 top-3 text-right">
            <div className="num text-[26px] font-semibold leading-none text-accent">{m.designation}</div>
            <div className="text-[11px] text-ink-3 mt-1">{m.propellant}</div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr] lg:items-start">
        <Card title="Baseline motor">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-2">{k}</dt>
                <dd className="num text-right m-0">{v}</dd>
              </div>
            ))}
          </dl>
          {(m.warnings ?? []).length > 0 && (
            <div className="flex flex-col gap-1.5">
              {m.warnings.map((w, i) => <div key={i} className="problem note">{w}</div>)}
            </div>
          )}
        </Card>

        <Card title="Fixed hardware" sub="Read from the .ric file. Only the ends can change here.">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center text-[13px]">
            <span className="text-ink-2">Grain outer diameter</span>
            <input className="input" disabled value={units.lenValue(hw?.grain_diameter ?? m.grain_diameter)} readOnly />
            <span className="text-ink-2">Grain length</span>
            <input className="input" disabled value={units.lenValue(hw?.grain_length ?? m.grain_lengths[0])} readOnly />
            <span className="text-ink-2">Inhibited ends</span>
            <select className="input" value={endsValue} onChange={e => setEnds(e.target.value)}>
              {["Neither", "Top", "Bottom", "Both"].map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={() => { s.applyHardware(endsValue); setEnds(null); }}>Apply hardware</Button>
            {hw?.overridden && (
              <>
                <Button onClick={() => { s.resetHardware(); setEnds(null); }}>Reset to file</Button>
                <Pill tone="warn">modified from file</Pill>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card title="How the baseline behaves" sub="Thrust, pressure, Kn and mass flux over the burn">
        <BehaviourStack curves={s.baselineCurves} keys={["thrust", "pressure", "kn", "mass_flux"]}
                        className="tall" />
      </Card>
    </motion.div>
  );
}
