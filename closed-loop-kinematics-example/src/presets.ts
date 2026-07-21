import type { MechanismParams, Vec2 } from "./pinocchio-adapter";
import { DEFAULT_PARAMS } from "./pinocchio-adapter";

export interface Preset {
  name: string;
  description: string;
  params: MechanismParams;
  q: Float64Array;
  mode: "fk" | "project" | "target-ik";
  solverAdjustable: boolean[];
  target?: Vec2;
}

const DEFAULT_Q = new Float64Array([
  0,
  Math.PI,
  2 * Math.PI / 3,
  -2 * Math.PI / 3,
]);

export const PRESETS: Preset[] = [
  {
    name: "Assembly Mode A",
    description: "Rhombus — endpoints meet at (0, 0.866)",
    params: { ...DEFAULT_PARAMS },
    q: new Float64Array(DEFAULT_Q),
    mode: "fk",
    solverAdjustable: [true, true, true, true],
  },
  {
    name: "Assembly Mode B",
    description: "Alternate closed configuration — same geometry, different joint angles",
    params: { ...DEFAULT_PARAMS },
    q: new Float64Array([Math.PI / 2, Math.PI / 2, -Math.PI / 6, Math.PI / 6]),
    mode: "fk",
    solverAdjustable: [true, true, true, true],
  },
  {
    name: "Near-Singular",
    description: "All arms near full extension — Jacobian is poorly conditioned",
    params: { ...DEFAULT_PARAMS },
    q: new Float64Array([0.05, 0.05, 0.05, 0.05]),
    mode: "project",
    solverAdjustable: [true, true, true, true],
  },
  {
    name: "Unreachable Target",
    description: "Target far outside the workspace — solver will not converge",
    params: { ...DEFAULT_PARAMS },
    q: new Float64Array(DEFAULT_Q),
    mode: "target-ik",
    solverAdjustable: [true, true, true, true],
    target: { x: 10, y: 10 },
  },
];

export function applyPreset(
  preset: Preset,
  q: Float64Array,
): {
  q: Float64Array;
  params: MechanismParams;
  mode: "fk" | "project" | "target-ik";
  solverAdjustable: boolean[];
  target: Vec2 | undefined;
} {
  q.set(preset.q);
  return {
    q,
    params: { ...preset.params },
    mode: preset.mode,
    solverAdjustable: [...preset.solverAdjustable],
    target: preset.target ? { ...preset.target } : undefined,
  };
}
