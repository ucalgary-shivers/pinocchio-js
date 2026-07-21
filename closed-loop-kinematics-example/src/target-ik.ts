import type { Vec2 } from "./pinocchio-adapter";
import type { ResidualFunction, JacobianFunction } from "./types";

export interface TargetIKDiagnostics {
  converged: boolean;
  iterations: number;
  finalResidual: number;
  solveTimeMs: number;
  conditioningWarning: boolean;
  reason: string;
}

export const TARGET_RESIDUAL_DIM = 4;
const CONDITIONING_RATIO_THRESHOLD = 1e-4;

export function makeTargetResidual(
  fk: (q: Float64Array) => { c1: Vec2; c2: Vec2 },
  getTarget: () => { x: number; y: number },
): ResidualFunction {
  return (q: Float64Array) => {
    const ep = fk(q);
    const t = getTarget();
    return new Float64Array([
      ep.c1.x - t.x,
      ep.c1.y - t.y,
      ep.c2.x - t.x,
      ep.c2.y - t.y,
    ]);
  };
}

export function makeTargetJacobian(
  fk: (q: Float64Array) => { c1: Vec2; c2: Vec2 },
  h: number,
): JacobianFunction {
  return (q: Float64Array, activeIndices: number[]) => {
    const m = TARGET_RESIDUAL_DIM;
    const numActive = activeIndices.length;
    const J = new Float64Array(m * numActive);
    const qWork = new Float64Array(q);

    for (let j = 0; j < numActive; j++) {
      const idx = activeIndices[j];

      qWork.set(q);
      qWork[idx] += h;
      const fkPlus = fk(qWork);

      qWork.set(q);
      qWork[idx] -= h;
      const fkMinus = fk(qWork);

      const inv2h = 1 / (2 * h);
      J[j * m + 0] = (fkPlus.c1.x - fkMinus.c1.x) * inv2h;
      J[j * m + 1] = (fkPlus.c1.y - fkMinus.c1.y) * inv2h;
      J[j * m + 2] = (fkPlus.c2.x - fkMinus.c2.x) * inv2h;
      J[j * m + 3] = (fkPlus.c2.y - fkMinus.c2.y) * inv2h;
    }

    return J;
  };
}

export function estimateConditioning(
  fk: (q: Float64Array) => { c1: Vec2; c2: Vec2 },
  q: Float64Array,
  activeIndices: number[],
  h: number,
): number {
  const m = TARGET_RESIDUAL_DIM;
  const numActive = activeIndices.length;
  if (numActive === 0) return 0;

  const J = new Float64Array(m * numActive);
  const qWork = new Float64Array(q);

  for (let j = 0; j < numActive; j++) {
    const idx = activeIndices[j];
    qWork.set(q);
    qWork[idx] += h;
    const fkPlus = fk(qWork);
    qWork.set(q);
    qWork[idx] -= h;
    const fkMinus = fk(qWork);

    const inv2h = 1 / (2 * h);
    J[j * m + 0] = (fkPlus.c1.x - fkMinus.c1.x) * inv2h;
    J[j * m + 1] = (fkPlus.c1.y - fkMinus.c1.y) * inv2h;
    J[j * m + 2] = (fkPlus.c2.x - fkMinus.c2.x) * inv2h;
    J[j * m + 3] = (fkPlus.c2.y - fkMinus.c2.y) * inv2h;
  }

  let diagMax = 0;
  let diagMin = Infinity;
  for (let p = 0; p < m; p++) {
    let sum = 0;
    for (let j = 0; j < numActive; j++) {
      sum += J[j * m + p] * J[j * m + p];
    }
    diagMax = Math.max(diagMax, sum);
    diagMin = Math.min(diagMin, sum);
  }

  if (diagMax < 1e-30) return 0;
  return diagMin / diagMax;
}

export function hasConditioningWarning(
  ratio: number,
  threshold: number = CONDITIONING_RATIO_THRESHOLD,
): boolean {
  return ratio > 0 && ratio < threshold;
}
