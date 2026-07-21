import type {
  ResidualFunction,
  JacobianFunction,
  SolverConfig,
  SolverResult,
  JointBounds,
} from "./types";

function solveLinearSystem(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const aug = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      aug[i * (n + 1) + j] = A[i * n + j];
    }
    aug[i * (n + 1) + n] = b[i];
  }

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(aug[col * (n + 1) + col]);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(aug[row * (n + 1) + col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    if (maxVal < 1e-30) {
      return new Float64Array(n);
    }

    if (maxRow !== col) {
      for (let j = col; j <= n; j++) {
        const tmp = aug[col * (n + 1) + j];
        aug[col * (n + 1) + j] = aug[maxRow * (n + 1) + j];
        aug[maxRow * (n + 1) + j] = tmp;
      }
    }

    const pivot = aug[col * (n + 1) + col];
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row * (n + 1) + col] / pivot;
      for (let j = col; j <= n; j++) {
        aug[row * (n + 1) + j] -= factor * aug[col * (n + 1) + j];
      }
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i * (n + 1) + j] * x[j];
    }
    const pivot = aug[i * (n + 1) + i];
    x[i] = pivot !== 0 ? sum / pivot : 0;
  }

  return x;
}

export function solveClosureDLS(
  residualFn: ResidualFunction,
  jacobianFn: JacobianFunction,
  qInitial: Float64Array,
  activeIndices: number[],
  jointBounds: JointBounds[],
  config: SolverConfig,
): SolverResult {
  const t0 = performance.now();
  const nq = qInitial.length;
  const numActive = activeIndices.length;
  const q = new Float64Array(qInitial);

  if (numActive === 0) {
    return {
      converged: false,
      q,
      iterations: 0,
      finalResidual: 0,
      reason: "No active joints to adjust",
      solveTimeMs: performance.now() - t0,
    };
  }

  let m = 0;

  for (let iter = 0; iter < config.maxIterations; iter++) {
    const phi = residualFn(q);
    if (m === 0) m = phi.length;

    let residualNorm = 0;
    for (let i = 0; i < m; i++) {
      residualNorm += phi[i] * phi[i];
    }
    residualNorm = Math.sqrt(residualNorm);

    if (residualNorm <= config.tolerance) {
      return {
        converged: true,
        q,
        iterations: iter + 1,
        finalResidual: residualNorm,
        reason: "Converged",
        solveTimeMs: performance.now() - t0,
      };
    }

    const J = jacobianFn(q, activeIndices);

    const A = new Float64Array(m * m);
    let jacobianContribution = false;
    for (let p = 0; p < m; p++) {
      for (let qq = 0; qq < m; qq++) {
        let sum = 0;
        for (let j = 0; j < numActive; j++) {
          sum += J[j * m + p] * J[j * m + qq];
        }
        A[p * m + qq] = sum;
        if (Math.abs(sum) > 1e-30) jacobianContribution = true;
      }
      A[p * m + p] += config.damping;
    }

    if (!jacobianContribution) {
      return {
        converged: false,
        q,
        iterations: iter + 1,
        finalResidual: residualNorm,
        reason: "Singular: zero Jacobian for all active joints",
        solveTimeMs: performance.now() - t0,
      };
    }

    const y = solveLinearSystem(A, phi, m);

    let singular = true;
    for (let i = 0; i < m; i++) {
      if (Math.abs(y[i]) > 1e-30) { singular = false; break; }
    }

    if (singular) {
      return {
        converged: false,
        q,
        iterations: iter + 1,
        finalResidual: residualNorm,
        reason: "Near-singular configuration",
        solveTimeMs: performance.now() - t0,
      };
    }

    for (let j = 0; j < numActive; j++) {
      let dq = 0;
      for (let i = 0; i < m; i++) {
        dq -= J[j * m + i] * y[i];
      }

      if (dq > config.stepLimit) dq = config.stepLimit;
      if (dq < -config.stepLimit) dq = -config.stepLimit;

      const idx = activeIndices[j];
      q[idx] += dq;

      if (jointBounds && jointBounds[idx]) {
        const bounds = jointBounds[idx];
        if (q[idx] < bounds.min) q[idx] = bounds.min;
        if (q[idx] > bounds.max) q[idx] = bounds.max;
      }
    }

    for (let i = 0; i < nq; i++) {
      q[i] = Math.atan2(Math.sin(q[i]), Math.cos(q[i]));
    }

    for (let i = 0; i < nq; i++) {
      if (Number.isNaN(q[i]) || !Number.isFinite(q[i])) {
        return {
          converged: false,
          q,
          iterations: iter + 1,
          finalResidual: residualNorm,
          reason: "NaN or infinite coordinate detected",
          solveTimeMs: performance.now() - t0,
        };
      }
    }
  }

  const finalPhi = residualFn(q);
  let finalResidual = 0;
  for (let i = 0; i < finalPhi.length; i++) {
    finalResidual += finalPhi[i] * finalPhi[i];
  }
  finalResidual = Math.sqrt(finalResidual);

  return {
    converged: false,
    q,
    iterations: config.maxIterations,
    finalResidual,
    reason: `Max iterations (${config.maxIterations}) reached without convergence`,
    solveTimeMs: performance.now() - t0,
  };
}
