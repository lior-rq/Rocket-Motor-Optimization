/* The motor as a cutaway: grains, cores, case and nozzle, built from the
   same numbers the simulator uses, revolved through half a turn so the
   section faces the camera. Dimensions tween when the design changes. */

import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { reducedMotion } from "@/lib/format";
import { useApp } from "@/store/app";
import { useUnits } from "@/store/select";
import { cx } from "@/components/ui";

export interface MotorGeometry {
  grain_diameter: number;
  grain_lengths: number[];
  cores: number[];
  throat: number;
  exit: number;
  throat_length?: number;
}

const SEGMENTS = 72;

interface Solid { shell: THREE.BufferGeometry; caps: THREE.BufferGeometry }

/** Half-revolved solid from a closed (radius, axial) profile, plus the two
    flat faces where the cut is, so the section reads as solid material.
    The faces are a separate geometry so they can take their own material. */
function halfSolid(profile: [number, number][]): Solid {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const shell = new THREE.LatheGeometry(pts, SEGMENTS, 0, Math.PI);
  const face = new THREE.ShapeGeometry(new THREE.Shape(pts));
  // Lathe vertex = (r sin phi, y, r cos phi): the cut lies on x = 0, so the
  // caps are the profile drawn in the (z, y) plane, one facing each way.
  const a = face.clone().rotateY(Math.PI / 2);
  const b = face.clone().rotateY(-Math.PI / 2);
  const caps = mergeFlat([a, b]);
  face.dispose(); a.dispose(); b.dispose();
  return { shell, caps };
}

function mergeFlat(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const g of list) {
    const ng = g.toNonIndexed();
    positions.push(...Array.from(ng.attributes.position.array as Float32Array));
    ng.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.computeVertexNormals();
  return out;
}

const dispose = (s: Solid) => { s.shell.dispose(); s.caps.dispose(); };

function Part({ solid, color, capColor, ...mat }:
  { solid: Solid; color: string; capColor?: string; roughness?: number; metalness?: number;
    transparent?: boolean; opacity?: number; depthWrite?: boolean;
    emissive?: string; emissiveIntensity?: number }) {
  return (
    <group>
      <mesh geometry={solid.shell}>
        <meshStandardMaterial color={color} side={THREE.DoubleSide} {...mat} />
      </mesh>
      <mesh geometry={solid.caps}>
        <meshStandardMaterial color={capColor ?? color} side={THREE.DoubleSide} {...mat}
          emissive={mat.emissive} emissiveIntensity={(mat.emissiveIntensity ?? 0) * 0.5} />
      </mesh>
    </group>
  );
}

/** Eases a vector of numbers toward its target. A change in length jumps. */
function useTweened(target: number[], ms = 650): number[] {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const start = useRef(0);
  const goal = useRef(target);
  useEffect(() => {
    if (goal.current.length !== target.length || reducedMotion()) {
      from.current = target; goal.current = target; setValue(target); return;
    }
    if (goal.current.every((v, i) => v === target[i])) return;
    from.current = value;
    goal.current = target;
    start.current = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start.current) / ms, 1);
      const e = 1 - Math.pow(1 - t, 3);
      setValue(from.current.map((v, i) => v + (goal.current[i] - v) * e));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.join(",")]);
  return value;
}

