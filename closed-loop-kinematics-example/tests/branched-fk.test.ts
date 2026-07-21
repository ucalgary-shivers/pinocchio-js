import { describe, it, expect } from "vitest";
import { createAdapter, DEFAULT_CLOSED_Q, DEFAULT_PARAMS } from "../src/pinocchio-adapter";

const FK_TOLERANCE = 1e-10;

function closedFormBranchA(
  q: Float64Array,
  configIndices: Record<string, number>,
  params: { pivot1X: number; pivot1Y: number; link1Length: number; link2Length: number },
) {
  const iJ1 = configIndices["J1"];
  const iJ3 = configIndices["J3"];
  const q1 = q[iJ1];
  const q3 = q[iJ3];
  return {
    x: params.pivot1X + params.link1Length * Math.cos(q1) + params.link2Length * Math.cos(q1 + q3),
    y: params.pivot1Y + params.link1Length * Math.sin(q1) + params.link2Length * Math.sin(q1 + q3),
  };
}

function closedFormBranchB(
  q: Float64Array,
  configIndices: Record<string, number>,
  params: { pivot2X: number; pivot2Y: number; link3Length: number; link4Length: number },
) {
  const iJ2 = configIndices["J2"];
  const iJ4 = configIndices["J4"];
  const q2 = q[iJ2];
  const q4 = q[iJ4];
  return {
    x: params.pivot2X + params.link3Length * Math.cos(q2) + params.link4Length * Math.cos(q2 + q4),
    y: params.pivot2Y + params.link3Length * Math.sin(q2) + params.link4Length * Math.sin(q2 + q4),
  };
}

