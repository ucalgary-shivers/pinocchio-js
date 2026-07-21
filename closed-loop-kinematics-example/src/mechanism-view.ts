import * as THREE from "three";
import type { Vec2 } from "./pinocchio-adapter";
import type { Residual3D } from "./closure-model";

const BRANCH_A_COLOR = 0xe74c3c;
const BRANCH_B_COLOR = 0x3498db;
const PIVOT_COLOR = 0xcccccc;
const GROUND_BAR_COLOR = 0x666666;
const C1_COLOR = 0xe74c3c;
const C2_COLOR = 0x3498db;
const CLOSED_COLOR = 0x4caf50;
const VIOLATED_COLOR = 0xf44336;

const TARGET_COLOR = 0xffeb3b;
const TARGET_REACHED_COLOR = 0x4caf50;

const MAX_ARROW_WIDTH = 0.04;
const MIN_ARROW_WIDTH = 0.005;
const ARROW_HEAD_LENGTH = 0.12;
const ARROW_HEAD_WIDTH = 0.06;

const LINK_RADIUS = 0.035;
const PIVOT_RADIUS = 0.065;
const JOINT_RADIUS = 0.045;
const ENDPOINT_RADIUS = 0.055;

export class MechanismView {
  private group: THREE.Group;
  private groundBar: THREE.Mesh;
  private pivot1: THREE.Mesh;
  private pivot2: THREE.Mesh;
  private joint3: THREE.Mesh;
  private joint4: THREE.Mesh;
  private link1: THREE.Mesh;
  private link2: THREE.Mesh;
  private link3: THREE.Mesh;
  private link4: THREE.Mesh;
  private endpoint1: THREE.Mesh;
  private endpoint2: THREE.Mesh;

  private arrowGroup: THREE.Group;
  private arrowLine: THREE.Line;
  private arrowHead: THREE.Mesh;

  private targetGroup: THREE.Group;
  private targetRing: THREE.Line;
  private targetCrossH: THREE.Line;
  private targetCrossV: THREE.Line;
  private _targetVisible = false;
  private _targetReached = false;

  private frameAxesGroup: THREE.Group;
  private _frameAxesVisible = false;

  private forceVectorGroup: THREE.Group;
  private _forceVectorVisible = false;

  private torqueGroup: THREE.Group;
  private jointPositions: Vec2[] = [];

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();

    const circleGeo = (r: number) => new THREE.CircleGeometry(r, 16);

    this.pivot1 = new THREE.Mesh(circleGeo(PIVOT_RADIUS), new THREE.MeshBasicMaterial({ color: PIVOT_COLOR }));
    this.pivot2 = new THREE.Mesh(circleGeo(PIVOT_RADIUS), new THREE.MeshBasicMaterial({ color: PIVOT_COLOR }));
    this.joint3 = new THREE.Mesh(circleGeo(JOINT_RADIUS), new THREE.MeshBasicMaterial({ color: PIVOT_COLOR }));
    this.joint4 = new THREE.Mesh(circleGeo(JOINT_RADIUS), new THREE.MeshBasicMaterial({ color: PIVOT_COLOR }));
    this.endpoint1 = new THREE.Mesh(circleGeo(ENDPOINT_RADIUS), new THREE.MeshBasicMaterial({ color: C1_COLOR }));
    this.endpoint2 = new THREE.Mesh(circleGeo(ENDPOINT_RADIUS), new THREE.MeshBasicMaterial({ color: C2_COLOR }));

    this.groundBar = this.makeThickLink(GROUND_BAR_COLOR);
    this.link1 = this.makeThickLink(BRANCH_A_COLOR);
    this.link2 = this.makeThickLink(BRANCH_A_COLOR);
    this.link3 = this.makeThickLink(BRANCH_B_COLOR);
    this.link4 = this.makeThickLink(BRANCH_B_COLOR);

    this.group.add(this.groundBar);
    this.group.add(this.link1);
    this.group.add(this.link3);
    this.group.add(this.link2);
    this.group.add(this.link4);
    this.group.add(this.pivot1);
    this.group.add(this.pivot2);
    this.group.add(this.joint3);
    this.group.add(this.joint4);
    this.group.add(this.endpoint1);
    this.group.add(this.endpoint2);

