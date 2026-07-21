import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q } from "../src/pinocchio-adapter";
import { computeNumericalJacobian } from "../src/numerical-jacobian";
import type { ResidualFunction } from "../src/types";

describe("Numerical Jacobian — Issue 05", () => {
  it("returns a Float64Array with correct shape (2 x numActive)", async () => {
    const adapter = await createAdapter();
    const q = new Float64Array(DEFAULT_CLOSED_Q);

    const residualFn: ResidualFunction = (x: Float64Array) => {
      const ep = adapter.fk(x);
      return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
    };

    const active = [0, 1, 2, 3];
    const h = 1e-6;
    const J = computeNumericalJacobian(residualFn, q, active, h);

    expect(J).toBeInstanceOf(Float64Array);
    expect(J.length).toBe(2 * active.length);
    adapter.cleanup();
  });

  it("produces an approximate Jacobian that satisfies the Taylor remainder test", async () => {
    const adapter = await createAdapter();
    const q = new Float64Array(DEFAULT_CLOSED_Q);

    const residualFn: ResidualFunction = (x: Float64Array) => {
      const ep = adapter.fk(x);
      return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
    };

    const active = [0, 1, 2, 3];
    const h = 1e-6;
    const J = computeNumericalJacobian(residualFn, q, active, h);

    const phi0 = residualFn(q);
    const eps = 1e-5;
    for (let j = 0; j < active.length; j++) {
      const idx = active[j];
      const qPert = new Float64Array(q);
      qPert[idx] += eps;
      const phiPert = residualFn(qPert);

      for (let i = 0; i < 2; i++) {
        const predicted = phi0[i] + J[j * 2 + i] * eps;
        expect(phiPert[i]).toBeCloseTo(predicted, 6);
      }
    }
    adapter.cleanup();
  });

  it("respects activeIndices subset", async () => {
    const adapter = await createAdapter();
    const q = new Float64Array(DEFAULT_CLOSED_Q);

    const residualFn: ResidualFunction = (x: Float64Array) => {
      const ep = adapter.fk(x);
      return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
    };

    const active = [1, 3];
    const h = 1e-6;
    const J = computeNumericalJacobian(residualFn, q, active, h);

    expect(J.length).toBe(2 * active.length);
    adapter.cleanup();
  });

  it("produces zero Jacobian columns for coordinates that do not affect residual", async () => {
    const dummyFn: ResidualFunction = (_q: Float64Array) => {
      return new Float64Array([0, 0]);
    };

    const q = new Float64Array([1, 2, 3, 4]);
    const active = [0, 1, 2, 3];
    const h = 1e-6;
    const J = computeNumericalJacobian(dummyFn, q, active, h);

    for (let i = 0; i < J.length; i++) {
      expect(J[i]).toBe(0);
    }
  });
});
