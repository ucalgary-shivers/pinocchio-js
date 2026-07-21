import type { ResidualFunction } from "./types";

export function computeNumericalJacobian(
  residualFn: ResidualFunction,
  q: Float64Array,
  activeIndices: number[],
  h: number,
): Float64Array {
  const residualDim = residualFn(q).length;
  const numActive = activeIndices.length;
  const J = new Float64Array(residualDim * numActive);
  const qWork = new Float64Array(q);

  for (let j = 0; j < numActive; j++) {
    const idx = activeIndices[j];

    qWork.set(q);
    qWork[idx] += h;
    const rPlus = residualFn(qWork);

    qWork.set(q);
    qWork[idx] -= h;
    const rMinus = residualFn(qWork);

    for (let i = 0; i < residualDim; i++) {
      J[j * residualDim + i] = (rPlus[i] - rMinus[i]) / (2 * h);
    }
  }

  return J;
}