describe("Branched FK — Issue 03", () => {
  describe("Parent relationships", () => {
    it("builds a model where the universe joint (0) has two child branches via addJoint parentId", async () => {
      const adapter = await createAdapter();
      const indices = adapter.jointIndices;
      expect(indices["J1"]).toBeGreaterThan(0);
      expect(indices["J2"]).toBeGreaterThan(0);
      expect(indices["J3"]).toBeGreaterThan(0);
      expect(indices["J4"]).toBeGreaterThan(0);

      const model = adapter.getModel();
      expect(model.nq).toBe(4);
      expect(model.nv).toBe(4);
      expect(model.njoints).toBe(5);
      adapter.cleanup();
    });

    it("verifies J3 moves when J1 changes (J3 is child of J1)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const initial = adapter.fk(q);

      const j1Idx = adapter.getConfigIndex("J1");
      q[j1Idx] += 0.5;
      const moved = adapter.fk(q);

      const dxC1 = moved.c1.x - initial.c1.x;
      expect(Math.abs(dxC1)).toBeGreaterThan(1e-6);
      adapter.cleanup();
    });

    it("verifies J4 moves when J2 changes (J4 is child of J2)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const initial = adapter.fk(q);

      const j2Idx = adapter.getConfigIndex("J2");
      q[j2Idx] += 0.5;
      const moved = adapter.fk(q);

      const dxC2 = moved.c2.x - initial.c2.x;
      expect(Math.abs(dxC2)).toBeGreaterThan(1e-6);
      adapter.cleanup();
    });
  });

  describe("Name-to-config-index mapping", () => {
    it("maps joint names to explicit configuration indices", async () => {
      const adapter = await createAdapter();
      const ci = adapter.configIndices;
      expect(ci).toHaveProperty("J1");
      expect(ci).toHaveProperty("J2");
      expect(ci).toHaveProperty("J3");
      expect(ci).toHaveProperty("J4");

      const indices = Object.values(ci);
      const unique = new Set(indices);
      expect(unique.size).toBe(4);

      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
      }

      adapter.cleanup();
    });

    it("uses configIndices for slider-to-q mapping (not display order)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);
      const initial = adapter.fk(q);

      const j1Idx = adapter.getConfigIndex("J1");
      q[j1Idx] = 0;
      const atZeroJ1 = adapter.fk(q);

      const expected = closedFormBranchA(
        q,
        adapter.configIndices,
        adapter.params,
      );
      expect(atZeroJ1.c1.x).toBeCloseTo(expected.x, FK_TOLERANCE);
      expect(atZeroJ1.c1.y).toBeCloseTo(expected.y, FK_TOLERANCE);
      adapter.cleanup();
    });
  });

  describe("Endpoint FK vs closed-form planar equations", () => {
    it("matches closed-form for Branch A at default closed config", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ep = adapter.fk(q);
      const expected = closedFormBranchA(q, adapter.configIndices, adapter.params);

      expect(ep.c1.x).toBeCloseTo(expected.x, FK_TOLERANCE);
      expect(ep.c1.y).toBeCloseTo(expected.y, FK_TOLERANCE);
      adapter.cleanup();
    });

    it("matches closed-form for Branch B at default closed config", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ep = adapter.fk(q);
      const expected = closedFormBranchB(q, adapter.configIndices, adapter.params);

      expect(ep.c2.x).toBeCloseTo(expected.x, FK_TOLERANCE);
      expect(ep.c2.y).toBeCloseTo(expected.y, FK_TOLERANCE);
      adapter.cleanup();
    });

    it("matches closed-form for Branch A at random q", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.7, -1.2, 0.3, 0.9]);

      const ep = adapter.fk(q);
      const expected = closedFormBranchA(q, adapter.configIndices, adapter.params);

      expect(ep.c1.x).toBeCloseTo(expected.x, FK_TOLERANCE);
      expect(ep.c1.y).toBeCloseTo(expected.y, FK_TOLERANCE);
      adapter.cleanup();
    });

    it("matches closed-form for Branch B at random q", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array([0.7, -1.2, 0.3, 0.9]);

      const ep = adapter.fk(q);
      const expected = closedFormBranchB(q, adapter.configIndices, adapter.params);

      expect(ep.c2.x).toBeCloseTo(expected.x, FK_TOLERANCE);
      expect(ep.c2.y).toBeCloseTo(expected.y, FK_TOLERANCE);
      adapter.cleanup();
    });

    it("closes at default startup configuration (C1 ≈ C2)", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ep = adapter.fk(q);
      const dx = ep.c1.x - ep.c2.x;
      const dy = ep.c1.y - ep.c2.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      expect(dist).toBeLessThan(1e-10);
      adapter.cleanup();
    });
  });

  describe("WASM allocation reuse", () => {
    it("does not create new embind objects on repeated FK calls", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      const ep1 = adapter.fk(q);
      const ep2 = adapter.fk(q);
      const ep3 = adapter.fk(q);

      expect(ep1.c1.x).toBe(ep2.c1.x);
      expect(ep2.c1.x).toBe(ep3.c1.x);

      const q2 = new Float64Array([0.5, -0.3, 0.8, -0.2]);
      const ep4 = adapter.fk(q2);
      const expectedA = closedFormBranchA(q2, adapter.configIndices, adapter.params);
      const expectedB = closedFormBranchB(q2, adapter.configIndices, adapter.params);

      expect(ep4.c1.x).toBeCloseTo(expectedA.x, FK_TOLERANCE);
      expect(ep4.c2.x).toBeCloseTo(expectedB.x, FK_TOLERANCE);
      adapter.cleanup();
    });

    it("adapter cleanup deletes model and data", async () => {
      const adapter = await createAdapter();
      const model = adapter.getModel();
      const data = adapter.getData();

      expect(model.isDeleted()).toBe(false);
      expect(data.isDeleted()).toBe(false);

      adapter.cleanup();

      expect(model.isDeleted()).toBe(true);
      expect(data.isDeleted()).toBe(true);
    });

    it("rebuild disposes old WASM objects before creating new ones", async () => {
      const adapter = await createAdapter();
      const oldModel = adapter.getModel();
      const oldData = adapter.getData();

      adapter.rebuild({ link1Length: 1.5 });

      expect(oldModel.isDeleted()).toBe(true);
      expect(oldData.isDeleted()).toBe(true);
      adapter.cleanup();
    });
  });

  describe("Model rebuild — Issue 07", () => {
    it("joint-name-to-index mappings remain valid after rebuild", async () => {
      const adapter = await createAdapter();
      const q = new Float64Array(DEFAULT_CLOSED_Q);

      adapter.rebuild({ link1Length: 1.2, link2Length: 0.8 });

      const ci = adapter.configIndices;
      expect(ci).toHaveProperty("J1");
      expect(ci).toHaveProperty("J2");
      expect(ci).toHaveProperty("J3");
      expect(ci).toHaveProperty("J4");

      const indices = Object.values(ci);
      const unique = new Set(indices);
      expect(unique.size).toBe(4);
      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
      }

      const ep = adapter.fk(q);
      const expectedA = closedFormBranchA(q, adapter.configIndices, adapter.params);
      const expectedB = closedFormBranchB(q, adapter.configIndices, adapter.params);

      expect(ep.c1.x).toBeCloseTo(expectedA.x, FK_TOLERANCE);
      expect(ep.c1.y).toBeCloseTo(expectedA.y, FK_TOLERANCE);
      expect(ep.c2.x).toBeCloseTo(expectedB.x, FK_TOLERANCE);
      expect(ep.c2.y).toBeCloseTo(expectedB.y, FK_TOLERANCE);

      adapter.rebuild({ pivot1X: -1.0, pivot2X: 1.0, link3Length: 1.5 });

      const ci2 = adapter.configIndices;
      expect(ci2).toHaveProperty("J1");
      expect(ci2).toHaveProperty("J2");
      expect(ci2).toHaveProperty("J3");
      expect(ci2).toHaveProperty("J4");

      const ep2 = adapter.fk(q);
      const expectedA2 = closedFormBranchA(q, adapter.configIndices, adapter.params);
      const expectedB2 = closedFormBranchB(q, adapter.configIndices, adapter.params);

      expect(ep2.c1.x).toBeCloseTo(expectedA2.x, FK_TOLERANCE);
      expect(ep2.c1.y).toBeCloseTo(expectedA2.y, FK_TOLERANCE);
      expect(ep2.c2.x).toBeCloseTo(expectedB2.x, FK_TOLERANCE);
      expect(ep2.c2.y).toBeCloseTo(expectedB2.y, FK_TOLERANCE);

      adapter.cleanup();
    });
  });
});
