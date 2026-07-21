import type { PinocchioAdapter, Vec2 } from "./pinocchio-adapter";

export interface Residual3D {
  dx: number;
  dy: number;
  dz: number;
  norm: number;
}

export interface ClosureResult {
  c1: Vec2;
  c2: Vec2;
  residual: Residual3D;
}

export const CLOSURE_TOLERANCE = 1e-6;

export function computeClosure(
  adapter: PinocchioAdapter,
  q: Float64Array,
): ClosureResult {
  const ep = adapter.fk(q);
  const dx = ep.c1.x - ep.c2.x;
  const dy = ep.c1.y - ep.c2.y;
  const norm = Math.sqrt(dx * dx + dy * dy);
  return {
    c1: ep.c1,
    c2: ep.c2,
    residual: { dx, dy, dz: 0, norm },
  };
}

export function computeClosureJacobian(
  J_C1: Float64Array,
  J_C2: Float64Array,
  nv: number,
): Float64Array {
  const J_phi = new Float64Array(2 * nv);
  for (let col = 0; col < nv; col++) {
    J_phi[col * 2 + 0] = J_C1[col * 2 + 0] - J_C2[col * 2 + 0];
    J_phi[col * 2 + 1] = J_C1[col * 2 + 1] - J_C2[col * 2 + 1];
  }
  return J_phi;
}

export function isClosed(
  residual: Residual3D,
  tolerance: number = CLOSURE_TOLERANCE,
): boolean {
  return residual.norm < tolerance;
}