    this.arrowGroup = new THREE.Group();
    this.group.add(this.arrowGroup);

    const arrowLineGeo = new THREE.BufferGeometry();
    const arrowPositions = new Float32Array(6);
    arrowLineGeo.setAttribute("position", new THREE.BufferAttribute(arrowPositions, 3));
    this.arrowLine = new THREE.Line(
      arrowLineGeo,
      new THREE.LineBasicMaterial({ color: VIOLATED_COLOR, linewidth: 1 }),
    );
    this.arrowGroup.add(this.arrowLine);

    const headGeo = new THREE.ConeGeometry(ARROW_HEAD_WIDTH, ARROW_HEAD_LENGTH, 8);
    const headMat = new THREE.MeshBasicMaterial({ color: VIOLATED_COLOR });
    this.arrowHead = new THREE.Mesh(headGeo, headMat);
    this.arrowGroup.add(this.arrowHead);

    this.targetGroup = new THREE.Group();
    this.group.add(this.targetGroup);
    this.targetGroup.visible = false;

    const ringPoints: THREE.Vector3[] = [];
    const ringSegments = 24;
    const ringRadius = 0.15;
    for (let i = 0; i <= ringSegments; i++) {
      const theta = (i / ringSegments) * Math.PI * 2;
      ringPoints.push(new THREE.Vector3(Math.cos(theta) * ringRadius, Math.sin(theta) * ringRadius, 0));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPoints);
    this.targetRing = new THREE.Line(
      ringGeo,
      new THREE.LineBasicMaterial({ color: TARGET_COLOR, linewidth: 2, transparent: true, opacity: 0.9 }),
    );
    this.targetGroup.add(this.targetRing);

    const crossSize = 0.2;
    const crossMat = new THREE.LineBasicMaterial({ color: TARGET_COLOR, linewidth: 2, transparent: true, opacity: 0.9 });
    const hPoints = [new THREE.Vector3(-crossSize, 0, 0), new THREE.Vector3(crossSize, 0, 0)];
    const hGeo = new THREE.BufferGeometry().setFromPoints(hPoints);
    this.targetCrossH = new THREE.Line(hGeo, crossMat);
    this.targetGroup.add(this.targetCrossH);

    const vPoints = [new THREE.Vector3(0, -crossSize, 0), new THREE.Vector3(0, crossSize, 0)];
    const vGeo = new THREE.BufferGeometry().setFromPoints(vPoints);
    this.targetCrossV = new THREE.Line(vGeo, crossMat);
    this.targetGroup.add(this.targetCrossV);

    this.frameAxesGroup = new THREE.Group();
    this.group.add(this.frameAxesGroup);
    this.frameAxesGroup.visible = false;

    this.forceVectorGroup = new THREE.Group();
    this.group.add(this.forceVectorGroup);
    this.forceVectorGroup.visible = false;

    this.torqueGroup = new THREE.Group();
    this.group.add(this.torqueGroup);
    this.torqueGroup.visible = false;