function Geometry({ m }: { m: MotorGeometry }) {
  const n = m.cores.length;
  const lengths = m.grain_lengths.length === n ? m.grain_lengths
    : Array(n).fill(m.grain_lengths[0] ?? 0.15);
  const flat = useTweened([m.grain_diameter, m.throat, m.exit, m.throat_length ?? 0,
                           ...m.cores, ...lengths]);
  const [bore, throat, exit, throatLen] = flat;
  const cores = flat.slice(4, 4 + n);
  const lens = flat.slice(4 + n, 4 + 2 * n);

  const stack = lens.reduce((a, b) => a + b, 0);
  const conv = throat * 1.6, div = throat * 2.6;
  const nozzle = conv + throatLen + div;
  const total = stack + nozzle;
  const s = 6 / Math.max(total, 1e-6);          // scene units
  const R = bore / 2 * s;
  const fwd = 0.35;                             // forward closure thickness

  const grains = useMemo(() => {
    let y = 0;
    return cores.map((core, i) => {
      const r = Math.min(core / 2 * s, R * 0.98), L = lens[i] * s;
      const g = halfSolid([[r, y], [R, y], [R, y + L], [r, y + L], [r, y]]);
      y += L;
      return g;
    });
  }, [cores.join(","), lens.join(","), R, s]);   // eslint-disable-line react-hooks/exhaustive-deps

  const nozzleGeo = useMemo(() => {
    const y0 = stack * s;
    const rt = throat / 2 * s, re = exit / 2 * s, Rc = R;
    const c = conv * s, t = throatLen * s, d = div * s;
    return halfSolid([[R, y0], [rt, y0 + c], [rt, y0 + c + t], [re, y0 + c + t + d],
                      [Rc, y0 + c + t + d], [Rc, y0], [R, y0]]);
  }, [stack, throat, exit, throatLen, R, s, conv, div]);

  const closureGeo = useMemo(() =>
    halfSolid([[0, -fwd], [R, -fwd], [R, 0], [0, 0], [0, -fwd]]), [R]);

  useEffect(() => () => {
    grains.forEach(dispose);
    dispose(nozzleGeo); dispose(closureGeo);
  }, [grains, nozzleGeo, closureGeo]);

  const light = useApp(s => s.theme) === "light";
  const accent = light ? "#1a6fd6" : "#2f8fe8";
  const cut = light ? "#5ea0f0" : "#8fd0ff";
  const exitX = (stack + nozzle) * s;

  // Lathe axis is Y; the motor lies along X with the section facing +Y,
  // so the camera above and ahead sees straight into the cores.
  return (
    <group position={[-total * s / 2 + fwd / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
      <group rotation={[0, 0, 0]}>
        {/* No case sleeve: the grain wall is the exterior, so the motor reads as
            one solid blue body from every angle. */}
        {grains.map((g, i) => (
          <Part key={i} solid={g} color={accent} capColor={cut} roughness={0.6} metalness={0.05}
                emissive={accent} emissiveIntensity={0.28} />
        ))}
        <Part solid={closureGeo} color="#7d8899" capColor="#b6c0cc" roughness={0.45} metalness={0.2} />
        <Part solid={nozzleGeo} color="#454b55" capColor="#7a838f" roughness={0.65} metalness={0.15} />
        <pointLight position={[0, exitX + 0.5, 0]} color="#ff8a45" intensity={5} distance={4} decay={2} />
        {/* The ember sits in the exit plane and is cut like everything else:
            a half disc on the surviving side, never proud of the section. */}
        <mesh position={[0, exitX + 0.01, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[exit / 2 * s * 0.96, 48, -Math.PI / 2, Math.PI]} />
          <meshBasicMaterial color="#ff9a5c" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
}

function Rig() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0.8, 4.8, 4.2);
    camera.lookAt(0, 0, 0);
  }, [camera]);
  return null;
}

export function Motor3D({ motor, className, height = 260, spin = true }:
  { motor: MotorGeometry | null | undefined; className?: string; height?: number; spin?: boolean }) {
  const units = useUnits();
  const [interacting, setInteracting] = useState(false);
  if (!motor || !motor.cores?.length) return <p className="text-ink-3 text-[12.5px]">No geometry.</p>;
  const expansion = (motor.exit / motor.throat) ** 2;
  return (
    <div className={cx("relative rounded-xl overflow-hidden", className)} style={{ height }}>
      <div className="absolute inset-0"
           style={{ background: "radial-gradient(60% 70% at 50% 60%, var(--accent-2), transparent 70%)" }} />
      <Canvas dpr={[1, 2]} camera={{ fov: 32, near: 0.1, far: 100 }} gl={{ antialias: true, alpha: true }}
              style={{ position: "absolute", inset: 0 }}>
        <Rig />
        <ambientLight intensity={0.35} />
        <hemisphereLight args={["#dbe9ff", "#1c2a44", 0.8]} />
        <directionalLight position={[4, 8, 6]} intensity={1.6} />
        <directionalLight position={[-6, -2, -4]} intensity={0.5} color="#8ec5ff" />
        <spotLight position={[0, 6, -6]} intensity={1.2} angle={0.5} penumbra={1} color="#ffffff" />
        <Geometry m={motor} />
        <OrbitControls enablePan={false} minDistance={4} maxDistance={14}
                       autoRotate={spin && !interacting} autoRotateSpeed={0.6}
                       onStart={() => setInteracting(true)} makeDefault />
      </Canvas>
      <div className="absolute left-3 bottom-2 right-3 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-3 num pointer-events-none">
        <span>throat {units.fmtLen(motor.throat)}</span>
        <span>exit {units.fmtLen(motor.exit)}</span>
        <span>expansion {expansion.toFixed(2)}</span>
        <span className="ml-auto">cores {motor.cores.map(c => units.lenValue(c)).join(" · ")}{units.sys.length.label}</span>
      </div>
    </div>
  );
}
