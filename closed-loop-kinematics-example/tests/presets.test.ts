import { describe, it, expect } from "vitest";
import { PRESETS, applyPreset } from "../src/presets";
import { createAdapter, DEFAULT_PARAMS } from "../src/pinocchio-adapter";
import { solveClosureDLS } from "../src/dls-solver";
import { computeNumericalJacobian } from "../src/numerical-jacobian";
import { DEFAULT_SOLVER_CONFIG } from "../src/types";
import type { ResidualFunction, JointBounds } from "../src/types";

const DEFAULT_BOUNDS: JointBounds[] = [
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
  { min: -10 * Math.PI, max: 10 * Math.PI },
];

describe("Presets — Issue 09", () => {
  describe("Preset definitions", () => {
    it("defines at least 4 presets", () => {
      expect(PRESETS.length).toBeGreaterThanOrEqual(4);
    });

    it("each preset has a name and description", () => {
      for (const preset of PRESETS) {
        expect(preset.name).toBeTruthy();
        expect(preset.description).toBeTruthy();
      }
    });

    it("each preset defines exactly 4 solverAdjustable entries", () => {
      for (const preset of PRESETS) {
        expect(preset.solverAdjustable).toHaveLength(4);
      }
    });

    it("each preset defines a valid mode", () => {
      const validModes = ["fk", "project", "target-ik"];
      for (const preset of PRESETS) {
        expect(validModes).toContain(preset.mode);
      }
    });

    it("each preset q array has length 4", () => {
      for (const preset of PRESETS) {
        expect(preset.q).toHaveLength(4);
        for (const v of preset.q) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    });
  });

  describe("Assembly-mode presets", () => {
    const assemblyPresets = PRESETS.filter(
      (p) => p.name.startsWith("Assembly Mode"),
    );

    it("has at least two assembly-mode presets", () => {
      expect(assemblyPresets.length).toBeGreaterThanOrEqual(2);
    });

    for (const preset of assemblyPresets) {
      it(`Assembly Mode "${preset.name}" produces closure residual below 1e-6 m`, async () => {
        const adapter = await createAdapter(preset.params);
        const ep = adapter.fk(preset.q);
        const dx = ep.c1.x - ep.c2.x;
        const dy = ep.c1.y - ep.c2.y;
        const norm = Math.sqrt(dx * dx + dy * dy);
        expect(norm).toBeLessThan(1e-6);
        adapter.cleanup();
      });
    }

    it("assembly-mode presets produce different joint configurations", () => {
      if (assemblyPresets.length >= 2) {
        const q0 = assemblyPresets[0].q;
        const q1 = assemblyPresets[1].q;
        let diff = false;
        for (let i = 0; i < q0.length; i++) {
          if (Math.abs(q0[i] - q1[i]) > 1e-6) diff = true;
        }
        expect(diff).toBe(true);
      }
    });

    for (const preset of assemblyPresets) {
      it(`Assembly Mode "${preset.name}" uses default geometry`, () => {
        expect(preset.params.pivot1X).toBe(DEFAULT_PARAMS.pivot1X);
        expect(preset.params.pivot1Y).toBe(DEFAULT_PARAMS.pivot1Y);
        expect(preset.params.pivot2X).toBe(DEFAULT_PARAMS.pivot2X);
        expect(preset.params.pivot2Y).toBe(DEFAULT_PARAMS.pivot2Y);
        expect(preset.params.link1Length).toBe(DEFAULT_PARAMS.link1Length);
        expect(preset.params.link2Length).toBe(DEFAULT_PARAMS.link2Length);
        expect(preset.params.link3Length).toBe(DEFAULT_PARAMS.link3Length);
        expect(preset.params.link4Length).toBe(DEFAULT_PARAMS.link4Length);
      });
    }
  });

  describe("Near-singular preset", () => {
    const nearSingularPreset = PRESETS.find((p) =>
      p.name.includes("Near-Singular"),
    );

    it("exists", () => {
      expect(nearSingularPreset).toBeDefined();
    });

    it("can be projected to closure with solver remaining finite", async () => {
      const adapter = await createAdapter(nearSingularPreset!.params);
      const residualFn: ResidualFunction = (q: Float64Array) => {
        const ep = adapter.fk(q);
        return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
      };
      const jacobianFn = (q: Float64Array, active: number[]) =>
        computeNumericalJacobian(residualFn, q, active, DEFAULT_SOLVER_CONFIG.fdStep);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        nearSingularPreset!.q,
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-6, maxIterations: 100 },
      );

      expect(result.converged).toBe(true);
      expect(result.finalResidual).toBeLessThan(1e-6);

      for (let i = 0; i < result.q.length; i++) {
        expect(Number.isNaN(result.q[i])).toBe(false);
        expect(Number.isFinite(result.q[i])).toBe(true);
      }

      adapter.cleanup();
    });
  });

  describe("Unreachable-target preset", () => {
    const unreachablePreset = PRESETS.find((p) =>
      p.name.includes("Unreachable"),
    );

    it("exists", () => {
      expect(unreachablePreset).toBeDefined();
    });

    it("has a target far outside the workspace", () => {
      expect(unreachablePreset!.target).toBeDefined();
      const t = unreachablePreset!.target!;
      const dist = Math.sqrt(t.x * t.x + t.y * t.y);
      expect(dist).toBeGreaterThan(5);
    });

    it("solver produces structured non-convergence for the unreachable target", async () => {
      const adapter = await createAdapter(unreachablePreset!.params);
      const residualFn: ResidualFunction = (q: Float64Array) => {
        const ep = adapter.fk(q);
        const t = unreachablePreset!.target!;
        return new Float64Array([
          ep.c1.x - t.x,
          ep.c1.y - t.y,
          ep.c2.x - t.x,
          ep.c2.y - t.y,
        ]);
      };
      const jacobianFn = (q: Float64Array, active: number[]) =>
        computeNumericalJacobian(residualFn, q, active, DEFAULT_SOLVER_CONFIG.fdStep);

      const result = solveClosureDLS(
        residualFn,
        jacobianFn,
        unreachablePreset!.q,
        [0, 1, 2, 3],
        DEFAULT_BOUNDS,
        { ...DEFAULT_SOLVER_CONFIG, tolerance: 1e-8, maxIterations: 50 },
      );

      expect(result.converged).toBe(false);
      expect(result.reason).toContain("Max iterations");
      expect(typeof result.finalResidual).toBe("number");
      expect(typeof result.solveTimeMs).toBe("number");
      expect(result.iterations).toBe(50);

      for (let i = 0; i < result.q.length; i++) {
        expect(Number.isNaN(result.q[i])).toBe(false);
        expect(Number.isFinite(result.q[i])).toBe(true);
      }

      adapter.cleanup();
    });
  });

  describe("applyPreset", () => {
    it("copies q values into the target array", () => {
      const q = new Float64Array(4);
      const state = applyPreset(PRESETS[0], q);
      expect(state.q).toBe(q);
      for (let i = 0; i < q.length; i++) {
        expect(q[i]).toBe(PRESETS[0].q[i]);
      }
    });

    it("returns a copy of params", () => {
      const q = new Float64Array(4);
      const state = applyPreset(PRESETS[0], q);
      expect(state.params).not.toBe(PRESETS[0].params);
      expect(state.params.pivot1X).toBe(PRESETS[0].params.pivot1X);
    });

    it("returns a copy of solverAdjustable", () => {
      const q = new Float64Array(4);
      const state = applyPreset(PRESETS[0], q);
      expect(state.solverAdjustable).not.toBe(PRESETS[0].solverAdjustable);
      expect(state.solverAdjustable).toEqual(PRESETS[0].solverAdjustable);
    });
  });
});
