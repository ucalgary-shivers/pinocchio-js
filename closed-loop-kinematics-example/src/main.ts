import * as THREE from "three";
import { createScene } from "./scene";
import { createAdapter, DEFAULT_CLOSED_Q, DEFAULT_PARAMS } from "./pinocchio-adapter";
import type { MechanismParams } from "./pinocchio-adapter";
import { MechanismView } from "./mechanism-view";
import { computeClosure } from "./closure-model";
import type { Residual3D } from "./closure-model";
import { solveClosureDLS } from "./dls-solver";
import { PRESETS, applyPreset } from "./presets";
import type { Preset } from "./presets";
import { computeNumericalJacobian } from "./numerical-jacobian";
import { DEFAULT_SOLVER_CONFIG } from "./types";
import type { SolverConfig, SolverResult, JointBounds, JacobianSource } from "./types";
import {
  makeTargetResidual,
  makeTargetJacobian,
  estimateConditioning,
  hasConditioningWarning,
} from "./target-ik";
import { computeForceTorque } from "./force-torque";
import type { ForceTorqueResult } from "./force-torque";

type AppMode = "fk" | "project" | "target-ik" | "force-torque";

function setStatus(ok: boolean, message: string) {
  const dot = document.getElementById("status-dot")!;
  const msg = document.getElementById("status-msg")!;
  dot.className = `dot ${ok ? "ok" : "err"}`;
  msg.textContent = message;
}

function setBusy(message: string) {
  const dot = document.getElementById("status-dot")!;
  const msg = document.getElementById("status-msg")!;
  dot.className = "dot busy";
  msg.textContent = message;
}

function updateResidualDisplay(residual: Residual3D) {
  const dxEl = document.getElementById("residual-dx");
  const dyEl = document.getElementById("residual-dy");
  const dzEl = document.getElementById("residual-dz");
  const normEl = document.getElementById("residual-norm");
  const dzRow = document.getElementById("residual-dz-row");

  if (dxEl) dxEl.textContent = residual.dx.toFixed(6);
  if (dyEl) dyEl.textContent = residual.dy.toFixed(6);
  if (dzEl) dzEl.textContent = residual.dz.toFixed(6);
  if (normEl) {
    normEl.textContent = residual.norm.toFixed(6);
    const status = residual.norm < 1e-6 ? "closed" : "violated";
    normEl.className = `residual-${status}`;
  }
  if (dzRow) {
    const showDz = (document.getElementById("toggle-dz") as HTMLInputElement)?.checked;
    dzRow.style.display = showDz ? "" : "none";
  }
}

