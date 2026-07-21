export interface JointBounds {
  min: number;
  max: number;
}

export interface SolverConfig {
  tolerance: number;
  maxIterations: number;
  damping: number;
  stepLimit: number;
  fdStep: number;
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  tolerance: 1e-8,
  maxIterations: 50,
  damping: 1e-6,
  stepLimit: 0.25,
  fdStep: 1e-6,
};

export interface SolverResult {
  converged: boolean;
  q: Float64Array;
  iterations: number;
  finalResidual: number;
  reason: string;
  solveTimeMs: number;
}

export type JacobianSource = "finite-difference" | "analytic";

export type ResidualFunction = (q: Float64Array) => Float64Array;
export type JacobianFunction = (q: Float64Array, activeIndices: number[]) => Float64Array;
