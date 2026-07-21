

export interface MechanismParams {
  pivot1X: number;
  pivot1Y: number;
  pivot2X: number;
  pivot2Y: number;
  link1Length: number;
  link2Length: number;
  link3Length: number;
  link4Length: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface EndpointPositions {
  c1: Vec2;
  c2: Vec2;
}

export interface JointFKResult {
  x: number;
  y: number;
  rotation: Float64Array;
}

export interface PinocchioAdapter {
  getJointIndex(name: string): number;
  getConfigIndex(name: string): number;
  jointIndices: Record<string, number>;
  configIndices: Record<string, number>;
  fk(q: Float64Array): EndpointPositions;
  getJointPlacement(jointName: string): JointFKResult;
  getModel(): any;
  getData(): any;
  params: MechanismParams;
  rebuild(params: Partial<MechanismParams>): void;
  cleanup(): void;
  computeJointJacobians(q: Float64Array): void;
  getAnalyticJacobian(jointId: number): Float64Array;
  analyticClosureJacobian(q: Float64Array, activeIndices: number[]): Float64Array;
  analyticTargetJacobian(q: Float64Array, activeIndices: number[]): Float64Array;
}

export const DEFAULT_PARAMS: MechanismParams = {
  pivot1X: 0.0,
  pivot1Y: 0,
  pivot2X: 0.0,
  pivot2Y: 0,
  link1Length: 1.0,
  link2Length: 1.0,
  link3Length: 1.0,
  link4Length: 1.0,
};

export const DEFAULT_CLOSED_Q = new Float64Array([
  Math.PI / 3,
  2 * Math.PI / 3,
  Math.PI / 3,
  -Math.PI / 3,
]);

async function getPinModule(): Promise<any> {
  const mod = await import("pinocchio-js");
  return await mod.default();
}

function computeEndpoint(
  placement: { translation: Float64Array; rotation: Float64Array },
  linkLength: number,
): Vec2 {
  const t = placement.translation;
  const R = placement.rotation;
  return {
    x: t[0] + R[0] * linkLength,
    y: t[1] + R[1] * linkLength,
  };
}

function buildPinocchioModel(
  pin: any,
  p: MechanismParams,
): { model: any; data: any; j1: number; j2: number; j3: number; j4: number } {
  const model = new pin.Model();

  const piv1 = pin.SE3.fromXyzRpy(p.pivot1X, p.pivot1Y, 0, 0, 0, 0);
  const piv2 = pin.SE3.fromXyzRpy(p.pivot2X, p.pivot2Y, 0, 0, 0, 0);
  const lp1 = pin.SE3.fromXyzRpy(p.link1Length, 0, 0, 0, 0, 0);
  const lp3 = pin.SE3.fromXyzRpy(p.link3Length, 0, 0, 0, 0, 0);
  const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]);

  const j1 = pin.addJoint(model, 0, pin.JointModelRZ(), piv1, "J1");
  pin.appendBodyToJoint(model, j1, inertia, pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0));

  const j2 = pin.addJoint(model, 0, pin.JointModelRZ(), piv2, "J2");
  pin.appendBodyToJoint(model, j2, inertia, pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0));

  const j3 = pin.addJoint(model, j1, pin.JointModelRZ(), lp1, "J3");
  pin.appendBodyToJoint(model, j3, inertia, pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0));

  const j4 = pin.addJoint(model, j2, pin.JointModelRZ(), lp3, "J4");
  pin.appendBodyToJoint(model, j4, inertia, pin.SE3.fromXyzRpy(0, 0, 0, 0, 0, 0));

  piv1.delete();
  piv2.delete();
  lp1.delete();
  lp3.delete();
  inertia.delete();

  const data = new pin.Data(model);

  return { model, data, j1, j2, j3, j4 };
}

