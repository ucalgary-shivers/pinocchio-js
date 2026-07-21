import type { PinocchioAdapter } from "./pinocchio-adapter";
import { computeClosureJacobian } from "./closure-model";

export interface ReducedJacobianResult {
  J_red: Float64Array;
  J_phi: Float64Array;
  nv: number;
  numActive: number;
  numPassive: number;
  det: number;
}

export interface ForceTorqueResult {
  torques: Float64Array;
  F: { x: number; y: number };
  reducedJacobian: ReducedJacobianResult;
  pC: { x: number; y: number };
}

export function computeEndpointJacobians(
  adapter: PinocchioAdapter,
  q: Float64Array,
): { J_C1: Float64Array; J_C2: Float64Array; pC: { x: number; y: number }; nv: number } {
  const model = adapter.getModel();
  const nv = model.nv;

  adapter.computeJointJacobians(q);

  const j3Idx = adapter.jointIndices["J3"];
  const j4Idx = adapter.jointIndices["J4"];
  const J3_J = adapter.getAnalyticJacobian(j3Idx);
  const J4_J = adapter.getAnalyticJacobian(j4Idx);

  const j3Placement = adapter.getJointPlacement("J3");
  const j4Placement = adapter.getJointPlacement("J4");
  const R3 = j3Placement.rotation;
  const R4 = j4Placement.rotation;

  const pC1x = j3Placement.x + R3[0] * adapter.params.link2Length;
  const pC1y = j3Placement.y + R3[1] * adapter.params.link2Length;
  const pC2x = j4Placement.x + R4[0] * adapter.params.link4Length;
  const pC2y = j4Placement.y + R4[1] * adapter.params.link4Length;

  const J_C1 = new Float64Array(2 * nv);
  const J_C2 = new Float64Array(2 * nv);

  for (let col = 0; col < nv; col++) {
    const base = col * 6;
    const w = J3_J[base + 5];
    J_C1[col * 2 + 0] = J3_J[base + 0] - w * pC1y;
    J_C1[col * 2 + 1] = J3_J[base + 1] + w * pC1x;
  }
  for (let col = 0; col < nv; col++) {
    const base = col * 6;
    const w = J4_J[base + 5];
    J_C2[col * 2 + 0] = J4_J[base + 0] - w * pC2y;
    J_C2[col * 2 + 1] = J4_J[base + 1] + w * pC2x;
  }

  return {
    J_C1,
    J_C2,
    pC: { x: (pC1x + pC2x) / 2, y: (pC1y + pC2y) / 2 },
    nv,
  };
}

const DLS_LAMBDA = 1e-6;

function mat2SolveDamped(A: Float64Array, bx: number, by: number, lambda: number, out: Float64Array): void {
  const a11 = A[0], a21 = A[1];
  const a12 = A[2], a22 = A[3];

  const m11 = a11 * a11 + a12 * a12 + lambda;
  const m12 = a11 * a21 + a12 * a22;
  const m22 = a21 * a21 + a22 * a22 + lambda;

  const det = m11 * m22 - m12 * m12;
  if (Math.abs(det) < 1e-30) {
    out[0] = 0; out[1] = 0;
    return;
  }
  const invDet = 1 / det;
  const y0 = (m22 * bx - m12 * by) * invDet;
  const y1 = (-m12 * bx + m11 * by) * invDet;

  out[0] = a11 * y0 + a21 * y1;
  out[1] = a12 * y0 + a22 * y1;
}

function extractColumns(src: Float64Array, srcRows: number, indices: number[]): Float64Array {
  const nCols = indices.length;
  const out = new Float64Array(srcRows * nCols);
  for (let j = 0; j < nCols; j++) {
    const col = indices[j];
    for (let r = 0; r < srcRows; r++) {
      out[j * srcRows + r] = src[col * srcRows + r];
    }
  }
  return out;
}

export function computeReducedJacobian(
  J_x: Float64Array,
  J_phi: Float64Array,
  activeIndices: number[],
  nv: number,
): ReducedJacobianResult {
  const allIndices = Array.from({ length: nv }, (_, i) => i);
  const activeSet = new Set(activeIndices);
  const passiveIndices = allIndices.filter((i) => !activeSet.has(i));

  const numActive = activeIndices.length;
  const numPassive = passiveIndices.length;

  const J_x_a = extractColumns(J_x, 2, activeIndices);
  const J_x_p = extractColumns(J_x, 2, passiveIndices);
  const J_phi_a = extractColumns(J_phi, 2, activeIndices);
  const J_phi_p = extractColumns(J_phi, 2, passiveIndices);

  let det = 0;
  const J_red = new Float64Array(2 * numActive);

  const t = new Float64Array(2);
  if (numPassive === 2) {
    for (let j = 0; j < numActive; j++) {
      mat2SolveDamped(J_phi_p, J_phi_a[j * 2 + 0], J_phi_a[j * 2 + 1], DLS_LAMBDA, t);

      const corr0 = J_x_p[0 * 2 + 0] * t[0] + J_x_p[1 * 2 + 0] * t[1];
      const corr1 = J_x_p[0 * 2 + 1] * t[0] + J_x_p[1 * 2 + 1] * t[1];

      J_red[j * 2 + 0] = J_x_a[j * 2 + 0] - corr0;
      J_red[j * 2 + 1] = J_x_a[j * 2 + 1] - corr1;
    }
  } else {
    J_red.set(J_x_a);
  }

  return { J_red, J_phi, nv, numActive, numPassive, det };
}

export function computeForceTorque(
  adapter: PinocchioAdapter,
  q: Float64Array,
  activeIndices: number[],
  Fx: number,
  Fy: number,
): ForceTorqueResult {
  const { J_C1, J_C2, nv } = computeEndpointJacobians(adapter, q);

  const J_C = new Float64Array(2 * nv);
  for (let col = 0; col < nv; col++) {
    J_C[col * 2 + 0] = J_C1[col * 2 + 0] + J_C2[col * 2 + 0];
    J_C[col * 2 + 1] = J_C1[col * 2 + 1] + J_C2[col * 2 + 1];
  }

  const J_phi = computeClosureJacobian(J_C1, J_C2, nv);
  const reduced = computeReducedJacobian(J_C, J_phi, activeIndices, nv);

  const numActive = reduced.numActive;
  const torques = new Float64Array(numActive);
  for (let i = 0; i < numActive; i++) {
    torques[i] = reduced.J_red[i * 2 + 0] * Fx + reduced.J_red[i * 2 + 1] * Fy;
  }

  const ep = adapter.fk(q);
  const pC = { x: (ep.c1.x + ep.c2.x) / 2, y: (ep.c1.y + ep.c2.y) / 2 };

  return {
    torques,
    F: { x: Fx, y: Fy },
    reducedJacobian: reduced,
    pC,
  };
}
