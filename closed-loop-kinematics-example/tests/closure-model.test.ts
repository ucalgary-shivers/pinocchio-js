import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q } from "../src/pinocchio-adapter";
import {
  computeClosure,
  isClosed,
  CLOSURE_TOLERANCE,
} from "../src/closure-model";

describe("Planar closure model — Issue 04", () => {
  describe("Zero residual at known closed configurations", () => {
    it("returns zero residual for DEFAULT_CLOSED_Q", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const result = computeClosure(adapter, q);

      expect(result.residual.dx).toBeCloseTo(0, 10);
      expect(result.residual.dy).toBeCloseTo(0, 10);
      expect(result.residual.norm).toBeLessThan(CLOSURE_TOLERANCE);
      adapter.cleanup();
    });

    it("reports isClosed true for DEFAULT_CLOSED_Q", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const result = computeClosure(adapter, q);

      expect(isClosed(result.residual)).toBe(true);
      adapter.cleanup();
    });

    it("returns zero residual for a symmetric closed configuration", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([Math.PI / 2, Math.PI / 2, -Math.PI / 6, Math.PI / 6]);

      const result = computeClosure(adapter, q);

      expect(result.residual.norm).toBeLessThan(1e-10);
      adapter.cleanup();
    });
  });

  describe("Non-zero residual for deliberately open configurations", () => {
    it("returns positive dx when C1 is to the right of C2", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.5, 0.5, 0.5, 0.0]);

      const result = computeClosure(adapter, q);

      expect(result.residual.norm).toBeGreaterThan(0.01);
      adapter.cleanup();
    });

    it("returns negative dx when C1 is to the left of C2", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.0, 0.5, 0.0, 0.5]);

      const result = computeClosure(adapter, q);

      expect(result.residual.norm).toBeGreaterThan(0.01);
      adapter.cleanup();
    });

    it("reports isClosed false for deliberately open config", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([1.0, 0.0, 0.0, 0.0]);

      const result = computeClosure(adapter, q);

      expect(isClosed(result.residual)).toBe(false);
      adapter.cleanup();
    });
  });

  describe("World-aligned frame consistency", () => {
    it("returns endpoint positions consistent with adapter.fk", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.3, -0.7, 1.2, -0.5]);

      const direct = adapter.fk(q);
      const result = computeClosure(adapter, q);

      expect(result.c1.x).toBe(direct.c1.x);
      expect(result.c1.y).toBe(direct.c1.y);
      expect(result.c2.x).toBe(direct.c2.x);
      expect(result.c2.y).toBe(direct.c2.y);
      adapter.cleanup();
    });

    it("residual dx matches c1.x - c2.x", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.3, -0.7, 1.2, -0.5]);

      const result = computeClosure(adapter, q);

      expect(result.residual.dx).toBeCloseTo(result.c1.x - result.c2.x, 15);
      expect(result.residual.dy).toBeCloseTo(result.c1.y - result.c2.y, 15);
      adapter.cleanup();
    });

    it("norm matches sqrt(dx^2 + dy^2)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.3, -0.7, 1.2, -0.5]);

      const result = computeClosure(adapter, q);
      const expectedNorm = Math.sqrt(
        result.residual.dx * result.residual.dx +
          result.residual.dy * result.residual.dy,
      );

      expect(result.residual.norm).toBeCloseTo(expectedNorm, 15);
      adapter.cleanup();
    });
  });

  describe("dz is zero (planar mechanism)", () => {
    it("returns dz = 0 for any configuration", async () => {
      const adapter = await createAdapter();
      const configs = [
        new Float64Array(DEFAULT_CLOSED_Q),
        new Float64Array([0.5, -0.3, 0.8, -0.2]),
        new Float64Array([1.0, 2.0, -1.0, 0.5]),
        new Float64Array([0, 0, 0, 0]),
      ];

      for (const q of configs) {
        const result = computeClosure(adapter, q);
        expect(result.residual.dz).toBe(0);
      }

      adapter.cleanup();
    });
  });

  describe("isClosed tolerance", () => {
    it("respects custom tolerance parameter", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([1.0, 0.0, 0.0, 0.0]);

      const result = computeClosure(adapter, q);

      expect(isClosed(result.residual, 100)).toBe(true);
      expect(isClosed(result.residual, 1e-12)).toBe(false);
      adapter.cleanup();
    });
  });
});
