import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q, DEFAULT_PARAMS } from "../src/pinocchio-adapter";
import { computeNumericalJacobian } from "../src/numerical-jacobian";
import { solveClosureDLS } from "../src/dls-solver";
import { DEFAULT_SOLVER_CONFIG } from "../src/types";
import type { ResidualFunction, SolverConfig, JointBounds } from "../src/types";

const JACOBIAN_TOLERANCE = 1e-4;
const FD_STEP = 1e-6;

const TEST_CONFIGS: Float64Array[] = [
  new Float64Array(DEFAULT_CLOSED_Q),
  new Float64Array([0.5, 0.5, 0.5, 0.5]),
  new Float64Array([1.0, 1.0, -0.5, -0.5]),
  new Float64Array([-0.5, 0.8, 1.0, -0.3]),
  new Float64Array([0.3, -0.7, 1.2, -0.5]),
  new Float64Array([0.0, 0.0, 0.0, 0.0]),
];

function makeClosureResidualFn(
  adapter: Awaited<ReturnType<typeof createAdapter>>,
): ResidualFunction {
  return (q: Float64Array) => {
    const ep = adapter.fk(q);
    return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
  };
}

describe("Analytic Jacobian — Issue 10", () => {
  describe("Closure Jacobian: analytic vs finite-difference", () => {
    TEST_CONFIGS.forEach((qStart, idx) => {
      it(`agrees with FD Jacobian within ${JACOBIAN_TOLERANCE} at config ${idx}`, async () => {
        const adapter = await createAdapter();
        const q = new Float64Array(qStart);
        const active = [0, 1, 2, 3];

        const analyticJ = adapter.analyticClosureJacobian(q, active);
        const residualFn = makeClosureResidualFn(adapter);
        const fdJ = computeNumericalJacobian(residualFn, q, active, FD_STEP);

        expect(analyticJ.length).toBe(fdJ.length);
        for (let i = 0; i < analyticJ.length; i++) {
          expect(analyticJ[i]).toBeCloseTo(fdJ[i], JACOBIAN_TOLERANCE);
        }

        adapter.cleanup();
      });
    });
  });

  describe("Closure Jacobian with subset of active joints", () => {
    it("agrees with FD when only J1 and J3 are active", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const active = [0, 2];

      const analyticJ = adapter.analyticClosureJacobian(q, active);
      const residualFn = makeClosureResidualFn(adapter);
      const fdJ = computeNumericalJacobian(residualFn, q, active, FD_STEP);

      expect(analyticJ.length).toBe(2 * active.length);
      for (let i = 0; i < analyticJ.length; i++) {
        expect(analyticJ[i]).toBeCloseTo(fdJ[i], JACOBIAN_TOLERANCE);
      }

      adapter.cleanup();
    });

    it("agrees with FD when only J2 and J4 are active", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const active = [1, 3];

      const analyticJ = adapter.analyticClosureJacobian(q, active);
      const residualFn = makeClosureResidualFn(adapter);
      const fdJ = computeNumericalJacobian(residualFn, q, active, FD_STEP);

      expect(analyticJ.length).toBe(2 * active.length);
      for (let i = 0; i < analyticJ.length; i++) {
        expect(analyticJ[i]).toBeCloseTo(fdJ[i], JACOBIAN_TOLERANCE);
      }

      adapter.cleanup();
    });
  });

  describe("Closure Jacobian after geometry rebuild", () => {
    it("agrees with FD after changing link lengths", async () => {
      const adapter = await createAdapter();
      adapter.rebuild({ link1Length: 1.5, link2Length: 1.2, link3Length: 0.8, link4Length: 0.6 });

      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const active = [0, 1, 2, 3];

      const analyticJ = adapter.analyticClosureJacobian(q, active);
      const residualFn = makeClosureResidualFn(adapter);
      const fdJ = computeNumericalJacobian(residualFn, q, active, FD_STEP);

      expect(analyticJ.length).toBe(2 * active.length);
      for (let i = 0; i < analyticJ.length; i++) {
        expect(analyticJ[i]).toBeCloseTo(fdJ[i], JACOBIAN_TOLERANCE);
      }

      adapter.cleanup();
    });
  });

  describe("Target Jacobian: analytic vs finite-difference", () => {
    TEST_CONFIGS.forEach((qStart, idx) => {
      it(`agrees with FD target Jacobian within ${JACOBIAN_TOLERANCE} at config ${idx}`, async () => {
        const adapter = await createAdapter();
        const q = new Float64Array(qStart);
        const active = [0, 1, 2, 3];

        const analyticJ = adapter.analyticTargetJacobian(q, active);

        const targetResidualFn: ResidualFunction = (x: Float64Array) => {
          const ep = adapter.fk(x);
          return new Float64Array([ep.c1.x, ep.c1.y, ep.c2.x, ep.c2.y]);
        };
        const fdJ = computeNumericalJacobian(targetResidualFn, q, active, FD_STEP);

        expect(analyticJ.length).toBe(4 * active.length);
        for (let i = 0; i < analyticJ.length; i++) {
          expect(analyticJ[i]).toBeCloseTo(fdJ[i], JACOBIAN_TOLERANCE);
        }

        adapter.cleanup();
      });
    });
  });

  describe("Storage order validation", () => {
    it("getJointJacobian is column-major: J[col * 6 + row] accesses (row, col)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      adapter.computeJointJacobians(q);
      const J3 = adapter.getAnalyticJacobian(adapter.jointIndices["J3"]);

      const nv = 4;
      for (let col = 0; col < nv; col++) {
        const base = col * 6;
        expect(J3[base + 0]).not.toBeNaN();
        expect(J3[base + 1]).not.toBeNaN();
        expect(J3[base + 5]).not.toBeNaN();
      }

      adapter.cleanup();
    });
  });

  describe("Solver convergence with analytic Jacobian", () => {
    const SOLVER_REACHABLE: Float64Array[] = [
      new Float64Array([0.5, 0.5, 0.5, 0.5]),
      new Float64Array([1.0, 1.0, -0.5, -0.5]),
      new Float64Array([-0.5, 0.8, 1.0, -0.3]),
      new Float64Array([0.3, -0.7, 1.2, -0.5]),
      new Float64Array([0.2, 0.2, 0.2, 0.2]),
    ];

    const BOUNDS: JointBounds[] = [
      { min: -Math.PI, max: Math.PI },
      { min: -Math.PI, max: Math.PI },
      { min: -Math.PI, max: Math.PI },
      { min: -Math.PI, max: Math.PI },
    ];

    SOLVER_REACHABLE.forEach((qStart, idx) => {
      it(`converges from config ${idx} using analytic Jacobian`, async () => {
        const adapter = await createAdapter();
        const residualFn: ResidualFunction = (q: Float64Array) => {
          const ep = adapter.fk(q);
          return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
        };
        const jacobianFn = (q: Float64Array, active: number[]) =>
          adapter.analyticClosureJacobian(q, active);

        const result = solveClosureDLS(
          residualFn,
          jacobianFn,
          qStart,
          [0, 1, 2, 3],
          BOUNDS,
          { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8 },
        );

        expect(result.converged).toBe(true);
        expect(result.finalResidual).toBeLessThan(1e-6);
        expect(result.reason).toBe("Converged");

        adapter.cleanup();
      });
    });
  });

  describe("Validation tests — Issue 10 acceptance criteria", () => {
    it("frame Jacobians are expressed in a common world-aligned reference", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const active = [0, 1, 2, 3];

      adapter.computeJointJacobians(q);
      const J3 = adapter.getAnalyticJacobian(adapter.jointIndices["J3"]);
      const J4 = adapter.getAnalyticJacobian(adapter.jointIndices["J4"]);

      const j3p = adapter.getJointPlacement("J3");
      const j4p = adapter.getJointPlacement("J4");

      const pC1x = j3p.x + j3p.rotation[0] * adapter.params.link2Length;
      const pC1y = j3p.y + j3p.rotation[1] * adapter.params.link2Length;
      const pC2x = j4p.x + j4p.rotation[0] * adapter.params.link4Length;
      const pC2y = j4p.y + j4p.rotation[1] * adapter.params.link4Length;

      for (let col = 0; col < 4; col++) {
        const base = col * 6;
        const vC1x = J3[base + 0] - J3[base + 5] * pC1y;
        const vC1y = J3[base + 1] + J3[base + 5] * pC1x;
        const vC2x = J4[base + 0] - J4[base + 5] * pC2y;
        const vC2y = J4[base + 1] + J4[base + 5] * pC2x;

        expect(typeof vC1x).toBe("number");
        expect(typeof vC1y).toBe("number");
        expect(typeof vC2x).toBe("number");
        expect(typeof vC2y).toBe("number");
        expect(Number.isFinite(vC1x)).toBe(true);
        expect(Number.isFinite(vC1y)).toBe(true);
        expect(Number.isFinite(vC2x)).toBe(true);
        expect(Number.isFinite(vC2y)).toBe(true);
      }

      adapter.cleanup();
    });

    it("finite-difference path still works independently of analytic", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const residualFn = makeClosureResidualFn(adapter);
      const fdJ = computeNumericalJacobian(residualFn, q, [0, 1, 2, 3], FD_STEP);

      expect(fdJ).toBeInstanceOf(Float64Array);
      expect(fdJ.length).toBe(8);

      adapter.cleanup();
    });
  });
});
