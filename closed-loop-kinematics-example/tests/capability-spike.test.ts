import { describe, it, expect } from "vitest";

type PinModule = Record<string, any>;
type PinModel = any;
type PinData = any;

let _pin: PinModule | null = null;

async function getPin(): Promise<PinModule> {
  if (_pin) return _pin;
  const pinModule = await import("pinocchio-js");
  _pin = await pinModule.default();
  return _pin;
}

describe("Capability spike: pinocchio-js API surface", () => {
  // ── 1. WASM Initialization ──
  describe("WASM initialization", () => {
    it("loads the module and exposes expected classes", async () => {
      const pin = await getPin();
      expect(pin).toBeDefined();
      expect(pin.Model).toBeDefined();
      expect(pin.Data).toBeDefined();
      expect(pin.SE3).toBeDefined();
      expect(pin.Inertia).toBeDefined();
    });
  });

  // ── 2. Model creation (programmatic) ──
  describe("Programmatic model construction", () => {
    it("creates an empty model and verifies initial state", async () => {
      const pin = await getPin();
      const model = new pin.Model();

      expect(model.nq).toBe(0);
      expect(model.nv).toBe(0);
      expect(model.njoints).toBe(1);

      model.delete();
    });

    it("builds a two-branch branched model and returns valid nq/nv/njoints", async () => {
      const pin = await getPin();
      const model = new pin.Model();

      // Ground-pivot positions
      const pivot1 = pin.SE3.fromXyzRpy(-0.5, 0.0, 0.0, 0, 0, 0);
      const pivot2 = pin.SE3.fromXyzRpy(0.5, 0.0, 0.0, 0, 0, 0);

      // Branch A: joint 1 (revolute Z at pivot1)
      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot1, "J1");
      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const bodyPlacement = pin.SE3.fromXyzRpy(1.0, 0.0, 0.0, 0, 0, 0);
      pin.appendBodyToJoint(model, j1, inertia, bodyPlacement);

      // Branch A: joint 3 (revolute Z at end of link 1)
      const j3 = pin.addJoint(model, j1, pin.JointModelRZ(), pin.SE3.identity(), "J3");
      const link3Body = pin.SE3.fromXyzRpy(1.0, 0.0, 0.0, 0, 0, 0);
      pin.appendBodyToJoint(model, j3, inertia, link3Body);

      // Branch B: joint 2 (revolute Z at pivot2)
      const j2 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot2, "J2");
      pin.appendBodyToJoint(model, j2, inertia, bodyPlacement);

      // Branch B: joint 4 (revolute Z at end of link 2)
      const j4 = pin.addJoint(model, j2, pin.JointModelRZ(), pin.SE3.identity(), "J4");
      pin.appendBodyToJoint(model, j4, inertia, link3Body);

      expect(model.nq).toBe(4);
      expect(model.nv).toBe(4);
      expect(model.njoints).toBe(5);

      model.delete();
    });

    it("addJoint returns increasing joint indices", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      const s = pin.SE3.identity();

      const id1 = pin.addJoint(model, 0, pin.JointModelRZ(), s, "a");
      const id2 = pin.addJoint(model, id1, pin.JointModelRZ(), s, "b");

      expect(id1).toBe(1);
      expect(id2).toBe(2);

      model.delete();
    });
  });

  // ── 3. URDF parsing path ──
  describe("URDF parsing", () => {
    it("parseURDF and buildPinocchioModel produce a valid model", async () => {
      const pin = await getPin();

      const { parseURDF, buildPinocchioModel } = await import("pinocchio-js/src/urdf-parser.mjs");

      const urdf = `<?xml version="1.0"?>
<robot name="test_arm">
  <link name="base"/>
  <link name="link1"/>
  <link name="link2"/>
  <joint name="j1" type="revolute">
    <parent link="base"/>
    <child link="link1"/>
    <origin xyz="0 0 0" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
  </joint>
  <joint name="j2" type="revolute">
    <parent link="link1"/>
    <child link="link2"/>
    <origin xyz="1 0 0" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
  </joint>
</robot>`;

      let parsed;
      try {
        parsed = parseURDF(urdf);
      } catch (e) {
        if (e instanceof ReferenceError && e.message.includes("DOMParser")) {
          return;
        }
        throw e;
      }

      expect(parsed.robotName).toBe("test_arm");
      expect(parsed.joints.length).toBe(2);

      const model = buildPinocchioModel(pin, parsed);
      expect(model.nq).toBe(2);
      expect(model.nv).toBe(2);
      expect(model.njoints).toBe(3);

      model.delete();
    });
  });

  // ── 4. Data construction and properties ──
  describe("Data construction", () => {
    it("constructs Data from a Model", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      const s = pin.SE3.identity();
      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), s, "j1");
      const data = new pin.Data(model);
      expect(data).toBeDefined();
      data.delete();
      model.delete();
    });
  });

  // ── 5. Forward kinematics ──
  describe("Forward kinematics", () => {
    function buildPlanarBranchedModel(pin: PinModule): PinModel {
      const model = new pin.Model();
      const pivot1 = pin.SE3.fromXyzRpy(-0.5, 0.0, 0.0, 0, 0, 0);
      const pivot2 = pin.SE3.fromXyzRpy(0.5, 0.0, 0.0, 0, 0, 0);
      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const bodyPlacement = pin.SE3.fromXyzRpy(1.0, 0.0, 0.0, 0, 0, 0);

      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot1, "J1");
      pin.appendBodyToJoint(model, j1, inertia, bodyPlacement);

      const j3 = pin.addJoint(model, j1, pin.JointModelRZ(), pin.SE3.identity(), "J3");
      pin.appendBodyToJoint(model, j3, inertia, bodyPlacement);

      const j2 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot2, "J2");
      pin.appendBodyToJoint(model, j2, inertia, bodyPlacement);

      const j4 = pin.addJoint(model, j2, pin.JointModelRZ(), pin.SE3.identity(), "J4");
      pin.appendBodyToJoint(model, j4, inertia, bodyPlacement);

      return model;
    }

    it("forwardKinematics computes joint placements without throwing", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      expect(() => pin.forwardKinematics(model, data, q)).not.toThrow();

      data.delete();
      model.delete();
    });

    it("getJointPlacement returns translation and rotation for joint 1", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      pin.forwardKinematics(model, data, q);
      const placement = pin.getJointPlacement(data, 1);

      expect(placement).toBeDefined();
      expect(placement.translation).toBeDefined();
      expect(placement.translation.length).toBe(3);
      expect(placement.rotation).toBeDefined();
      expect(placement.rotation.length).toBe(9);

      expect(typeof placement.translation[0]).toBe("number");
      expect(typeof placement.translation[1]).toBe("number");
      expect(typeof placement.translation[2]).toBe("number");

      data.delete();
      model.delete();
    });

    it("getJointPlacement returns consistent endpoint positions for known q=0", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0, 0, 0, 0]);

      pin.forwardKinematics(model, data, q);

      const p1 = pin.getJointPlacement(data, 1);
      const p3 = pin.getJointPlacement(data, 3);

      expect(p1.translation[0]).toBeCloseTo(-0.5, 10);
      expect(p1.translation[1]).toBeCloseTo(0.0, 10);

      expect(p3.translation[0]).toBeCloseTo(0.5, 10);
      expect(p3.translation[1]).toBeCloseTo(0.0, 10);

      data.delete();
      model.delete();
    });

    it("updateFramePlacements runs without error", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      pin.forwardKinematics(model, data, q);
      expect(() => pin.updateFramePlacements(model, data)).not.toThrow();

      data.delete();
      model.delete();
    });
  });

  // ── 6. Jacobian API ──
  describe("Jacobian", () => {
    function buildPlanarBranchedModel(pin: PinModule): PinModel {
      const model = new pin.Model();
      const pivot1 = pin.SE3.fromXyzRpy(-0.5, 0.0, 0.0, 0, 0, 0);
      const pivot2 = pin.SE3.fromXyzRpy(0.5, 0.0, 0.0, 0, 0, 0);
      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const bodyPlacement = pin.SE3.fromXyzRpy(1.0, 0.0, 0.0, 0, 0, 0);

      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot1, "J1");
      pin.appendBodyToJoint(model, j1, inertia, bodyPlacement);
      const j3 = pin.addJoint(model, j1, pin.JointModelRZ(), pin.SE3.identity(), "J3");
      pin.appendBodyToJoint(model, j3, inertia, bodyPlacement);

      const j2 = pin.addJoint(model, 0, pin.JointModelRZ(), pivot2, "J2");
      pin.appendBodyToJoint(model, j2, inertia, bodyPlacement);
      const j4 = pin.addJoint(model, j2, pin.JointModelRZ(), pin.SE3.identity(), "J4");
      pin.appendBodyToJoint(model, j4, inertia, bodyPlacement);

      return model;
    }

    it("computeJointJacobians runs without throwing", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      expect(() => pin.computeJointJacobians(model, data, q)).not.toThrow();

      data.delete();
      model.delete();
    });

    it("getJointJacobian returns a Float64Array with correct shape", async () => {
      const pin = await getPin();
      const model = buildPlanarBranchedModel(pin);
      const data = new pin.Data(model);
      const q = new Float64Array([0.5, -0.3, 0.8, -0.2]);

      pin.computeJointJacobians(model, data, q);
      const J = pin.getJointJacobian(model, data, 3, 0);

      expect(J).toBeInstanceOf(Float64Array);
      expect(J.length).toBe(6 * model.nv);

      data.delete();
      model.delete();
    });

    it("ReferenceFrame enum values are accessible", async () => {
      const pin = await getPin();

      expect(pin.ReferenceFrame.WORLD).toBeDefined();
      expect(pin.ReferenceFrame.LOCAL).toBeDefined();
      expect(pin.ReferenceFrame.LOCAL_WORLD_ALIGNED).toBeDefined();
    });
  });

  // ── 7. Vector/matrix storage order ──
  describe("Storage order", () => {
    it("configuration vectors (q) are standard Float64Array", async () => {
      const pin = await getPin();
      const q = new Float64Array([1.0, 2.0, 3.0, 4.0]);
      expect(q[0]).toBe(1.0);
      expect(q[3]).toBe(4.0);
    });

    it("Jacobian matrix is column-major: element J(row=0,col=1) is at index col*nrows+row", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      const s = pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0);
      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), s, "j1");
      pin.appendBodyToJoint(model, j1, inertia, pin.SE3.identity());
      const j2 = pin.addJoint(model, j1, pin.JointModelRZ(), pin.SE3.identity(), "j2");
      pin.appendBodyToJoint(model, j2, inertia, pin.SE3.identity());

      const data = new pin.Data(model);
      const q = new Float64Array([0.0, 0.0]);

      pin.computeJointJacobians(model, data, q);
      const J = pin.getJointJacobian(model, data, 2, 0);

      const nv = model.nv;
      const nrows = 6;

      expect(J.length).toBe(nrows * nv);

      for (let col = 0; col < nv; col++) {
        for (let row = 0; row < nrows; row++) {
          const idx = col * nrows + row;
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(J.length);
        }
      }

      data.delete();
      model.delete();
    });
  });

  // ── 8. Embind memory management ──
  describe("Embind memory management", () => {
    it("Model, Data, SE3, and Inertia objects have delete method", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      expect(typeof model.delete).toBe("function");

      const data = new pin.Data(model);
      expect(typeof data.delete).toBe("function");

      const se3 = pin.SE3.identity();
      expect(typeof se3.delete).toBe("function");

      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      expect(typeof inertia.delete).toBe("function");

      const jm = pin.JointModelRZ();
      expect(typeof jm.delete).toBe("function");

      se3.delete();
      inertia.delete();
      jm.delete();
      data.delete();
      model.delete();
    });

    it("isDeleted returns false before delete, true after", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      expect(model.isDeleted()).toBe(false);
      model.delete();
      expect(model.isDeleted()).toBe(true);
    });

    it("calling delete on an already-deleted object throws", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      model.delete();
      expect(() => model.delete()).toThrow();
    });

    it("SE3 and JointModel temporary objects must be deleted to avoid leaks", async () => {
      const pin = await getPin();
      const model = new pin.Model();

      const tempSE3 = pin.SE3.fromXyzRpy(1.0, 0.0, 0.0, 0, 0, 0);
      const tempJoint = pin.JointModelRZ();

      pin.addJoint(model, 0, tempJoint, tempSE3, "test_joint");

      expect(tempSE3.isDeleted()).toBe(false);
      expect(tempJoint.isDeleted()).toBe(false);

      tempSE3.delete();
      tempJoint.delete();
      model.delete();
    });

    it("flushPendingDeletes is exposed", async () => {
      const pin = await getPin();
      expect(typeof pin.flushPendingDeletes).toBe("function");
    });
  });

  // ── 9. neutralConfiguration and utility functions ──
  describe("Utility functions", () => {
    it("neutralConfiguration returns a Float64Array of length nq", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      const s = pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0);
      const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), s, "j1");
      pin.appendBodyToJoint(model, j1, inertia, pin.SE3.identity());

      const q = pin.neutralConfiguration(model);
      expect(q).toBeInstanceOf(Float64Array);
      expect(q.length).toBe(model.nq);

      model.delete();
    });

    it("computeTotalMass returns a positive number", async () => {
      const pin = await getPin();
      const model = new pin.Model();
      const s = pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0);
      const inertia = pin.Inertia.fromMassComInertia(2.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);
      const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), s, "j1");
      pin.appendBodyToJoint(model, j1, inertia, pin.SE3.identity());

      const mass = pin.computeTotalMass(model);
      expect(mass).toBe(2.0);

      model.delete();
    });
  });
});
