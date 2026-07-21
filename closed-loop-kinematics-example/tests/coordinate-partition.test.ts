import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q } from "../src/pinocchio-adapter";
import { solveClosureDLS } from "../src/dls-solver";
import { computeNumericalJacobian } from "../src/numerical-jacobian";
import { DEFAULT_SOLVER_CONFIG } from "../src/types";
import type { ResidualFunction, SolverConfig, JointBounds } from "../src/types";

function makeResidualFn(adapter: Awaited<ReturnType<typeof createAdapter>>): ResidualFunction {
  return (q: Float64Array) => {
    const ep = adapter.fk(q);
    return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
  };
}

function makeJacobianFn(
  adapter: Awaited<ReturnType<typeof createAdapter>>,
  residualFn: ResidualFunction,
  fdStep: number,
) {
  return (q: Float64Array, active: number[]) => {
    return computeNumericalJacobian(residualFn, q, active, fdStep);
  };
}

const DEFAULT_BOUNDS: JointBounds[] = [
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
];

describe("Coordinate Partition — Issue 06", () => {
  describe("Only solver-adjustable coordinates are modified", () => {
    it("does not modify independent joints during projection", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const qStart = new Float64Array([0.5, 1.5, 0.5, 0.5]);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qStart,
        [2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 100 },
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      expect(result.q[0]).toBe(qStart[0]);
      expect(result.q[1]).toBe(qStart[1]);

      const qChanged0 = result.q[2] !== qStart[2];
      const qChanged1 = result.q[3] !== qStart[3];
      expect(qChanged0 || qChanged1).toBe(true);

      adapter.cleanup();
    });
  });

  describe("Changing partition changes which joints move", () => {
    it("moves J1,J2 when they are solver-adjustable and J3,J4 are independent", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const qStart = new Float64Array([0.5, 0.5, 0.5, 0.5]);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qStart,
        [0, 1],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 100 },
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      expect(result.q[2]).toBe(qStart[2]);
      expect(result.q[3]).toBe(qStart[3]);

      adapter.cleanup();
    });
  });

  describe("Zero adjustable joints returns structured non-converged result", () => {
    it("produces a non-converged result with a warning when no joints are adjustable", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const qStart = new Float64Array([0.5, 0.5, 0.5, 0.5]);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qStart,
        [],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
      );

      expect(result.converged).toBe(false);
      expect(result.reason).toBe("No active joints to adjust");
      expect(result.iterations).toBe(0);
      expect(result.q).toEqual(qStart);

      adapter.cleanup();
    });

    it("does not throw when zero adjustable joints are provided", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      expect(() => {
        solveClosureDLS(
          residualFn,
          jacobianFn,
          new Float64Array([0.5, 0.5, 0.5, 0.5]),
          [],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
        );
      }).not.toThrow();

      adapter.cleanup();
    });
  });
});