    scene.add(this.group);
  }

  private makeThickLink(color: number): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(LINK_RADIUS, LINK_RADIUS, 1, 8);
    const mat = new THREE.MeshBasicMaterial({ color });
    return new THREE.Mesh(geo, mat);
  }

  setTarget(position: Vec2 | null, reached?: boolean): void {
    if (position === null) {
      this.targetGroup.visible = false;
      this._targetVisible = false;
      return;
    }
    this._targetVisible = true;
    this._targetReached = reached ?? false;
    this.targetGroup.visible = true;
    this.targetGroup.position.set(position.x, position.y, 0);

    const color = this._targetReached ? TARGET_REACHED_COLOR : TARGET_COLOR;
    (this.targetRing.material as THREE.LineBasicMaterial).color.setHex(color);
    (this.targetCrossH.material as THREE.LineBasicMaterial).color.setHex(color);
    (this.targetCrossV.material as THREE.LineBasicMaterial).color.setHex(color);
  }

  update(
    j1: Vec2,
    j2: Vec2,
    j3: Vec2,
    j4: Vec2,
    c1: Vec2,
    c2: Vec2,
    residual?: Residual3D,
  ): void {
    this.jointPositions = [j1, j2, j3, j4];

    this.updateLink(this.groundBar, j1, j2, -0.02);
    this.updateLink(this.link1, j1, j3, -0.01);
    this.updateLink(this.link3, j2, j4, -0.01);
    this.updateLink(this.link2, j3, c1, -0.01);
    this.updateLink(this.link4, j4, c2, -0.01);

    this.pivot1.position.set(j1.x, j1.y, 0);
    this.pivot2.position.set(j2.x, j2.y, 0);
    this.joint3.position.set(j3.x, j3.y, 0);
    this.joint4.position.set(j4.x, j4.y, 0);
    this.endpoint1.position.set(c1.x, c1.y, 0);
    this.endpoint2.position.set(c2.x, c2.y, 0);

    this.updateArrow(c1, c2, residual);
    this.updateFrameAxes(j1, j2, j3, j4, c1, c2);
  }

  private updateLink(link: THREE.Mesh, a: Vec2, b: Vec2, zOffset: number = -0.01): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) {
      link.visible = false;
      return;
    }
    link.visible = true;
    link.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, zOffset);
    link.scale.set(1, len, 1);
    link.rotation.set(0, 0, Math.atan2(-dx, dy));
  }

  private updateArrow(c1: Vec2, c2: Vec2, residual?: Residual3D): void {
    const dx = c1.x - c2.x;
    const dy = c1.y - c2.y;
    const norm = Math.sqrt(dx * dx + dy * dy);

    if (norm < 1e-12) {
      this.arrowGroup.visible = false;
      return;
    }

    this.arrowGroup.visible = true;

    const pos = this.arrowLine.geometry.attributes.position.array as Float32Array;
    pos[0] = c2.x;
    pos[1] = c2.y;
    pos[2] = 0;
    pos[3] = c1.x;
    pos[4] = c1.y;
    pos[5] = 0;
    this.arrowLine.geometry.attributes.position.needsUpdate = true;

    const nx = dx / norm;
    const ny = dy / norm;

    const isClosedState = residual ? residual.norm < 1e-6 : norm < 1e-6;
    const color = isClosedState ? CLOSED_COLOR : VIOLATED_COLOR;
    (this.arrowLine.material as THREE.LineBasicMaterial).color.setHex(color);
    (this.arrowHead.material as THREE.MeshBasicMaterial).color.setHex(color);

    const scaledWidth = Math.min(MAX_ARROW_WIDTH, MIN_ARROW_WIDTH + norm * 1.5);
    this.arrowHead.scale.set(
      Math.min(3, Math.max(0.5, norm * 5)),
      Math.min(3, Math.max(0.5, norm * 5)),
      Math.min(3, Math.max(0.5, norm * 5)),
    );

    const headLen = ARROW_HEAD_LENGTH;
    const headX = c1.x - nx * headLen / 2;
    const headY = c1.y - ny * headLen / 2;
    this.arrowHead.position.set(
      c1.x - nx * headLen / 2,
      c1.y - ny * headLen / 2,
      0,
    );

    const angle = Math.atan2(ny, nx);
    this.arrowHead.rotation.set(0, 0, angle - Math.PI / 2);
  }

  private updateFrameAxes(
    j1: Vec2, j2: Vec2, j3: Vec2, j4: Vec2,
    c1: Vec2, c2: Vec2,
  ): void {
    if (!this._frameAxesVisible) return;

    while (this.frameAxesGroup.children.length > 0) {
      const child = this.frameAxesGroup.children[0];
      if ("geometry" in child) (child as any).geometry?.dispose?.();
      if ("material" in child) (child as any).material?.dispose?.();
      this.frameAxesGroup.remove(child);
    }

    const points = [j1, j2, j3, j4, c1, c2];
    const size = 0.3;
    for (const p of points) {
      const ax = new THREE.AxesHelper(size);
      ax.position.set(p.x, p.y, 0);
      this.frameAxesGroup.add(ax);
    }
  }

  setFrameAxesVisible(visible: boolean): void {
    this._frameAxesVisible = visible;
    this.frameAxesGroup.visible = visible;
  }

  private clearGroup(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children[0];
      if ("geometry" in child) (child as any).geometry?.dispose?.();
      if ("material" in child) (child as any).material?.dispose?.();
      group.remove(child);
    }
  }

  setJointTorques(data: { torques: Float64Array; activeIndices: number[] } | null): void {
    this.clearGroup(this.torqueGroup);

    if (data === null || this.jointPositions.length < 4) {
      this.torqueGroup.visible = false;
      return;
    }
    this.torqueGroup.visible = true;

    const maxAbsTorque = Math.max(0.01, ...Array.from(data.torques).map(Math.abs));
    const torqueColor = 0x9c27b0;
    const segs = 14;
    const baseRadius = 0.1;
    const maxRadius = 0.35;

    for (let j = 0; j < data.activeIndices.length; j++) {
      const jointIdx = data.activeIndices[j];
      const jointPos = this.jointPositions[jointIdx];
      const tau = data.torques[j];
      const absTau = Math.abs(tau);
      if (absTau < 1e-10) continue;

      const isCCW = tau > 0;
      const t = Math.min(absTau / maxAbsTorque, 1);
      const radius = baseRadius + t * (maxRadius - baseRadius);
      const sweep = Math.PI * (0.3 + t * 0.4);

      const startAngle = isCCW ? -Math.PI / 2 - sweep / 2 : Math.PI / 2 + sweep / 2;
      const endAngle = isCCW ? -Math.PI / 2 + sweep / 2 : Math.PI / 2 - sweep / 2;
      const step = (endAngle - startAngle) / segs;

      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= segs; i++) {
        const a = startAngle + step * i;
        points.push(new THREE.Vector3(
          jointPos.x + radius * Math.cos(a),
          jointPos.y + radius * Math.sin(a),
          0.01,
        ));
      }

      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color: torqueColor, linewidth: 1 }),
      );
      this.torqueGroup.add(line);

      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      const dir = new THREE.Vector3().subVectors(last, prev).normalize();
      const headLen = 0.04 + t * 0.04;
      const headWid = headLen * 0.5;
      const arrow = new THREE.ArrowHelper(dir, last, headLen, torqueColor, headLen, headWid);
      this.torqueGroup.add(arrow);
    }
  }

  setForceVector(force: { x: number; y: number; Fx: number; Fy: number } | null): void {
    if (force === null) {
      this.forceVectorGroup.visible = false;
      this._forceVectorVisible = false;
      return;
    }
    this._forceVectorVisible = true;
    this.forceVectorGroup.visible = true;

    while (this.forceVectorGroup.children.length > 0) {
      const child = this.forceVectorGroup.children[0];
      if ("geometry" in child) (child as any).geometry?.dispose?.();
      if ("material" in child) (child as any).material?.dispose?.();
      this.forceVectorGroup.remove(child);
    }

    const origin = new THREE.Vector3(force.x, force.y, 0);
    const dir = new THREE.Vector3(force.Fx, force.Fy, 0);
    const len = dir.length();
    if (len < 1e-10) return;
    const norm = dir.clone().divideScalar(len);

    const scale = Math.min(len, 2.0);
    const arrowLen = Math.max(scale * 0.4, 0.15);
    const headLen = Math.min(arrowLen * 0.3, 0.12);
    const headWid = headLen * 0.5;

    const arrow = new THREE.ArrowHelper(norm, origin, arrowLen, 0x9c27b0, headLen, headWid);
    this.forceVectorGroup.add(arrow);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.groundBar.geometry.dispose();
    this.link1.geometry.dispose();
    this.link2.geometry.dispose();
    this.link3.geometry.dispose();
    this.link4.geometry.dispose();
    this.pivot1.geometry.dispose();
    this.pivot2.geometry.dispose();
    this.joint3.geometry.dispose();
    this.joint4.geometry.dispose();
    this.endpoint1.geometry.dispose();
    this.endpoint2.geometry.dispose();
    this.arrowLine.geometry.dispose();
    this.arrowHead.geometry.dispose();
    (this.arrowLine.material as THREE.LineBasicMaterial).dispose();
    (this.arrowHead.material as THREE.MeshBasicMaterial).dispose();
    this.clearGroup(this.forceVectorGroup);
    this.clearGroup(this.torqueGroup);
  }
}
