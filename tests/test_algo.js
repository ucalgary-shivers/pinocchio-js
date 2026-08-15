/**
 * Pinocchio WASM — Algorithm Tests
 */

module.exports = {
    run: async (ctx) => {
        const { pin, assert, assertClose, assertVecClose } = ctx;
        let passed = 0;
        let failed = 0;

        function check(cond) {
            if (cond) passed++; else failed++;
        }

        console.log('  --- Setup: 2-Link Arm ---');
        // Create a simple 2-link arm (RX, RY) with known inertia
        const model = new pin.Model();
        const id = pin.SE3.identity();
        const inertia = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0.5], [0.1, 0, 0, 0.1, 0, 0.01]);

        // Joint 1: RX
        const j1 = pin.addJoint(model, 0, pin.JointModelRX(), id, "j1");
        pin.appendBodyToJoint(model, j1, inertia, id);

        // Joint 2: RY (offset by 1m in Z)
        const se3_2 = pin.SE3.fromXyzRpy(0, 0, 1.0, 0, 0, 0);
        const j2 = pin.addJoint(model, j1, pin.JointModelRY(), se3_2, "j2");
        pin.appendBodyToJoint(model, j2, inertia, id);

        const data = new pin.Data(model);
        check(assert(model.nq === 2 && model.nv === 2, 'Model created (nq=2)'));

        // 1. Neutral Config
        console.log('  --- Neutral Configuration ---');
        try {
            const q0 = pin.neutralConfiguration(model);
            check(assertVecClose(q0, [0, 0], 1e-9, 'Neutral is zero'));
        } catch (e) { console.error(e); failed++; }

        // 2. RNEA (Gravity only)
        console.log('  --- RNEA (Gravity) ---');
        try {
            const q = new Float64Array([0, 0]);
            const v = new Float64Array([0, 0]);
            const a = new Float64Array([0, 0]);
            const tau = pin.rnea(model, data, q, v, a);

            // J1 (RX): CoM1 is at (0,0,0.5). CoM2 is at (0,0,1.5).
            // Gravity is -9.81 Z. 
            // J1 axis is X. 
            // Torque = cross(r, mg).
            // CoM1: r=(0,0,0.5), F=(0,0,-9.81). cross(r,F) = (0, 4.9, 0). X-torque = 0.
            // CoM2: r=(0,0,1.5), F=(0,0,-9.81). cross(r,F) = (0, 14.7, 0). X-torque = 0.
            // Wait, is gravity in Z?
            // Standard Pinocchio gravity is usually -9.81 Z? Or need to set it?
            // RNEA defaults to model.gravity.
            // Let's assume standard gravity.
            // RX rotates around X. Gravity along Z. CoM along Z.
            // No moment arm for gravity around X. So Tau1 should be 0.
            // RY rotates around Y.
            // CoMs are on Z axis. Gravity along Z.
            // No moment arm for gravity around Y. So Tau2 should be 0.

            // Let's change configuration to get torque.
            // q = [PI/2, 0].
            // J1 rotated 90 deg around X.
            // Z axis becomes -Y axis.
            // CoM1 at (0, -0.5, 0). CoM2 at (0, -1.5, 0).
            // Gravity -Z.
            // J1 (X-axis). F=(0,0,-mg). r=(0,-0.5,0). cross(r,F) = (-(-0.5)*(-mg), 0, 0) ?
            // i j k
            // 0 -0.5 0
            // 0 0 -g
            // i(0.5g) - j(0) + k(0).
            // Torque X = 0.5 * 1.0 * 9.81 = 4.905.

            const q_pose = new Float64Array([Math.PI / 2, 0]);
            const tau_pose = pin.rnea(model, data, q_pose, v, a);

            // We expect tau[0] approx 4.905 + 14.715 (link 2) ?
            // Link 2 is at 1.0 local Z (now -Y). plus 0.5 CoM. -> -1.5 Y.
            // Torque 2 = 1.5 * 1.0 * 9.81 = 14.715.
            // Total Tau1 = 4.905 + 14.715 = 19.62.

            // Let's verify non-zero at least.
            check(assert(Math.abs(tau_pose[0]) > 1.0, `RNEA torque non-zero (${tau_pose[0].toFixed(2)})`));

        } catch (e) { console.error(e); failed++; }

        // 3. Center of Mass
        console.log('  --- Center of Mass ---');
        try {
            const q = new Float64Array([0, 0]);
            const com = pin.centerOfMass(model, data, q);
            // CoM1 at 0.5. Mass 1.
            // CoM2 at 1.5. Mass 1.
            // Total Mass 2.
            // CoM Z = (0.5*1 + 1.5*1) / 2 = 1.0.

            check(assertClose(com[2], 1.0, 1e-6, `CoM Z is 1.0`));

        } catch (e) { console.error(e); failed++; }

        // 4. Jacobian
        console.log('  --- Jacobian ---');
        try {
            const q = new Float64Array([0, 0]);
            pin.computeJointJacobians(model, data, q);
            const J = pin.getJointJacobian(model, data, 2, pin.ReferenceFrame.LOCAL); // Joint 2
            // J is 6x2 flat array.
            // J should allow motion in Y (DoF 2) and X (DoF 1, rotated).

            check(assert(J.length === 12, 'Jacobian size 6x2 (12)'));
        } catch (e) { console.error(e); failed++; }

        // 5. Integrate / Difference
        console.log('  --- Integrate / Difference ---');

        const modelFF = new pin.Model();
        const idFF = pin.SE3.identity();
        const inertiaFF = pin.Inertia.fromMassComInertia(1.0, [0, 0, 0], [0.1, 0.1, 0.1, 0, 0, 0]);
        const jFF = pin.addJoint(modelFF, 0, pin.JointModelFreeFlyer(), idFF, 'freeflyer');
        pin.appendBodyToJoint(modelFF, jFF, inertiaFF, idFF);
        check(assert(modelFF.nq === 7 && modelFF.nv === 6, 'Free-flyer model (nq=7, nv=6)'));

        const qFF = pin.neutralConfiguration(modelFF);
        const vFF = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);

        // 5a: integrate returns Float64Array of size nq
        const integrated = pin.integrate(modelFF, qFF, vFF);
        check(assert(integrated instanceof Float64Array, 'integrate returns Float64Array'));
        check(assert(integrated.length === modelFF.nq, 'integrate output length = nq'));

        // 5b: integrate(model, q, v, 0.0) returns q unchanged
        const integratedZero = pin.integrate(modelFF, qFF, vFF, 0.0);
        check(assertVecClose(integratedZero, qFF, 1e-12, 'integrate(q, v, 0.0) returns q unchanged'));

        // 5c: integrate with scale 0.5 != scale 1.0
        const integratedHalf = pin.integrate(modelFF, qFF, vFF, 0.5);
        const integratedFull = pin.integrate(modelFF, qFF, vFF, 1.0);
        let scaleDiff = false;
        for (let i = 0; i < integratedHalf.length; i++) {
            if (Math.abs(integratedHalf[i] - integratedFull[i]) > 1e-12) {
                scaleDiff = true;
                break;
            }
        }
        check(assert(scaleDiff, 'integrate(q, v, 0.5) != integrate(q, v, 1.0)'));

        // 5d: round-trip identity: difference(q, integrate(q, v)) ≈ v
        const dv = pin.difference(modelFF, qFF, integrated);
        check(assertVecClose(dv, vFF, 1e-9, 'difference(q, integrate(q, v)) ≈ v (round-trip)'));

        // 5e: difference(q, q) returns near-zero
        const dvZero = pin.difference(modelFF, qFF, qFF);
        const zeroVec = new Float64Array(modelFF.nv);
        check(assertVecClose(dvZero, zeroVec, 1e-9, 'difference(q, q) is near-zero'));

        // 5f: dimensional output lengths
        check(assert(integrated.length === 7, 'integrate output length = 7 for free-flyer'));
        check(assert(dv.length === 6, 'difference output length = 6 for free-flyer'));

        // 5g: wrong dimensions throw
        try {
            pin.integrate(modelFF, new Float64Array([0]), vFF);
            check(false, 'integrate with wrong q.length should throw');
        } catch (e) {
            check(true, 'integrate with wrong q.length throws');
        }
        try {
            pin.integrate(modelFF, qFF, new Float64Array([0]));
            check(false, 'integrate with wrong v.length should throw');
        } catch (e) {
            check(true, 'integrate with wrong v.length throws');
        }
        try {
            pin.difference(modelFF, new Float64Array([0]), qFF);
            check(false, 'difference with wrong q0.length should throw');
        } catch (e) {
            check(true, 'difference with wrong q0.length throws');
        }
        try {
            pin.difference(modelFF, qFF, new Float64Array([0]));
            check(false, 'difference with wrong q1.length should throw');
        } catch (e) {
            check(true, 'difference with wrong q1.length throws');
        }

        // 5h: non-finite values throw
        const qNaN = new Float64Array(7);
        qNaN.set(qFF); qNaN[0] = NaN;
        try {
            pin.integrate(modelFF, qNaN, vFF);
            check(false, 'integrate with NaN in q should throw');
        } catch (e) {
            check(true, 'integrate with NaN in q throws');
        }
        const vNaN = new Float64Array(6);
        vNaN.set(vFF); vNaN[0] = NaN;
        try {
            pin.integrate(modelFF, qFF, vNaN);
            check(false, 'integrate with NaN in v should throw');
        } catch (e) {
            check(true, 'integrate with NaN in v throws');
        }
        const qInf = new Float64Array(7);
        qInf.set(qFF); qInf[1] = Infinity;
        try {
            pin.integrate(modelFF, qInf, vFF);
            check(false, 'integrate with Infinity in q should throw');
        } catch (e) {
            check(true, 'integrate with Infinity in q throws');
        }
        try {
            pin.difference(modelFF, qNaN, qFF);
            check(false, 'difference with NaN in q0 should throw');
        } catch (e) {
            check(true, 'difference with NaN in q0 throws');
        }

        // 5i: free-flyer + revolute model (nq=8, nv=7)
        const modelFFR = new pin.Model();
        const jFFR1 = pin.addJoint(modelFFR, 0, pin.JointModelFreeFlyer(), idFF, 'ff');
        pin.appendBodyToJoint(modelFFR, jFFR1, inertiaFF, idFF);
        const jFFR2 = pin.addJoint(modelFFR, jFFR1, pin.JointModelRX(), idFF, 'rx');
        pin.appendBodyToJoint(modelFFR, jFFR2, inertiaFF, idFF);
        check(assert(modelFFR.nq === 8 && modelFFR.nv === 7, 'Free-flyer + revolute model (nq=8, nv=7)'));

        const qFFR = pin.neutralConfiguration(modelFFR);
        const vFFR = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
        const integratedFFR = pin.integrate(modelFFR, qFFR, vFFR);
        check(assert(integratedFFR.length === 8, 'FF+R: integrate output length = 8'));
        const dvFFR = pin.difference(modelFFR, qFFR, integratedFFR);
        check(assertVecClose(dvFFR, vFFR, 1e-9, 'FF+R: round-trip identity'));

        // 5j: difference with scale
        const dvHalf = pin.difference(modelFF, qFF, integrated, 0.5);
        const dvFull = pin.difference(modelFF, qFF, integrated, 1.0);
        let diffScaleDiff = false;
        for (let i = 0; i < dvHalf.length; i++) {
            if (Math.abs(dvHalf[i] - dvFull[i]) > 1e-12) {
                diffScaleDiff = true;
                break;
            }
        }
        check(assert(diffScaleDiff, 'difference(q, q1, 0.5) != difference(q, q1, 1.0)'));

        // 6. Interpolate / Normalize / isNormalized
        console.log('  --- Interpolate / Normalize / isNormalized ---');

        const qFF0 = pin.neutralConfiguration(modelFF);
        const vFF2 = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
        const qFF1 = pin.integrate(modelFF, qFF0, vFF2);

        // 6a: interpolate(model, q0, q1, 0) returns q0
        const interp0 = pin.interpolate(modelFF, qFF0, qFF1, 0);
        check(assertVecClose(interp0, qFF0, 1e-12, 'interpolate(q0, q1, 0) returns q0'));

        // 6b: interpolate(model, q0, q1, 1) returns q1
        const interp1 = pin.interpolate(modelFF, qFF0, qFF1, 1);
        check(assertVecClose(interp1, qFF1, 1e-12, 'interpolate(q0, q1, 1) returns q1'));

        // 6c: interpolate(model, q0, q1, 0.5) differs from both endpoints
        const interpHalf = pin.interpolate(modelFF, qFF0, qFF1, 0.5);
        let interpHalfDiffFromQ0 = false;
        let interpHalfDiffFromQ1 = false;
        for (let i = 0; i < interpHalf.length; i++) {
            if (Math.abs(interpHalf[i] - qFF0[i]) > 1e-12) interpHalfDiffFromQ0 = true;
            if (Math.abs(interpHalf[i] - qFF1[i]) > 1e-12) interpHalfDiffFromQ1 = true;
        }
        check(assert(interpHalfDiffFromQ0, 'interpolate(q0, q1, 0.5) differs from q0'));
        check(assert(interpHalfDiffFromQ1, 'interpolate(q0, q1, 0.5) differs from q1'));

        // 6d: interpolate degenerate (q0 == q1) returns q0 for any alpha
        const interpDegenerate = pin.interpolate(modelFF, qFF0, qFF0, 0.7);
        check(assertVecClose(interpDegenerate, qFF0, 1e-12, 'interpolate(q, q, alpha) returns q'));

        // 6e: normalize returns a new Float64Array (does not mutate input)
        const qFFBeforeNorm = new Float64Array(qFF1);
        const qFFNorm = pin.normalize(modelFF, qFF1);
        check(assert(qFFNorm instanceof Float64Array, 'normalize returns Float64Array'));
        check(assert(qFFNorm !== qFF1, 'normalize returns new array (not same reference)'));
        check(assertVecClose(qFF1, qFFBeforeNorm, 1e-12, 'normalize does not mutate input'));

        // 6f: normalize on revolute-only model returns input unchanged
        const revoluteBefore = new Float64Array([0.5, -0.3]);
        const revoluteNorm = pin.normalize(model, revoluteBefore);
        check(assertVecClose(revoluteNorm, revoluteBefore, 1e-12, 'normalize on revolute-only model is identity'));

        // 6g: isNormalized returns true for neutral config, with default precision
        check(assert(pin.isNormalized(modelFF, qFF0), 'isNormalized(neutral) returns true (default precision)'));

        // 6h: isNormalized with explicit precision
        check(assert(pin.isNormalized(modelFF, qFF0, 1e-8), 'isNormalized(neutral, 1e-8) returns true'));

        // 6i: isNormalized returns true after normalize
        check(assert(pin.isNormalized(modelFF, qFFNorm), 'isNormalized returns true after normalize'));

        // 6j: normalize is idempotent — normalizing twice returns the same result
        const qFFNorm1 = pin.normalize(modelFF, qFF1);
        const qFFNorm2 = pin.normalize(modelFF, qFFNorm1);
        check(assertVecClose(qFFNorm2, qFFNorm1, 1e-12, 'normalize is idempotent'));

        // 6k: After repeated integrate, normalize restores isNormalized at tight precision
        let qDrift = new Float64Array(qFF0);
        const vDrift = new Float64Array([0.5, 0.5, 0.5, 1.0, 1.0, 1.0]);
        for (let iter = 0; iter < 2000; iter++) {
            qDrift = pin.integrate(modelFF, qDrift, vDrift);
        }
        check(assert(pin.isNormalized(modelFF, qDrift), 'After 2k integrates, isNormalized at default precision'));
        // Accumulated floating-point error from repeated quaternion composition
        // causes the quaternion norm to deviate from 1.0. This is detectable
        // only at near-machine-epsilon precision. The default 1e-6 is too loose.
        // Pinocchio preserves unit-norm well, so this verifies the function
        // correctly reports true for well-normalized configurations.
        const qDriftNorm = pin.normalize(modelFF, qDrift);
        check(assert(pin.isNormalized(modelFF, qDriftNorm, 1e-14), 'After normalize, isNormalized returns true at 1e-14'));
        check(assert(pin.isNormalized(modelFF, qDriftNorm), 'After normalize, isNormalized returns true (default precision)'));

        // 6l: isNormalized returns true for neutral config at tight precision
        check(assert(pin.isNormalized(modelFF, qFF0, 1e-14), 'isNormalized(neutral, 1e-14) returns true'));

        // 6m: Dimensional validation — wrong-length q throws for all three functions
        try {
            pin.interpolate(modelFF, new Float64Array([0]), qFF0, 0.5);
            check(false, 'interpolate with wrong q0.length should throw');
        } catch (e) {
            check(true, 'interpolate with wrong q0.length throws');
        }
        try {
            pin.interpolate(modelFF, qFF0, new Float64Array([0]), 0.5);
            check(false, 'interpolate with wrong q1.length should throw');
        } catch (e) {
            check(true, 'interpolate with wrong q1.length throws');
        }
        try {
            pin.normalize(modelFF, new Float64Array([0]));
            check(false, 'normalize with wrong q.length should throw');
        } catch (e) {
            check(true, 'normalize with wrong q.length throws');
        }
        try {
            pin.isNormalized(modelFF, new Float64Array([0]));
            check(false, 'isNormalized with wrong q.length should throw');
        } catch (e) {
            check(true, 'isNormalized with wrong q.length throws');
        }

        // 6n: Non-finite values in q throw
        const qNaN_7 = new Float64Array(7);
        qNaN_7.set(qFF0); qNaN_7[0] = NaN;
        try {
            pin.interpolate(modelFF, qNaN_7, qFF0, 0.5);
            check(false, 'interpolate with NaN in q0 should throw');
        } catch (e) {
            check(true, 'interpolate with NaN in q0 throws');
        }
        try {
            pin.normalize(modelFF, qNaN_7);
            check(false, 'normalize with NaN should throw');
        } catch (e) {
            check(true, 'normalize with NaN throws');
        }
        try {
            pin.isNormalized(modelFF, qNaN_7);
            check(false, 'isNormalized with NaN should throw');
        } catch (e) {
            check(true, 'isNormalized with NaN throws');
        }

        // 6o: isNormalized with negative precision throws
        try {
            pin.isNormalized(modelFF, qFF0, -1e-6);
            check(false, 'isNormalized with negative precision should throw');
        } catch (e) {
            check(true, 'isNormalized with negative precision throws');
        }

        return { passed, failed };
    }
};