async function main() {
  const container = document.getElementById("canvas-container")!;

  const { scene, camera, renderer, animate, resize } = createScene(container);

  setBusy("Loading Pinocchio WASM…");

  let adapter: Awaited<ReturnType<typeof createAdapter>>;

  try {
    adapter = await createAdapter();
    setStatus(true, `Pinocchio-js v1.2.2 — WASM initialized`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(false, `WASM initialization failed: ${msg}`);
    return;
  }

  const view = new MechanismView(scene);
  const q = new Float64Array(DEFAULT_CLOSED_Q);

  const jointNames = ["J1", "J2", "J3", "J4"];

  const solverAdjustable: boolean[] = [true, true, true, true];

  for (const name of jointNames) {
    const slider = document.getElementById(`slider-${name}`) as HTMLInputElement;
    const valueDisplay = document.getElementById(`value-${name}`);
    if (slider) {
      slider.addEventListener("input", () => {
        const ci = adapter.getConfigIndex(name);
        const val = parseFloat(slider.value);
        q[ci] = val;
        if (valueDisplay) valueDisplay.textContent = val.toFixed(3);
        updateView();
      });
    }
  }

  const partitionToggles = document.querySelectorAll(".partition-toggle");
  partitionToggles.forEach((el) => {
    const toggle = el as HTMLElement;
    const name = toggle.dataset.joint;
    if (!name) return;
    toggle.addEventListener("click", () => {
      const idx = jointNames.indexOf(name);
      if (idx === -1) return;
      solverAdjustable[idx] = !solverAdjustable[idx];
      toggle.classList.toggle("solver-adjustable", solverAdjustable[idx]);
      toggle.classList.toggle("independent", !solverAdjustable[idx]);
      toggle.title = solverAdjustable[idx]
        ? "Solver-adjustable — click to toggle"
        : "Independent — click to toggle";
      const locked = !solverAdjustable[idx];
      const slider = document.getElementById(`slider-${name}`) as HTMLInputElement;
      if (slider) slider.style.opacity = locked ? "0.4" : "1";
      updatePartitionWarning();
    });
  });

  function updatePartitionWarning() {
    const warning = document.getElementById("partition-warning")!;
    const hasAdjustable = solverAdjustable.some(Boolean);
    warning.style.display = hasAdjustable ? "none" : "";
  }

  function getActiveIndices(): number[] {
    const active: number[] = [];
    for (let i = 0; i < solverAdjustable.length; i++) {
      if (solverAdjustable[i]) active.push(i);
    }
    return active;
  }

  const toggleDz = document.getElementById("toggle-dz") as HTMLInputElement;
  if (toggleDz) {
    toggleDz.addEventListener("change", () => updateView());
  }

  const toggleAxes = document.getElementById("toggle-axes") as HTMLInputElement;
  if (toggleAxes) {
    toggleAxes.addEventListener("change", () => {
      view.setFrameAxesVisible(toggleAxes.checked);
    });
  }

  const jacobianStatusEls = [
    document.getElementById("jacobian-status"),
    document.getElementById("tik-jacobian-status"),
  ].filter(Boolean) as HTMLElement[];

  const jointBounds: JointBounds[] = [
    { min: -10 * Math.PI, max: 10 * Math.PI },
    { min: -10 * Math.PI, max: 10 * Math.PI },
    { min: -10 * Math.PI, max: 10 * Math.PI },
    { min: -10 * Math.PI, max: 10 * Math.PI },
  ];

  let solverConfig: SolverConfig = {
    ...DEFAULT_SOLVER_CONFIG,
    tolerance: 1e-6,
  };

  let jacobianSource: JacobianSource = "finite-difference";

  const jacobianToggle = document.getElementById("toggle-jacobian") as HTMLInputElement;
  const jacobianLabel = document.getElementById("jacobian-source-label");
  if (jacobianToggle) {
    jacobianToggle.addEventListener("change", () => {
      jacobianSource = jacobianToggle.checked ? "analytic" : "finite-difference";
      if (jacobianLabel) jacobianLabel.textContent = jacobianSource === "analytic" ? "Analytic" : "Finite Diff.";
    });
  }
  if (jacobianLabel) jacobianLabel.textContent = "Finite Diff.";

  function closureResidual(q: Float64Array): Float64Array {
    const ep = adapter.fk(q);
    return new Float64Array([ep.c1.x - ep.c2.x, ep.c1.y - ep.c2.y]);
  }

  function closureJacobian(q: Float64Array, active: number[]): Float64Array {
    if (jacobianSource === "analytic") {
      return adapter.analyticClosureJacobian(q, active);
    }
    return computeNumericalJacobian(closureResidual, q, active, solverConfig.fdStep);
  }

  function updateSolverDiagnostics(result: SolverResult) {
    const statusEl = document.getElementById("solve-status");
    const itersEl = document.getElementById("solve-iters");
    const residualEl = document.getElementById("solve-residual");
    const timeEl = document.getElementById("solve-time");

    if (statusEl) {
      statusEl.textContent = result.converged ? "Converged ✓" : `Failed — ${result.reason}`;
      statusEl.className = `value ${result.converged ? "" : "fail"}`;
    }
    if (itersEl) itersEl.textContent = String(result.iterations);
    if (residualEl) residualEl.textContent = result.finalResidual.toExponential(3);
    if (timeEl) timeEl.textContent = result.solveTimeMs.toFixed(2);

    for (const el of jacobianStatusEls) {
      el.textContent = jacobianSource === "analytic" ? "Analytic" : "Finite Diff.";
    }
  }

  function syncSlidersFromQ() {
    for (const name of jointNames) {
      const ci = adapter.getConfigIndex(name);
      const slider = document.getElementById(`slider-${name}`) as HTMLInputElement;
      const valueDisplay = document.getElementById(`value-${name}`);
      if (slider) {
        slider.value = q[ci].toFixed(3);
        if (valueDisplay) valueDisplay.textContent = q[ci].toFixed(3);
      }
    }
  }

  const btnProject = document.getElementById("btn-project") as HTMLButtonElement;
  if (btnProject) {
    btnProject.addEventListener("click", () => {
      const tolInput = document.getElementById("solver-tolerance") as HTMLInputElement;
      const dampInput = document.getElementById("solver-damping") as HTMLInputElement;
      const maxIterInput = document.getElementById("solver-max-iters") as HTMLInputElement;

      solverConfig = {
        ...solverConfig,
        tolerance: parseFloat(tolInput?.value || "1e-6"),
        damping: parseFloat(dampInput?.value || "1e-6"),
        maxIterations: parseInt(maxIterInput?.value || "50", 10),
      };

      btnProject.disabled = true;
      btnProject.textContent = "Solving…";

      setTimeout(() => {
        const result = solveClosureDLS(
          closureResidual,
          closureJacobian,
          q,
          getActiveIndices(),
          jointBounds,
          solverConfig,
        );

        q.set(result.q);
        updateSolverDiagnostics(result);
        syncSlidersFromQ();
        updateView();

        btnProject.disabled = false;
        btnProject.textContent = "Project to Closure";
      }, 0);
    });
  }

  let appMode: AppMode = "fk";

  let targetX = 0;
  let targetY = 0;
  let latestTargetX = 0;
  let latestTargetY = 0;
  let solving = false;
  let solveRequested = false;
  let lastTargetIKResult: SolverResult | null = null;
  let lastConditioningRatio = 1;

  function getTarget() {
    return { x: targetX, y: targetY };
  }

  const targetResidualFn = makeTargetResidual(
    (q: Float64Array) => adapter.fk(q),
    getTarget,
  );

  function targetJacobianFn(q: Float64Array, active: number[]): Float64Array {
    if (jacobianSource === "analytic") {
      return adapter.analyticTargetJacobian(q, active);
    }
    return makeTargetJacobian(
      (qq: Float64Array) => adapter.fk(qq),
      solverConfig.fdStep,
    )(q, active);
  }

  function updateTargetIKDiagnostics(result: SolverResult | null) {
    const targetEl = document.getElementById("tik-target");
    const statusEl = document.getElementById("tik-status");
    const itersEl = document.getElementById("tik-iters");
    const residualEl = document.getElementById("tik-residual");
    const timeEl = document.getElementById("tik-time");
    const nonconvergeWarn = document.getElementById("tik-nonconverge-warning");
    const conditioningWarn = document.getElementById("tik-conditioning-warning");

    if (targetEl) targetEl.textContent = `(${targetX.toFixed(3)}, ${targetY.toFixed(3)})`;

    if (!result) {
      if (statusEl) { statusEl.textContent = "—"; statusEl.className = "value"; }
      if (itersEl) itersEl.textContent = "—";
      if (residualEl) residualEl.textContent = "—";
      if (timeEl) timeEl.textContent = "—";
      if (nonconvergeWarn) nonconvergeWarn.classList.remove("visible");
      if (conditioningWarn) conditioningWarn.classList.remove("visible");
      return;
    }

    if (statusEl) {
      statusEl.textContent = result.converged ? "Converged ✓" : `Failed — ${result.reason}`;
      statusEl.className = `value ${result.converged ? "converged" : "fail"}`;
    }
    if (itersEl) itersEl.textContent = String(result.iterations);
    if (residualEl) residualEl.textContent = result.finalResidual.toExponential(3);
    if (timeEl) timeEl.textContent = result.solveTimeMs.toFixed(2);

    if (nonconvergeWarn) {
      nonconvergeWarn.classList.toggle("visible", !result.converged);
    }

    const conditioningBad = hasConditioningWarning(lastConditioningRatio);
    if (conditioningWarn) {
      conditioningWarn.classList.toggle("visible", conditioningBad);
    }

    for (const el of jacobianStatusEls) {
      el.textContent = jacobianSource === "analytic" ? "Analytic" : "Finite Diff.";
    }
  }

  function doTargetIKSolve() {
    if (solving) return;
    solving = true;

    const active = getActiveIndices();
    if (active.length === 0) {
      lastTargetIKResult = {
        converged: false,
        q: new Float64Array(q),
        iterations: 0,
        finalResidual: 0,
        reason: "No active joints to adjust",
        solveTimeMs: 0,
      };
      solving = false;
      updateTargetIKDiagnostics(lastTargetIKResult);
      return;
    }

    targetX = latestTargetX;
    targetY = latestTargetY;

    lastConditioningRatio = estimateConditioning(
      (q: Float64Array) => adapter.fk(q),
      q,
      active,
      solverConfig.fdStep,
    );

    const result = solveClosureDLS(
      targetResidualFn,
      targetJacobianFn,
      q,
      active,
      jointBounds,
      solverConfig,
    );

    q.set(result.q);
    lastTargetIKResult = result;

    syncSlidersFromQ();
    updateView();
    updateTargetIKDiagnostics(result);

    solving = false;

    if (solveRequested) {
      solveRequested = false;
      requestAnimationFrame(doTargetIKSolve);
    }
  }

  function requestTargetIKSolve() {
    if (solving) {
      solveRequested = true;
      return;
    }
    requestAnimationFrame(doTargetIKSolve);
  }

  function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const vec = new THREE.Vector3(ndcX, ndcY, 0);
    vec.unproject(camera);
    return { x: vec.x, y: vec.y };
  }

  function handlePointerDown(event: PointerEvent) {
    if (appMode !== "target-ik") return;
    const pos = screenToWorld(event.clientX, event.clientY);
    latestTargetX = pos.x;
    latestTargetY = pos.y;
    targetX = pos.x;
    targetY = pos.y;
    renderer.domElement.setPointerCapture(event.pointerId);
    requestTargetIKSolve();
  }

  function handlePointerMove(event: PointerEvent) {
    if (appMode !== "target-ik") return;
    if (!renderer.domElement.hasPointerCapture(event.pointerId)) return;
    const pos = screenToWorld(event.clientX, event.clientY);
    latestTargetX = pos.x;
    latestTargetY = pos.y;
    requestTargetIKSolve();
  }

  function handlePointerUp(event: PointerEvent) {
    if (appMode !== "target-ik") return;
    renderer.domElement.releasePointerCapture(event.pointerId);
    if (solving || solveRequested) {
      solveRequested = false;
      setTimeout(() => {
        targetX = latestTargetX;
        targetY = latestTargetY;
        requestTargetIKSolve();
      }, 0);
    }
  }

  function setMode(mode: AppMode) {
    appMode = mode;

    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.classList.remove("active", "target-ik-mode", "force-torque-mode");
    });

    if (mode === "target-ik") {
      document.getElementById("mode-target-ik")?.classList.add("active", "target-ik-mode");
    } else if (mode === "force-torque") {
      document.getElementById("mode-force-torque")?.classList.add("active", "force-torque-mode");
    } else {
      document.getElementById(`mode-${mode}`)?.classList.add("active");
    }

    const controls = document.getElementById("controls")!;
    const solverPanel = document.getElementById("solver-panel")!;
    const targetIKPanel = document.getElementById("target-ik-panel")!;
    const geometryPanel = document.getElementById("geometry-panel")!;
    const forceTorquePanel = document.getElementById("force-torque-panel")!;

    controls.style.display = "flex";
    geometryPanel.style.display = "";

    if (mode === "fk") {
      solverPanel.style.display = "";
      targetIKPanel.style.display = "none";
      forceTorquePanel.style.display = "none";
      view.setTarget(null);
      view.setForceVector(null);
      view.setJointTorques(null);
    } else if (mode === "project") {
      solverPanel.style.display = "";
      targetIKPanel.style.display = "none";
      forceTorquePanel.style.display = "none";
      view.setTarget(null);
      view.setForceVector(null);
      view.setJointTorques(null);
    } else if (mode === "target-ik") {
      solverPanel.style.display = "none";
      targetIKPanel.style.display = "";
      forceTorquePanel.style.display = "none";
      view.setForceVector(null);
      view.setJointTorques(null);
      targetX = latestTargetX !== 0 ? latestTargetX : (adapter.fk(q).c1.x + adapter.fk(q).c2.x) / 2;
      targetY = latestTargetY !== 0 ? latestTargetY : (adapter.fk(q).c1.y + adapter.fk(q).c2.y) / 2;
      latestTargetX = targetX;
      latestTargetY = targetY;
      view.setTarget({ x: targetX, y: targetY });
      updateTargetIKDiagnostics(lastTargetIKResult);
      requestTargetIKSolve();
    } else {
      solverPanel.style.display = "none";
      targetIKPanel.style.display = "none";
      forceTorquePanel.style.display = "";
      view.setTarget(null);
      updateForceTorqueDisplay();
    }

    updateView();
  }

  document.getElementById("mode-fk")?.addEventListener("click", () => setMode("fk"));
  document.getElementById("mode-project")?.addEventListener("click", () => setMode("project"));
  document.getElementById("mode-target-ik")?.addEventListener("click", () => setMode("target-ik"));
  document.getElementById("mode-force-torque")?.addEventListener("click", () => setMode("force-torque"));

  renderer.domElement.addEventListener("pointerdown", handlePointerDown);
  renderer.domElement.addEventListener("pointermove", handlePointerMove);
  renderer.domElement.addEventListener("pointerup", handlePointerUp);

  function updateView() {
    const ep = adapter.fk(q);
    const j1p = adapter.getJointPlacement("J1");
    const j2p = adapter.getJointPlacement("J2");
    const j3p = adapter.getJointPlacement("J3");
    const j4p = adapter.getJointPlacement("J4");

    const result = computeClosure(adapter, q);
    updateResidualDisplay(result.residual);

    view.update(
      { x: j1p.x, y: j1p.y },
      { x: j2p.x, y: j2p.y },
      { x: j3p.x, y: j3p.y },
      { x: j4p.x, y: j4p.y },
      result.c1,
      result.c2,
      result.residual,
    );

    if (appMode === "target-ik") {
      const targetResult = lastTargetIKResult;
      const reached = targetResult ? targetResult.converged : false;
      view.setTarget({ x: targetX, y: targetY }, reached);
    } else if (appMode === "force-torque") {
      updateForceTorqueDisplay();
    }
  }

  function syncPartitionUI() {
    for (let i = 0; i < jointNames.length; i++) {
      const name = jointNames[i];
      const toggle = document.querySelector(`.partition-toggle[data-joint="${name}"]`) as HTMLElement | null;
      const slider = document.getElementById(`slider-${name}`) as HTMLInputElement;
      if (toggle) {
        toggle.classList.toggle("solver-adjustable", solverAdjustable[i]);
        toggle.classList.toggle("independent", !solverAdjustable[i]);
        toggle.title = solverAdjustable[i]
          ? "Solver-adjustable — click to toggle"
          : "Independent — click to toggle";
      }
      if (slider) slider.style.opacity = solverAdjustable[i] ? "1" : "0.4";
    }
  }
  syncPartitionUI();
  updatePartitionWarning();

  updateView();

  function syncGeometryInputs() {
    const p = adapter.params;
    setNumericInput("geo-link1Length", p.link1Length);
    setNumericInput("geo-link2Length", p.link2Length);
    setNumericInput("geo-link3Length", p.link3Length);
    setNumericInput("geo-link4Length", p.link4Length);
    setNumericInput("geo-pivot1X", p.pivot1X);
    setNumericInput("geo-pivot1Y", p.pivot1Y);
    setNumericInput("geo-pivot2X", p.pivot2X);
    setNumericInput("geo-pivot2Y", p.pivot2Y);
  }

  function setNumericInput(id: string, value: number) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value.toFixed(3);
  }

  function readGeometryFromInputs(): Partial<MechanismParams> {
    return {
      link1Length: parseFloat((document.getElementById("geo-link1Length") as HTMLInputElement)?.value || "1.0"),
      link2Length: parseFloat((document.getElementById("geo-link2Length") as HTMLInputElement)?.value || "1.0"),
      link3Length: parseFloat((document.getElementById("geo-link3Length") as HTMLInputElement)?.value || "1.0"),
      link4Length: parseFloat((document.getElementById("geo-link4Length") as HTMLInputElement)?.value || "1.0"),
      pivot1X: parseFloat((document.getElementById("geo-pivot1X") as HTMLInputElement)?.value || "-0.5"),
      pivot1Y: parseFloat((document.getElementById("geo-pivot1Y") as HTMLInputElement)?.value || "0.0"),
      pivot2X: parseFloat((document.getElementById("geo-pivot2X") as HTMLInputElement)?.value || "0.5"),
      pivot2Y: parseFloat((document.getElementById("geo-pivot2Y") as HTMLInputElement)?.value || "0.0"),
    };
  }

  const geometryInputIds = [
    "geo-link1Length", "geo-link2Length", "geo-link3Length", "geo-link4Length",
    "geo-pivot1X", "geo-pivot1Y", "geo-pivot2X", "geo-pivot2Y",
  ];
  for (const id of geometryInputIds) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.addEventListener("change", () => {
        adapter.rebuild(readGeometryFromInputs());
        syncSlidersFromQ();
        updateView();
      });
      el.addEventListener("input", () => {
        adapter.rebuild(readGeometryFromInputs());
        syncSlidersFromQ();
        updateView();
      });
    }
  }

  syncGeometryInputs();

  function clearSolverDiagnostics() {
    const statusEl = document.getElementById("solve-status");
    const itersEl = document.getElementById("solve-iters");
    const residualEl = document.getElementById("solve-residual");
    const timeEl = document.getElementById("solve-time");
    if (statusEl) { statusEl.textContent = "—"; statusEl.className = "value"; }
    if (itersEl) itersEl.textContent = "—";
    if (residualEl) residualEl.textContent = "—";
    if (timeEl) timeEl.textContent = "—";
  }

  const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
  if (btnReset) {
    btnReset.addEventListener("click", () => {
      adapter.rebuild(DEFAULT_PARAMS);
      q.set(DEFAULT_CLOSED_Q);
      syncSlidersFromQ();
      syncGeometryInputs();
      solverAdjustable[0] = true;
      solverAdjustable[1] = true;
      solverAdjustable[2] = true;
      solverAdjustable[3] = true;
      syncPartitionUI();
      updatePartitionWarning();
      setMode("fk");
      updateView();
    });
  }

  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement;
  const presetDescription = document.getElementById("preset-description") as HTMLElement;
  const btnLoadPreset = document.getElementById("btn-load-preset") as HTMLButtonElement;

  if (presetSelect) {
    for (const preset of PRESETS) {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      presetSelect.appendChild(option);
    }

    presetSelect.addEventListener("change", () => {
      const preset = PRESETS.find((p) => p.name === presetSelect.value);
      if (preset && presetDescription) {
        presetDescription.textContent = preset.description;
      }
    });

    if (PRESETS.length > 0 && presetDescription) {
      presetDescription.textContent = PRESETS[0].description;
    }
  }

  if (btnLoadPreset) {
    btnLoadPreset.addEventListener("click", () => {
      const name = presetSelect?.value;
      const preset = PRESETS.find((p) => p.name === name);
      if (!preset) return;

      if (adapter) adapter.rebuild(preset.params);

      const state = applyPreset(preset, q);
      syncSlidersFromQ();
      syncGeometryInputs();

      for (let i = 0; i < solverAdjustable.length; i++) {
        solverAdjustable[i] = state.solverAdjustable[i] ?? false;
      }
      syncPartitionUI();
      updatePartitionWarning();

      lastTargetIKResult = null;
      updateTargetIKDiagnostics(null);

      clearSolverDiagnostics();

      if (state.target) {
        targetX = state.target.x;
        targetY = state.target.y;
        latestTargetX = state.target.x;
        latestTargetY = state.target.y;
      } else {
        targetX = 0;
        targetY = 0;
        latestTargetX = 0;
        latestTargetY = 0;
      }

      setMode(state.mode);
      updateView();
    });
  }

  let lastForceTorqueResult: ForceTorqueResult | null = null;

  function readForceInputs(): { Fx: number; Fy: number } {
    const fxEl = document.getElementById("ft-fx") as HTMLInputElement;
    const fyEl = document.getElementById("ft-fy") as HTMLInputElement;
    return {
      Fx: parseFloat(fxEl?.value || "1.0"),
      Fy: parseFloat(fyEl?.value || "0.0"),
    };
  }

  function updateForceTorqueDisplay() {
    const { Fx, Fy } = readForceInputs();
    const active = getActiveIndices();
    if (active.length === 0) return;

    const result = computeForceTorque(adapter, q, active, Fx, Fy);
    lastForceTorqueResult = result;
    const rj = result.reducedJacobian;

    const detEl = document.getElementById("ft-det");
    if (detEl) detEl.textContent = rj.det.toExponential(3);

    const pcEl = document.getElementById("ft-pc");
    if (pcEl) pcEl.textContent = `(${result.pC.x.toFixed(4)}, ${result.pC.y.toFixed(4)})`;

    const jredEl = document.getElementById("ft-jred");
    if (jredEl) {
      let s = "";
      for (let j = 0; j < rj.numActive; j++) {
        s += `[${rj.J_red[j*2+0].toFixed(3)} ${rj.J_red[j*2+1].toFixed(3)}] `;
      }
      jredEl.textContent = s || "—";
    }

    for (let i = 0; i < 4; i++) {
      const tauEl = document.getElementById(`ft-tau-J${i + 1}`);
      if (tauEl) {
        const idx = active.indexOf(i);
        tauEl.textContent = idx >= 0 ? result.torques[idx].toFixed(6) : "(passive)";
      }
    }

    view.setForceVector({ x: result.pC.x, y: result.pC.y, Fx, Fy });
    view.setJointTorques({ torques: result.torques, activeIndices: active });
  }

  const ftFxInput = document.getElementById("ft-fx") as HTMLInputElement;
  const ftFyInput = document.getElementById("ft-fy") as HTMLInputElement;
  if (ftFxInput) {
    ftFxInput.addEventListener("input", () => {
      if (appMode === "force-torque") updateForceTorqueDisplay();
    });
  }
  if (ftFyInput) {
    ftFyInput.addEventListener("input", () => {
      if (appMode === "force-torque") updateForceTorqueDisplay();
    });
  }

  window.addEventListener("resize", resize);

  function frame() {
    animate();
    requestAnimationFrame(frame);
  }
  frame();
}

main();
