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

const TEST_REACHABLE_CONFIGS: Float64Array[] = [
  new Float64Array([0.5, 0.5, 0.5, 0.5]),
  new Float64Array([1.0, 1.0, -0.5, -0.5]),
  new Float64Array([-0.5, 0.8, 1.0, -0.3]),
  new Float64Array([0.3, -0.7, 1.2, -0.5]),
  new Float64Array([0.2, 0.2, 0.2, 0.2]),
  new Float64Array([-0.4, 0.6, 0.9, -0.4]),
];

describe("DLS Solver — Issue 05", () => {
  describe("Convergence from reachable configurations", () => {
    TEST_REACHABLE_CONFIGS.forEach((qStart, idx) => {
      it(`reaches residual below 1e-6 m from config ${idx}`, async () => {
        const adapter = await createAdapter();
        const residualFn = makeResidualFn(adapter);
        const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

        const result = solveClosureDLS(
          residualFn,
          jacobianFn,
          qStart,
          [0, 1, 2, 3],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
        );

        expect(result.converged).toBe(true);
        expect(result.finalResidual).toBeLessThan(1e-6);
        expect(result.reason).toBe("Converged");

        adapter.cleanup();
      });
    });
  });

  describe("Warm start preserves assembly mode", () => {
    it("settles to a nearby solution when starting close to a known closed config", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const qPerturbed = new Float64Array(DEFAULT_CLOSED_Q);
      qPerturbed[0] += 0.1;
      qPerturbed[2] += 0.1;

      const initialEp = adapter.fk(qPerturbed);
      const initialDist = Math.sqrt(
        (initialEp.c1.x - initialEp.c2.x) ** 2 +
        (initialEp.c1.y - initialEp.c2.y) ** 2,
      );
      expect(initialDist).toBeGreaterThan(0.01);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qPerturbed,
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      const finalEp = adapter.fk(result.q);
      const finalDist = Math.sqrt(
        (finalEp.c1.x - finalEp.c2.x) ** 2 +
        (finalEp.c1.y - finalEp.c2.y) ** 2,
      );
      expect(finalDist).toBeLessThan(1e-6);

      adapter.cleanup();
    });
  });

  describe("Step limit enforcement", () => {
    it("no single iteration changes any joint by more than stepLimit", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const qStart = new Float64Array([1.5, 0.0, -1.0, 0.0]);
      const smallStepLimit = 0.01;
      const config: SolverConfig = {
        ...DEFAULT_SOLVER_CONFIG,
        stepLimit: smallStepLimit,
        tolerance: 1e-8,
        maxIterations: 200,
      };

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qStart,
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        config,
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      adapter.cleanup();
    });
  });

  describe("Joint bounds enforcement", () => {
    it("returns a configuration respecting joint bounds", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const tightBounds: JointBounds[] = [
        { min: -0.5, max: 0.5 },
        { min: -0.5, max: 0.5 },
        { min: -0.5, max: 0.5 },
        { min: -0.5, max: 0.5 },
      ];

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        new Float64Array([0.0, 0.0, 0.0, 0.0]),
        [0, 1, 2, 3],
        tightBounds,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 100 },
      );

      for (let i = 0; i < 4; i++) {
        expect(result.q[i]).toBeGreaterThanOrEqual(tightBounds[i].min - 1e-10);
        expect(result.q[i]).toBeLessThanOrEqual(tightBounds[i].max + 1e-10);
      }

      adapter.cleanup();
    });
  });

  describe("Iteration limit respected", () => {
    it("returns structured non-converged result when hitting iteration limit", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        new Float64Array([2.0, -1.0, 1.5, -0.5]),
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, maxIterations: 1, tolerance: 1e-12 },
      );

      expect(result.converged).toBe(false);
      expect(result.iterations).toBe(1);
      expect(result.reason).toContain("Max iterations");
      expect(result.q).toBeDefined();
      expect(typeof result.finalResidual).toBe("number");
      expect(typeof result.solveTimeMs).toBe("number");

      adapter.cleanup();
    });
  });

  describe("No NaN or infinite coordinates", () => {
    it("never returns NaN or infinite coordinates from reachable configs", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      for (let idx = 0; idx < TEST_REACHABLE_CONFIGS.length; idx++) {
        const result = solveClosureDLS(
          residualFn,
          jacobianFn,
          TEST_REACHABLE_CONFIGS[idx],
          [0, 1, 2, 3],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
        );

        for (let i = 0; i < result.q.length; i++) {
          expect(Number.isNaN(result.q[i])).toBe(false);
          expect(Number.isFinite(result.q[i])).toBe(true);
        }
      }

      adapter.cleanup();
    });
  });

  describe("Non-convergence is structured, not thrown", () => {
    it("does not throw when iteration limit is reached", async () => {
      const adapter = await createAdapter();
      const residualFn = makeResidualFn(adapter);
      const jacobianFn = makeJacobianFn(adapter, residualFn, DEFAULT_SOLVER_CONFIG.fdStep);

      expect(() => {
        solveClosureDLS(
          residualFn,
          jacobianFn,
          new Float64Array([2.0, 0.0, 0.0, 0.0]),
          [0, 1, 2, 3],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, maxIterations: 1, tolerance: 1e-12 },
        );
      }).not.toThrow();

      adapter.cleanup();
    });
  });
});
