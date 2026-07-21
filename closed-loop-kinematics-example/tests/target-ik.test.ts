import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q } from "../src/pinocchio-adapter";
import { solveClosureDLS } from "../src/dls-solver";
import { DEFAULT_SOLVER_CONFIG } from "../src/types";
import type { SolverConfig, JointBounds } from "../src/types";
import {
  makeTargetResidual,
  makeTargetJacobian,
  estimateConditioning,
  hasConditioningWarning,
} from "../src/target-ik";

const DEFAULT_BOUNDS: JointBounds[] = [
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
];

describe("Target IK — Issue 08", () => {
  describe("Stacked residual construction", () => {
    it("computes a 4-element stacked residual for both endpoints relative to target", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const ep = adapter.fk(q);
      const target = { x: ep.c1.x, y: ep.c1.y };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => target,
      );

      const r = residualFn(q);
      expect(r.length).toBe(4);
      expect(r[0]).toBeCloseTo(0, 10);
      expect(r[1]).toBeCloseTo(0, 10);
      expect(r[2]).toBeCloseTo(0, 10);
      expect(r[3]).toBeCloseTo(0, 10);

      adapter.cleanup();
    });

    it("reports non-zero residual when target is away from both endpoints", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const farTarget = { x: 5, y: 5 };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => farTarget,
      );

      const r = residualFn(q);
      expect(r.length).toBe(4);
      const norm = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
      expect(norm).toBeGreaterThan(1);

      adapter.cleanup();
    });
  });

  describe("Convergence to a reachable target", () => {
    it("solves for a reachable target placing both endpoints at the target position within tolerance", async () => {
      const adapter = await createAdapter();

      const qStart = new Float64Array([0.5, 0.5, 0.5, 0.5]);
      const initialEp = adapter.fk(qStart);
      const target = { x: initialEp.c1.x, y: initialEp.c1.y };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => target,
      );
      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        qStart,
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 100 },
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);
      expect(result.reason).toBe("Converged");

      const finalEp = adapter.fk(result.q);
      const distC1 = Math.sqrt(
        (finalEp.c1.x - target.x) ** 2 + (finalEp.c1.y - target.y) ** 2,
      );
      const distC2 = Math.sqrt(
        (finalEp.c2.x - target.x) ** 2 + (finalEp.c2.y - target.y) ** 2,
      );
      expect(distC1).toBeLessThan(1e-6);
      expect(distC2).toBeLessThan(1e-6);

      const closureDist = Math.sqrt(
        (finalEp.c1.x - finalEp.c2.x) ** 2 + (finalEp.c1.y - finalEp.c2.y) ** 2,
      );
      expect(closureDist).toBeLessThan(1e-6);

      adapter.cleanup();
    });

    it("converges to multiple different reachable targets", async () => {
      const adapter = await createAdapter();

      const configs = [
        new Float64Array([0.5, 0.5, 0.5, 0.5]),
        new Float64Array([1.0, 1.0, -0.5, -0.5]),
        new Float64Array([0.2, 0.2, 0.2, 0.2]),
      ];

      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      for (const qStart of configs) {
        const ep = adapter.fk(qStart);
        const target = { x: ep.c1.x, y: ep.c1.y };

        const localResidualFn = makeTargetResidual(
          (q: Float64Array) => adapter.fk(q),
          () => target,
        );

        const result = solveClosureDLS(
          localResidualFn,
          jacobianFn,
          qStart,
          [0, 1, 2, 3],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 100 },
        );

        const finalEp = adapter.fk(result.q);
        const distC1 = Math.sqrt(
          (finalEp.c1.x - target.x) ** 2 + (finalEp.c1.y - target.y) ** 2,
        );
        const distC2 = Math.sqrt(
          (finalEp.c2.x - target.x) ** 2 + (finalEp.c2.y - target.y) ** 2,
        );

        expect(distC1).toBeLessThan(1e-6);
        expect(distC2).toBeLessThan(1e-6);
      }

      adapter.cleanup();
    });
  });

  describe("Unreachable target handling", () => {
    it("produces a controlled non-converged result for an unreachable target", async () => {
      const adapter = await createAdapter();
      const farTarget = { x: 10, y: 10 };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => farTarget,
      );
      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        new Float64Array([0.5, 0.5, 0.5, 0.5]),
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 50 },
      );

      expect(result.converged).toBe(false);
      expect(result.iterations).toBeLessThanOrEqual(50);
      expect(result.q).toBeDefined();
      expect(typeof result.finalResidual).toBe("number");
      expect(typeof result.solveTimeMs).toBe("number");
      expect(result.reason).toContain("Max iterations");

      adapter.cleanup();
    });

    it("does not throw for an unreachable target", async () => {
      const adapter = await createAdapter();
      const farTarget = { x: 10, y: 10 };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => farTarget,
      );
      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      expect(() => {
        solveClosureDLS(
          residualFn,
          jacobianFn,
          new Float64Array([0.5, 0.5, 0.5, 0.5]),
          [0, 1, 2, 3],
          DEFAULT_BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 5 },
        );
      }).not.toThrow();

      adapter.cleanup();
    });
  });

  describe("Conditioning estimation", () => {
    it("returns 1 for a well-conditioned configuration", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ratio = estimateConditioning(
        (q: Float64Array) => adapter.fk(q),
        q,
        [0, 1, 2, 3],
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      expect(ratio).toBeGreaterThan(0.01);
      expect(ratio).toBeLessThanOrEqual(1);

      adapter.cleanup();
    });

    it("returns 0 for zero active joints", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ratio = estimateConditioning(
        (q: Float64Array) => adapter.fk(q),
        q,
        [],
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      expect(ratio).toBe(0);

      adapter.cleanup();
    });
  });

  describe("Conditioning warning flag", () => {
    it("triggers warning when ratio is below threshold", () => {
      expect(hasConditioningWarning(0, 0.01)).toBe(false);
      expect(hasConditioningWarning(0.005, 0.01)).toBe(true);
      expect(hasConditioningWarning(0.02, 0.01)).toBe(false);
      expect(hasConditioningWarning(1, 0.01)).toBe(false);
    });
  });

  describe("Target residual respects solver policies", () => {
    it("respects joint bounds during target IK solve", async () => {
      const adapter = await createAdapter();
      const target = { x: 0.5, y: 0.5 };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => target,
      );
      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      const tightBounds: JointBounds[] = [
        { min: -0.3, max: 0.3 },
        { min: -0.3, max: 0.3 },
        { min: -0.3, max: 0.3 },
        { min: -0.3, max: 0.3 },
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

    it("respects step limit during target IK solve", async () => {
      const adapter = await createAdapter();
      const target = { x: 0.5, y: 0.5 };

      const residualFn = makeTargetResidual(
        (q: Float64Array) => adapter.fk(q),
        () => target,
      );
      const jacobianFn = makeTargetJacobian(
        (q: Float64Array) => adapter.fk(q),
        DEFAULT_SOLVER_CONFIG.fdStep,
      );

      const config: SolverConfig = {
        ...DEFAULT_SOLVER_CONFIG,
        stepLimit: 0.01,
        tolerance: 1e-8,
        maxIterations: 500,
      };

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        new Float64Array([0.5, 0.5, 0.5, 0.5]),
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        config,
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      adapter.cleanup();
    });
  });
});