export async function createAdapter(
  params?: Partial<MechanismParams>,
): Promise<PinocchioAdapter> {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pin = await getPinModule();

  let built = buildPinocchioModel(pin, p);
  let model = built.model;
  let data = built.data;
  let j1 = built.j1;
  let j2 = built.j2;
  let j3 = built.j3;
  let j4 = built.j4;
  let pinModule = pin;

  const jointIndices: Record<string, number> = { J1: j1, J2: j2, J3: j3, J4: j4 };
  const configIndices: Record<string, number> = {};
  for (const [name, idx] of Object.entries(jointIndices)) {
    configIndices[name] = idx - 1;
  }

  function refreshIndexMaps() {
    jointIndices["J1"] = j1;
    jointIndices["J2"] = j2;
    jointIndices["J3"] = j3;
    jointIndices["J4"] = j4;
    for (const [name, idx] of Object.entries(jointIndices)) {
      configIndices[name] = idx - 1;
    }
  }

  function getJointIndex(name: string): number {
    const idx = jointIndices[name];
    if (idx === undefined) {
      throw new Error(`Unknown joint name: ${name}`);
    }
    return idx;
  }

  function getConfigIndex(name: string): number {
    const idx = configIndices[name];
    if (idx === undefined) {
      throw new Error(`Unknown joint name: ${name}`);
    }
    return idx;
  }

  function getJointPlacement(jointName: string): JointFKResult {
    const idx = getJointIndex(jointName);
    const placement = pin.getJointPlacement(data, idx);
    return {
      x: placement.translation[0],
      y: placement.translation[1],
      rotation: placement.rotation,
    };
  }

  function fk(q: Float64Array): EndpointPositions {
    pin.forwardKinematics(model, data, q);
    const j3Placement = pin.getJointPlacement(data, j3);
    const j4Placement = pin.getJointPlacement(data, j4);
    const c1 = computeEndpoint(j3Placement, p.link2Length);
    const c2 = computeEndpoint(j4Placement, p.link4Length);
    return { c1, c2 };
  }

  function computeJointJacobians(q: Float64Array): void {
    pinModule.forwardKinematics(model, data, q);
    pinModule.computeJointJacobians(model, data, q);
  }

  function getAnalyticJacobian(jointId: number): Float64Array {
    return pinModule.getJointJacobian(model, data, jointId, 0);
  }

  function analyticClosureJacobian(q: Float64Array, activeIndices: number[]): Float64Array {
    computeJointJacobians(q);
    const J3_J = getAnalyticJacobian(j3);
    const J4_J = getAnalyticJacobian(j4);

    const j3Placement = pinModule.getJointPlacement(data, j3);
    const j4Placement = pinModule.getJointPlacement(data, j4);
    const R3 = j3Placement.rotation;
    const R4 = j4Placement.rotation;

    const pC1x = j3Placement.translation[0] + R3[0] * p.link2Length;
    const pC1y = j3Placement.translation[1] + R3[1] * p.link2Length;
    const pC2x = j4Placement.translation[0] + R4[0] * p.link4Length;
    const pC2y = j4Placement.translation[1] + R4[1] * p.link4Length;

    const m = 2;
    const numActive = activeIndices.length;
    const J = new Float64Array(m * numActive);
    for (let j = 0; j < numActive; j++) {
      const col = activeIndices[j];
      const base = col * 6;
      const w3 = J3_J[base + 5];
      const vC1x = J3_J[base + 0] - w3 * pC1y;
      const vC1y = J3_J[base + 1] + w3 * pC1x;
      const w4 = J4_J[base + 5];
      const vC2x = J4_J[base + 0] - w4 * pC2y;
      const vC2y = J4_J[base + 1] + w4 * pC2x;
      J[j * m + 0] = vC1x - vC2x;
      J[j * m + 1] = vC1y - vC2y;
    }
    return J;
  }

  function analyticTargetJacobian(q: Float64Array, activeIndices: number[]): Float64Array {
    computeJointJacobians(q);
    const J3_J = getAnalyticJacobian(j3);
    const J4_J = getAnalyticJacobian(j4);

    const j3Placement = pinModule.getJointPlacement(data, j3);
    const j4Placement = pinModule.getJointPlacement(data, j4);
    const R3 = j3Placement.rotation;
    const R4 = j4Placement.rotation;

    const pC1x = j3Placement.translation[0] + R3[0] * p.link2Length;
    const pC1y = j3Placement.translation[1] + R3[1] * p.link2Length;
    const pC2x = j4Placement.translation[0] + R4[0] * p.link4Length;
    const pC2y = j4Placement.translation[1] + R4[1] * p.link4Length;

    const m = 4;
    const numActive = activeIndices.length;
    const J = new Float64Array(m * numActive);
    for (let j = 0; j < numActive; j++) {
      const col = activeIndices[j];
      const base = col * 6;
      const w3 = J3_J[base + 5];
      const vC1x = J3_J[base + 0] - w3 * pC1y;
      const vC1y = J3_J[base + 1] + w3 * pC1x;
      const w4 = J4_J[base + 5];
      const vC2x = J4_J[base + 0] - w4 * pC2y;
      const vC2y = J4_J[base + 1] + w4 * pC2x;
      J[j * m + 0] = vC1x;
      J[j * m + 1] = vC1y;
      J[j * m + 2] = vC2x;
      J[j * m + 3] = vC2y;
    }
    return J;
  }

  function cleanup(): void {
    data.delete();
    model.delete();
  }

  function rebuild(newParams: Partial<MechanismParams>): void {
    data.delete();
    model.delete();

    Object.assign(p, newParams);

    built = buildPinocchioModel(pin, p);
    model = built.model;
    data = built.data;
    j1 = built.j1;
    j2 = built.j2;
    j3 = built.j3;
    j4 = built.j4;

    refreshIndexMaps();
  }

  return {
    getJointIndex,
    getConfigIndex,
    jointIndices,
    configIndices,
    fk,
    getJointPlacement,
    getModel: () => model,
    getData: () => data,
    params: p,
    rebuild,
    cleanup,
    computeJointJacobians,
    getAnalyticJacobian,
    analyticClosureJacobian,
    analyticTargetJacobian,
  };
}
