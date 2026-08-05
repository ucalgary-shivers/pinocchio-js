/**
 * Closed-loop constraint, factorization, dynamics, and inverse-geometry tests.
 */

function enumValue(value) {
    return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function maxAbs(values) {
    let result = 0;
    for (const value of values) result = Math.max(result, Math.abs(value));
    return result;
}

function allFinite(values) {
    return Array.from(values).every(Number.isFinite);
}

function buildClosureJacobian(J1, J2, c1Rc2, nv) {
    const J = new Float64Array(3 * nv);
    for (let col = 0; col < nv; col++) {
        for (let row = 0; row < 3; row++) {
            let rotatedJ2 = 0;
            for (let k = 0; k < 3; k++) {
                rotatedJ2 += c1Rc2[k * 3 + row] * J2[col * 6 + k];
            }
            J[col * 3 + row] = J1[col * 6 + row] - rotatedJ2;
        }
    }
    return J;
}

function multiplyKkt(mu, J, M, vector, constraintDim, nv) {
    const result = new Float64Array(constraintDim + nv);

    for (let row = 0; row < constraintDim; row++) {
        let value = -mu * vector[row];
        for (let col = 0; col < nv; col++) {
            value += J[col * constraintDim + row] * vector[constraintDim + col];
        }
        result[row] = value;
    }

    for (let row = 0; row < nv; row++) {
        let value = 0;
        for (let col = 0; col < constraintDim; col++) {
            value += J[row * constraintDim + col] * vector[col];
        }
        for (let col = 0; col < nv; col++) {
            value += M[col * nv + row] * vector[constraintDim + col];
        }
        result[constraintDim + row] = value;
    }

    return result;
}

function endpointPosition(placement) {
    return [
        placement.translation[0] + placement.rotation[0],
        placement.translation[1] + placement.rotation[1],
        placement.translation[2] + placement.rotation[2],
    ];
}

module.exports = {
    run: async (ctx) => {
        const { pin, assert, assertClose, assertVecClose } = ctx;
        let passed = 0;
        let failed = 0;
        const resources = [];

        function track(resource) {
            resources.push(resource);
            return resource;
        }

        function check(result) {
            if (result) passed++; else failed++;
        }

        function runSection(name, fn) {
            console.log(`  --- ${name} ---`);
            try {
                fn();
            } catch (error) {
                console.error(error);
                failed++;
            }
        }

        try {
            const model = track(new pin.Model());
            const identity = track(pin.SE3.identity());
            const pivot1 = track(pin.SE3.identity());
            const pivot2 = track(pin.SE3.identity());
            const branchOffset1 = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
            const branchOffset2 = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
            const taskOffset1 = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
            const taskOffset2 = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
            const inertia = track(pin.Inertia.fromMassComInertia(
                1.0,
                [0, 0, 0],
                [0.01, 0, 0, 0.01, 0, 0.01]
            ));

            function addRzJoint(parent, placement, name) {
                const jointModel = pin.JointModelRZ();
                try {
                    const jointId = pin.addJoint(model, parent, jointModel, placement, name);
                    pin.appendBodyToJoint(model, jointId, inertia, identity);
                    return jointId;
                } finally {
                    jointModel.delete();
                }
            }

            // Keep each branch contiguous: Pinocchio's dynamics uses contiguous subtree blocks.
            const j1 = addRzJoint(0, pivot1, 'J1');
            const j3 = addRzJoint(j1, branchOffset1, 'J3');
            const j2 = addRzJoint(0, pivot2, 'J2');
            const j4 = addRzJoint(j2, branchOffset2, 'J4');
            const data = track(new pin.Data(model));

            const constraintModel = track(pin.createRigidConstraintModel(
                pin.ContactType.CONTACT_3D,
                model,
                j3,
                taskOffset1,
                j4,
                taskOffset2,
                pin.ReferenceFrame.LOCAL
            ));
            const dynamicsSet = track(new pin.RigidConstraintSet(model));
            dynamicsSet.addConstraint(constraintModel);

            const choleskySet = track(new pin.RigidConstraintSet(model));
            choleskySet.addConstraint(constraintModel);
            const cholesky = track(pin.createContactCholeskyDecomposition(model, choleskySet));

            const qClosed = new Float64Array([
                Math.PI / 3,
                Math.PI / 3,
                2 * Math.PI / 3,
                -Math.PI / 3,
            ]);

            runSection('Constraint Model and Data API', () => {
                const contactValues = [
                    enumValue(pin.ContactType.CONTACT_3D),
                    enumValue(pin.ContactType.CONTACT_6D),
                    enumValue(pin.ContactType.CONTACT_UNDEFINED),
                ];
                check(assert(new Set(contactValues).size === 3, 'ContactType exposes three distinct values'));
                check(assert(model.nq === 4 && model.nv === 4 && model.njoints === 5,
                    'Four-joint branched Robot Model has expected dimensions'));
                check(assert(j1 === 1 && j3 === 2 && j2 === 3 && j4 === 4,
                    'Joint IDs preserve deterministic depth-first branch order'));

                check(assert(enumValue(constraintModel.type) === enumValue(pin.ContactType.CONTACT_3D),
                    'Closure Constraint type is CONTACT_3D'));
                check(assert(constraintModel.joint1_id === j3 && constraintModel.joint2_id === j4,
                    'Closure Constraint joins both branch task frames'));
                check(assert(enumValue(constraintModel.reference_frame) === enumValue(pin.ReferenceFrame.LOCAL),
                    'Closure Constraint uses LOCAL coordinates'));
                check(assert(constraintModel.size === 3, 'CONTACT_3D has dimension 3'));
                check(assertVecClose(constraintModel.joint1_placement.translation, [1, 0, 0], 1e-12,
                    'First task-frame placement is exposed'));
                check(assertVecClose(constraintModel.joint2_placement.translation, [1, 0, 0], 1e-12,
                    'Second task-frame placement is exposed'));

                const kp = [10, 20, 30];
                const kd = [2, 4, 6];
                constraintModel.correctorKp = new Float64Array(kp);
                constraintModel.correctorKd = new Float64Array(kd);
                check(assertVecClose(constraintModel.correctorKp, kp, 1e-12,
                    'Proportional correction gains round-trip'));
                check(assertVecClose(constraintModel.correctorKd, kd, 1e-12,
                    'Derivative correction gains round-trip'));

                const initialTransform = choleskySet.getData(0).c1Mc2;
                check(assert(initialTransform.translation.length === 3 && initialTransform.rotation.length === 9,
                    'Constraint data exposes c1Mc2'));
                check(assert(choleskySet.getData(0).translation.length === 3,
                    'Constraint data exposes c1Mc2 translation'));
                const initialForce = choleskySet.getData(0).contactForce;
                check(assert(initialForce.linear.length === 3 && initialForce.angular.length === 3,
                    'Constraint data exposes spatial contact force'));

                const constraint6d = pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D,
                    model,
                    j3,
                    taskOffset1,
                    j4,
                    taskOffset2,
                    pin.ReferenceFrame.LOCAL
                );
                try {
                    check(assert(constraint6d.size === 6, 'CONTACT_6D has dimension 6'));
                } finally {
                    constraint6d.delete();
                }

                const defaultCholesky = new pin.ContactCholeskyDecomposition();
                try {
                    check(assert(defaultCholesky.size === 0 && defaultCholesky.constraintDim === 0,
                        'Default ContactCholeskyDecomposition is empty'));
                } finally {
                    defaultCholesky.delete();
                }
            });

            runSection('Exact Task-Frame Jacobians', () => {
                pin.forwardKinematics(model, data, qClosed);
                pin.computeJointJacobians(model, data, qClosed);

                const J1 = pin.getFrameJacobian(
                    model, data, j3, taskOffset1, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                );
                const J2 = pin.getFrameJacobian(
                    model, data, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                );
                const sqrt3 = Math.sqrt(3);
                const expectedJ1 = new Array(24).fill(0);
                const expectedJ2 = new Array(24).fill(0);

                expectedJ1[0 * 6 + 0] = -sqrt3;
                expectedJ1[0 * 6 + 5] = 1;
                expectedJ1[1 * 6 + 0] = -sqrt3 / 2;
                expectedJ1[1 * 6 + 1] = -0.5;
                expectedJ1[1 * 6 + 5] = 1;

                expectedJ2[2 * 6 + 0] = -sqrt3;
                expectedJ2[2 * 6 + 5] = 1;
                expectedJ2[3 * 6 + 0] = -sqrt3 / 2;
                expectedJ2[3 * 6 + 1] = 0.5;
                expectedJ2[3 * 6 + 5] = 1;

                check(assert(J1.length === 6 * model.nv && J2.length === 6 * model.nv,
                    'Task-frame Jacobians have shape 6 x nv'));
                check(assertVecClose(J1, expectedJ1, 1e-10,
                    'First task-frame Jacobian matches exact planar derivatives'));
                check(assertVecClose(J2, expectedJ2, 1e-10,
                    'Second task-frame Jacobian matches exact planar derivatives'));
                check(assertClose(J1[1 * 6 + 1], -0.5, 1e-12,
                    'Jacobian storage is column-major'));
            });

            let closedConstraintJacobian;
            let closedMassMatrix;
            const factorizationMu = 1e-4;

            runSection('Contact Cholesky Factorization', () => {
                closedMassMatrix = pin.crba(model, data, qClosed);
                pin.computeJointJacobians(model, data, qClosed);

                check(assert(cholesky.constraintDim === 3, 'Factorization constraint dimension is 3'));
                check(assert(cholesky.size === model.nv + 3, 'Factorization size is nv + constraint dimension'));

                cholesky.compute(model, data, choleskySet, factorizationMu);
                const choleskyData0 = choleskySet.getData(0);
                check(assertVecClose(choleskyData0.translation, [0, 0, 0], 1e-10,
                    'Known closed configuration has zero Closure Constraint translation'));
                check(assertVecClose(choleskyData0.c1Mc2.rotation, [
                    0.5, -Math.sqrt(3) / 2, 0,
                    Math.sqrt(3) / 2, 0.5, 0,
                    0, 0, 1,
                ], 1e-10, 'c1Mc2 contains the expected relative task-frame rotation'));

                const J1Local = pin.getFrameJacobian(
                    model, data, j3, taskOffset1, pin.ReferenceFrame.LOCAL
                );
                const J2Local = pin.getFrameJacobian(
                    model, data, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                );
                closedConstraintJacobian = buildClosureJacobian(
                    J1Local, J2Local, choleskyData0.c1Mc2.rotation, model.nv
                );

                const rhs = new Float64Array([0.5, -1, 0.25, 1, -2, 3, -4]);
                const solution = cholesky.solve(rhs);
                const reconstructedRhs = multiplyKkt(
                    factorizationMu,
                    closedConstraintJacobian,
                    closedMassMatrix,
                    solution,
                    3,
                    model.nv
                );

                check(assert(solution.length === cholesky.size && allFinite(solution),
                    'Factorization solve returns a finite full-system solution'));
                check(assertVecClose(reconstructedRhs, Array.from(rhs), 1e-8,
                    'Factorization solve satisfies independently reconstructed [-mu I, J; J^T, M] system'));
            });

            runSection('Constrained Dynamics', () => {
                const dynamicsMu = 1e-6;
                const settings = track(new pin.ProximalSettings(1e-8, dynamicsMu, 10));
                check(assertClose(settings.absolute_accuracy, 1e-8, 0,
                    'ProximalSettings absolute accuracy is initialized'));
                check(assertClose(settings.relative_accuracy, 1e-8, 0,
                    'ProximalSettings relative accuracy is initialized'));
                check(assertClose(settings.mu, dynamicsMu, 0, 'ProximalSettings damping is initialized'));
                check(assert(settings.max_iter === 10 && settings.iter === 0,
                    'ProximalSettings iteration limits are initialized'));
                check(assert(settings.absolute_residual === -1 && settings.relative_residual === -1,
                    'ProximalSettings residual diagnostics start unset'));

                const criticalDamping = 2 * Math.sqrt(10);
                dynamicsSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([criticalDamping, criticalDamping, criticalDamping]));

                const velocity = new Float64Array(model.nv);
                const torque = new Float64Array([1, 0.25, -0.5, -0.75]);
                pin.initConstraintDynamics(model, data, dynamicsSet);
                const acceleration1 = pin.constraintDynamics(
                    model,
                    data,
                    qClosed,
                    velocity,
                    torque,
                    dynamicsSet,
                    settings
                );
                const storedAcceleration1 = pin.getDDq(data);
                const lambda1 = pin.getLambdaC(data);
                const force1 = dynamicsSet.getData(0).contactForce;

                check(assert(acceleration1.length === model.nv && allFinite(acceleration1),
                    'constraintDynamics returns finite generalized acceleration'));
                check(assertVecClose(storedAcceleration1, Array.from(acceleration1), 1e-12,
                    'getDDq returns the constrained acceleration'));
                check(assert(lambda1.length === 3 && allFinite(lambda1),
                    'getLambdaC returns three finite multipliers'));
                check(assertVecClose(force1.linear, Array.from(lambda1), 1e-10,
                    'Constraint contact force equals lambda_c'));
                check(assertVecClose(force1.angular, [0, 0, 0], 1e-12,
                    'CONTACT_3D has no angular contact force'));

                const massMatrix = pin.crba(model, data, qClosed);
                const nonlinear = pin.nonLinearEffects(model, data, qClosed, velocity);
                pin.computeJointJacobians(model, data, qClosed);
                const J1Local = pin.getFrameJacobian(
                    model, data, j3, taskOffset1, pin.ReferenceFrame.LOCAL
                );
                const J2Local = pin.getFrameJacobian(
                    model, data, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                );
                const J = buildClosureJacobian(
                    J1Local, J2Local, dynamicsSet.getData(0).c1Mc2.rotation, model.nv
                );
                // Pinocchio reports lambda_c as the negative of the KKT solution's head.
                const primalDual = new Float64Array([
                    ...Array.from(lambda1, value => -value),
                    ...acceleration1,
                ]);
                const reconstructed = multiplyKkt(
                    dynamicsMu, J, massMatrix, primalDual, 3, model.nv
                );
                const expected = new Float64Array(3 + model.nv);
                for (let i = 0; i < model.nv; i++) expected[3 + i] = torque[i] - nonlinear[i];
                check(assertVecClose(
                    reconstructed.subarray(3),
                    Array.from(expected.subarray(3)),
                    1e-7,
                    'Constrained dynamics satisfies KKT generalized-force balance'
                ));
                const constraintAcceleration = new Float64Array(3);
                for (let row = 0; row < 3; row++) {
                    for (let col = 0; col < model.nv; col++) {
                        constraintAcceleration[row] += J[col * 3 + row] * acceleration1[col];
                    }
                }
                check(assertVecClose(constraintAcceleration, [0, 0, 0], 1e-8,
                    'Constrained dynamics satisfies closure-acceleration balance'));

                check(assert(Number.isFinite(settings.absolute_residual) &&
                    Number.isFinite(settings.relative_residual),
                    'ProximalSettings exposes finite post-solve residuals'));
                check(assert(settings.iter >= 0 && settings.iter <= settings.max_iter,
                    'ProximalSettings exposes bounded post-solve iteration count'));

                const acceleration2 = pin.constraintDynamics(
                    model,
                    data,
                    qClosed,
                    velocity,
                    torque,
                    dynamicsSet,
                    settings
                );
                const lambda2 = pin.getLambdaC(data);
                check(assertVecClose(acceleration2, Array.from(acceleration1), 1e-12,
                    'Repeated constrained-dynamics calls are deterministic'));
                check(assertVecClose(lambda2, Array.from(lambda1), 1e-12,
                    'Repeated constrained-dynamics multipliers are deterministic'));
            });

            runSection('Real Use Case: Primal-Dual Inverse Geometry', () => {
                const q = new Float64Array([
                    Math.PI / 3 + 0.1,
                    Math.PI / 3 + 0.05,
                    2 * Math.PI / 3 - 0.08,
                    -Math.PI / 3 - 0.04,
                ]);
                const y = new Float64Array([1, 1, 1]);
                const mu = 1e-4;
                const tolerance = 1e-10;
                const maxIterations = 20;
                let initialPrimal = null;
                let primalFeasibility = Infinity;
                let dualFeasibility = Infinity;
                let iterations = 0;

                for (; iterations < maxIterations; iterations++) {
                    pin.crba(model, data, q);
                    pin.computeJointJacobians(model, data, q);
                    cholesky.compute(model, data, choleskySet, mu);

                    const pdConstraintData = choleskySet.getData(0);
                    const constraintValue = pdConstraintData.translation;
                    const relativeRotation = pdConstraintData.c1Mc2.rotation;
                    const J1 = pin.getFrameJacobian(
                        model, data, j3, taskOffset1, pin.ReferenceFrame.LOCAL
                    );
                    const J2 = pin.getFrameJacobian(
                        model, data, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                    );
                    const J = buildClosureJacobian(J1, J2, relativeRotation, model.nv);

                    primalFeasibility = maxAbs(constraintValue);
                    if (initialPrimal === null) initialPrimal = primalFeasibility;

                    dualFeasibility = 0;
                    for (let col = 0; col < model.nv; col++) {
                        let value = 0;
                        for (let row = 0; row < 3; row++) {
                            value += J[col * 3 + row] * (constraintValue[row] + y[row]);
                        }
                        dualFeasibility = Math.max(dualFeasibility, Math.abs(value));
                    }

                    if (primalFeasibility < tolerance && dualFeasibility < tolerance) break;

                    const rhs = new Float64Array(cholesky.size);
                    for (let i = 0; i < 3; i++) rhs[i] = -constraintValue[i] - y[i] * mu;
                    const step = cholesky.solve(rhs);
                    check(assert(allFinite(step), `Inverse-geometry step ${iterations + 1} is finite`));

                    for (let i = 0; i < 3; i++) y[i] = step[i];
                    const qPrev = new Float64Array(q);
                    q.set(pin.integrate(model, q, step.subarray(3, 3 + model.nv), -1.0));
                    check(assert(maxAbs(pin.difference(model, qPrev, q)) > 0,
                        `Newton step changes configuration (iter ${iterations + 1})`));
                }

                check(assert(initialPrimal > 1e-3,
                    'Inverse geometry starts from an open configuration'));
                check(assert(primalFeasibility < tolerance,
                    `Inverse geometry reaches primal feasibility (${primalFeasibility.toExponential(2)})`));
                check(assert(dualFeasibility < tolerance,
                    `Inverse geometry reaches dual feasibility (${dualFeasibility.toExponential(2)})`));
                check(assert(iterations < maxIterations,
                    `Inverse geometry converges within ${maxIterations} iterations`));
                check(assert(allFinite(q), 'Projected configuration remains finite'));

                pin.forwardKinematics(model, data, q);
                const task1 = endpointPosition(pin.getJointPlacement(data, j3));
                const task2 = endpointPosition(pin.getJointPlacement(data, j4));
                check(assertVecClose(task1, task2, 1e-10,
                    'Independent forward kinematics confirms coincident task frames'));

                const postProjectionSettings = track(new pin.ProximalSettings(1e-8, 1e-10, 10));
                pin.initConstraintDynamics(model, data, dynamicsSet);
                const acceleration = pin.constraintDynamics(
                    model,
                    data,
                    q,
                    new Float64Array(model.nv),
                    new Float64Array(model.nv),
                    dynamicsSet,
                    postProjectionSettings
                );
                check(assert(acceleration.length === model.nv && allFinite(acceleration),
                    'Projected configuration initializes constrained dynamics'));
            });

            runSection('RigidConstraintSet evaluate', () => {
                const set = track(new pin.RigidConstraintSet(model));
                check(assert(set.count === 0 && set.constraintDim === 0, 'Empty set has zero entries'));

                const resultEmpty = set.evaluate(model, data, qClosed);
                check(assert(resultEmpty.rows === 0 && resultEmpty.cols === model.nv,
                    'Empty evaluate returns zero rows with nv columns'));
                check(assert(resultEmpty.residual instanceof Float64Array && resultEmpty.residual.length === 0,
                    'Empty evaluate returns zero-length residual'));
                check(assert(resultEmpty.jacobian instanceof Float64Array && resultEmpty.jacobian.length === 0,
                    'Empty evaluate returns zero-length jacobian'));

                const cm3dLocal = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const idx3dLocal = set.addConstraint(cm3dLocal);
                check(assert(idx3dLocal === 0 && set.count === 1, '3D LOCAL constraint added at index 0'));
                check(assert(set.constraintDim === 3 && set.revision === 1, 'Set dimension updated'));

                const result3dLocal = set.evaluate(model, data, qClosed);
                check(assert(result3dLocal.rows === 3 && result3dLocal.cols === model.nv,
                    '3D evaluate returns correct dimensions'));
                check(assert(result3dLocal.residual instanceof Float64Array && result3dLocal.residual.length === 3,
                    '3D residual is Float64Array of length 3'));
                check(assert(result3dLocal.jacobian instanceof Float64Array && result3dLocal.jacobian.length === 3 * model.nv,
                    '3D jacobian is Float64Array sized rows×cols'));

                const forceBefore = structuredClone
                    ? structuredClone(dynamicsSet.getData(0).contactForce)
                    : JSON.parse(JSON.stringify(dynamicsSet.getData(0).contactForce));
                const evalAfterDynamics = dynamicsSet.evaluate(model, data, qClosed);
                check(assertVecClose(dynamicsSet.getData(0).contactForce.linear, forceBefore.linear, 1e-12,
                    'evaluate preserves contact force linear'));
                check(assertVecClose(dynamicsSet.getData(0).contactForce.angular, forceBefore.angular, 1e-12,
                    'evaluate preserves contact force angular'));
            });

            runSection('RigidConstraintSet evaluate finite-difference', () => {
                const eps = 1e-6;
                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                const setFd3dLocal = track(new pin.RigidConstraintSet(model));
                const cm3dFdLocal = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                setFd3dLocal.addConstraint(cm3dFdLocal);

                const eval3dLocal = setFd3dLocal.evaluate(model, data, q);
                const J3dLocal = eval3dLocal.jacobian;

                setFd3dLocal.evaluate(model, data, q);
                pin.forwardKinematics(model, data, q);
                pin.computeJointJacobians(model, data, q);
                const J1Local = pin.getFrameJacobian(model, data, j3, taskOffset1, pin.ReferenceFrame.LOCAL);
                const J2Local = pin.getFrameJacobian(model, data, j4, taskOffset2, pin.ReferenceFrame.LOCAL);
                const cdLocal = setFd3dLocal.getData(0);
                const manualJLocal = buildClosureJacobian(J1Local, J2Local, cdLocal.c1Mc2.rotation, model.nv);
                const negManualJ = new Float64Array(manualJLocal.length);
                for (let i = 0; i < manualJLocal.length; i++) negManualJ[i] = -manualJLocal[i];

                let maxDiffManual = 0;
                for (let i = 0; i < J3dLocal.length; i++) {
                    maxDiffManual = Math.max(maxDiffManual, Math.abs(J3dLocal[i] - negManualJ[i]));
                }
                check(assert(maxDiffManual < 2e-6,
                    `3D LOCAL Jacobian matches manual construction (max diff=${maxDiffManual.toExponential(2)})`));

                const setFd3dLwa = track(new pin.RigidConstraintSet(model));
                const cm3dFdLwa = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                setFd3dLwa.addConstraint(cm3dFdLwa);

                const eval3dLwa = setFd3dLwa.evaluate(model, data, q);
                const J3dLwa = eval3dLwa.jacobian;
                const r0Lwa = new Float64Array(eval3dLwa.residual);
                const fdJ3dLwa = new Float64Array(3 * model.nv);

                for (let col = 0; col < model.nv; col++) {
                    const qPert = new Float64Array(q);
                    qPert[col] += eps;
                    const rP = setFd3dLwa.evaluate(model, data, qPert).residual;
                    for (let row = 0; row < 3; row++) {
                        fdJ3dLwa[col * 3 + row] = (rP[row] - r0Lwa[row]) / eps;
                    }
                }

                let maxDiffLwa = 0;
                for (let i = 0; i < J3dLwa.length; i++) {
                    maxDiffLwa = Math.max(maxDiffLwa, Math.abs(J3dLwa[i] - fdJ3dLwa[i]));
                }
                check(assert(maxDiffLwa < 1e-3,
                    `3D LWA Jacobian matches finite differences (max diff=${maxDiffLwa.toExponential(2)})`));
            });

            runSection('RigidConstraintSet evaluate 6D and mixed', () => {
                const setMixed = track(new pin.RigidConstraintSet(model));
                const cm6dLocal = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const idx6d = setMixed.addConstraint(cm6dLocal);
                check(assert(idx6d === 0 && setMixed.constraintDim === 6, '6D constraint dim is 6'));

                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);
                const result6d = setMixed.evaluate(model, data, q);

                check(assert(result6d.rows === 6 && result6d.cols === model.nv,
                    '6D evaluate returns 6 rows'));
                check(assert(result6d.residual.length === 6, '6D residual has 6 elements'));
                check(assert(result6d.jacobian.length === 6 * model.nv,
                    '6D jacobian sized 6×nv'));

                const cm3dLocal2 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const idx3dMixed = setMixed.addConstraint(cm3dLocal2);
                check(assert(idx3dMixed === 1 && setMixed.constraintDim === 9,
                    'Mixed set total dim is 6+3=9'));

                const resultMixed = setMixed.evaluate(model, data, q);
                check(assert(resultMixed.rows === 9 && resultMixed.cols === model.nv,
                    'Mixed evaluate returns 9 rows'));
                check(assert(resultMixed.residual.length === 9, 'Mixed residual has 9 elements'));
                check(assert(resultMixed.jacobian.length === 9 * model.nv,
                    'Mixed jacobian sized 9×nv'));

                const rowOffset0 = setMixed.rowOffset(0);
                const rowOffset1 = setMixed.rowOffset(1);
                check(assert(rowOffset0 === 0 && rowOffset1 === 6, 'Row offsets are 0 and 6'));

                const residual6dOnly = resultMixed.residual.subarray(0, 6);
                const residual3dOnly = resultMixed.residual.subarray(6, 9);
                check(assertVecClose(residual6dOnly, Array.from(result6d.residual), 1e-12,
                    '6D residual in mixed set matches standalone'));
                check(assert(allFinite(residual3dOnly), '3D residual in mixed set is finite'));

                const jac6dEnd = result6d.jacobian.length;
                const jac6dOnly = new Float64Array(jac6dEnd);
                const mixedStride = resultMixed.rows;
                for (let col = 0; col < model.nv; col++) {
                    for (let row = 0; row < 6; row++) {
                        jac6dOnly[col * 6 + row] = resultMixed.jacobian[col * mixedStride + row];
                    }
                }
                check(assertVecClose(jac6dOnly, Array.from(result6d.jacobian), 1e-12,
                    '6D jacobian in mixed set matches standalone'));
            });

            runSection('Delta Mechanism Acceptance: Three-Loop Coupled Solve', () => {
                const modelDelta = track(new pin.Model());
                const identityDelta = track(pin.SE3.identity());
                const inertiaDelta = track(pin.Inertia.fromMassComInertia(
                    1.0, [0, 0, 0], [0.01, 0, 0, 0.01, 0, 0.01]
                ));
                const linkOffset = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
                const sqrt3Over2 = Math.sqrt(3) / 2;

                function addRzJointDelta(parent, placement, name) {
                    const jm = pin.JointModelRZ();
                    try {
                        const id = pin.addJoint(modelDelta, parent, jm, placement, name);
                        pin.appendBodyToJoint(modelDelta, id, inertiaDelta, identityDelta);
                        return id;
                    } finally {
                        jm.delete();
                    }
                }

                const pivotA = track(pin.SE3.fromXyzRpy(1, 0, 0, 0, 0, 0));
                const pivotB = track(pin.SE3.fromXyzRpy(-0.5, sqrt3Over2, 0, 0, 0, 0));
                const pivotC = track(pin.SE3.fromXyzRpy(-0.5, -sqrt3Over2, 0, 0, 0, 0));
                const jA1 = addRzJointDelta(0, pivotA, 'jA1');
                const jA2 = addRzJointDelta(jA1, linkOffset, 'jA2');
                const jB1 = addRzJointDelta(0, pivotB, 'jB1');
                const jB2 = addRzJointDelta(jB1, linkOffset, 'jB2');
                const jC1 = addRzJointDelta(0, pivotC, 'jC1');
                const jC2 = addRzJointDelta(jC1, linkOffset, 'jC2');

                check(assert(modelDelta.nq === 6 && modelDelta.nv === 6 && modelDelta.njoints === 7,
                    'Delta model has six joints in three chains'));

                const dataDelta = track(new pin.Data(modelDelta));

                const qClosedDelta = new Float64Array([
                    2 * Math.PI / 3, 2 * Math.PI / 3,
                    4 * Math.PI / 3, 2 * Math.PI / 3,
                    2 * Math.PI / 3, 4 * Math.PI / 3,
                ]);

                function chainTipPosition(joint1Id, q1Index) {
                    pin.forwardKinematics(modelDelta, dataDelta, qClosedDelta);
                    const placement = pin.getJointPlacement(dataDelta, joint1Id);
                    const q1 = qClosedDelta[q1Index];
                    const q2 = qClosedDelta[q1Index + 1];
                    const cos1 = Math.cos(q1);
                    const sin1 = Math.sin(q1);
                    const cos2 = Math.cos(q1 + q2);
                    const sin2 = Math.sin(q1 + q2);
                    return [
                        placement.translation[0] + cos1 + cos2,
                        placement.translation[1] + sin1 + sin2,
                        placement.translation[2],
                    ];
                }

                const tipA = chainTipPosition(jA1, 0);
                const tipB = chainTipPosition(jB1, 2);
                const tipC = chainTipPosition(jC1, 4);

                check(assertVecClose(tipA, [0, 0, 0], 1e-10,
                    'Chain A tip reaches origin at closed configuration'));
                check(assertVecClose(tipB, [0, 0, 0], 1e-10,
                    'Chain B tip reaches origin at closed configuration'));
                check(assertVecClose(tipC, [0, 0, 0], 1e-10,
                    'Chain C tip reaches origin at closed configuration'));

                const deltaSet = track(new pin.RigidConstraintSet(modelDelta));
                const cmAB = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, modelDelta, jA2, linkOffset, jB2, linkOffset, pin.ReferenceFrame.LOCAL
                ));
                const cmBC = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, modelDelta, jB2, linkOffset, jC2, linkOffset, pin.ReferenceFrame.LOCAL
                ));
                const cmCA = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, modelDelta, jC2, linkOffset, jA2, linkOffset, pin.ReferenceFrame.LOCAL
                ));
                deltaSet.addConstraint(cmAB);
                deltaSet.addConstraint(cmBC);
                deltaSet.addConstraint(cmCA);

                check(assert(deltaSet.count === 3 && deltaSet.constraintDim === 9,
                    'Delta set has 3 constraints, total dim 9'));
                check(assert(deltaSet.rowOffset(0) === 0 && deltaSet.rowOffset(1) === 3 && deltaSet.rowOffset(2) === 6,
                    'Delta row offsets are 0, 3, 6'));

                const resultAtClosed = deltaSet.evaluate(modelDelta, dataDelta, qClosedDelta);
                check(assert(maxAbs(resultAtClosed.residual) < 1e-10,
                    'Stacked residual is zero at closed configuration'));
                check(assert(resultAtClosed.rows === 9 && resultAtClosed.cols === 6,
                    'Combined Jacobian is 9×6 at closed configuration'));

                const qPerturbed = new Float64Array([
                    2 * Math.PI / 3 + 0.15,
                    2 * Math.PI / 3 - 0.10,
                    4 * Math.PI / 3 - 0.12,
                    2 * Math.PI / 3 + 0.08,
                    2 * Math.PI / 3 + 0.09,
                    4 * Math.PI / 3 - 0.07,
                ]);
                const initialResult = deltaSet.evaluate(modelDelta, dataDelta, qPerturbed);
                const initialPrimal = maxAbs(initialResult.residual);
                check(assert(initialPrimal > 1e-3,
                    `Perturbed configuration has non-zero residual (${initialPrimal.toExponential(2)})`));

                const muDelta = 1e-4;
                const tolDelta = 1e-8;
                const maxIterDelta = 500;
                const qWork = new Float64Array(qPerturbed);
                let iterDelta = 0;
                let alphaDelta = 0.1;
                let lastPrimal = Infinity;

                for (; iterDelta < maxIterDelta; iterDelta++) {
                    const evalResult = deltaSet.evaluate(modelDelta, dataDelta, qWork);
                    if (!allFinite(evalResult.residual)) break;

                    const primal = maxAbs(evalResult.residual);
                    if (primal < tolDelta) break;

                    if (primal < lastPrimal * 0.8) {
                        alphaDelta = Math.min(1.0, alphaDelta * 1.5);
                    } else {
                        alphaDelta *= 0.5;
                    }
                    lastPrimal = primal;

                    const J = evalResult.jacobian;
                    const e = evalResult.residual;
                    const rows = evalResult.rows;
                    const cols = evalResult.cols;

                    const grad = new Float64Array(cols);
                    for (let i = 0; i < cols; i++) {
                        let s = 0;
                        for (let k = 0; k < rows; k++) s += J[i * rows + k] * e[k];
                        grad[i] = s;
                    }

                    const maxGrad = maxAbs(grad);
                    const stepSize = Math.min(alphaDelta, 1.0 / Math.max(1.0, maxGrad));
                    qWork.set(pin.integrate(modelDelta, qWork, grad, stepSize));
                }

                check(assert(iterDelta < maxIterDelta,
                    `Delta solver converged in ${iterDelta} iterations`));
                const finalResult = deltaSet.evaluate(modelDelta, dataDelta, qWork);
                check(assert(maxAbs(finalResult.residual) < tolDelta,
                    `Converged residual below tolerance (${maxAbs(finalResult.residual).toExponential(2)})`));

                pin.forwardKinematics(modelDelta, dataDelta, qWork);
                function getTipWorld(jointId) {
                    const p = pin.getJointPlacement(dataDelta, jointId);
                    return [
                        p.translation[0] + p.rotation[0],
                        p.translation[1] + p.rotation[1],
                        p.translation[2] + p.rotation[2],
                    ];
                }
                const tipAClosed = getTipWorld(jA2);
                const tipBClosed = getTipWorld(jB2);
                const tipCClosed = getTipWorld(jC2);
                check(assertVecClose(tipAClosed, tipBClosed, 1e-8,
                    'Independently verified: tip A coincides with tip B'));
                check(assertVecClose(tipBClosed, tipCClosed, 1e-8,
                    'Independently verified: tip B coincides with tip C'));
                check(assertVecClose(tipCClosed, tipAClosed, 1e-8,
                    'Independently verified: tip C coincides with tip A'));

                pin.crba(modelDelta, dataDelta, qWork);
                const settingsDelta = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                pin.initConstraintDynamics(modelDelta, dataDelta, deltaSet);
                const accDelta = pin.constraintDynamics(
                    modelDelta, dataDelta, qWork,
                    new Float64Array(6), new Float64Array(6),
                    deltaSet, settingsDelta
                );
                check(assert(accDelta.length === 6 && allFinite(accDelta),
                    'Delta mechanism dynamics produces finite acceleration'));
            });

            runSection('RigidConstraintSet evaluate residual conventions', () => {
                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                const set3dLocal = track(new pin.RigidConstraintSet(model));
                const cm3dL = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                set3dLocal.addConstraint(cm3dL);
                const r3dL = set3dLocal.evaluate(model, data, q);

                pin.forwardKinematics(model, data, q);
                pin.computeJointJacobians(model, data, q);
                const cd3dL = set3dLocal.getData(0);
                check(assertVecClose(r3dL.residual, Array.from(cd3dL.translation).map(v => -v), 1e-10,
                    '3D LOCAL residual is negative relative translation'));

                const set3dLwa = track(new pin.RigidConstraintSet(model));
                const cm3dW = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                set3dLwa.addConstraint(cm3dW);
                const r3dW = set3dLwa.evaluate(model, data, q);

                let maxDiff3dLW = 0;
                for (let i = 0; i < 3; i++) {
                    maxDiff3dLW = Math.max(maxDiff3dLW, Math.abs(r3dW.residual[i] - r3dL.residual[i]));
                }
                check(assert(maxDiff3dLW > 1e-6,
                    '3D LWA residual differs from LOCAL residual in non-identity orientation'));

                let worldRejected = false;
                try {
                    pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.WORLD
                    );
                } catch (e) {
                    worldRejected = true;
                }
                check(assert(worldRejected, 'WORLD reference frame is rejected'));

                const set6dLocal = track(new pin.RigidConstraintSet(model));
                const cm6dL = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                set6dLocal.addConstraint(cm6dL);
                const r6dL = set6dLocal.evaluate(model, data, q);

                check(assert(r6dL.residual.length === 6, '6D LOCAL residual has 6 elements'));
                check(assert(allFinite(r6dL.residual), '6D LOCAL residual is finite'));

                const set6dLwa = track(new pin.RigidConstraintSet(model));
                const cm6dW = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                set6dLwa.addConstraint(cm6dW);
                const r6dW = set6dLwa.evaluate(model, data, q);

                check(assert(r6dW.residual.length === 6 && allFinite(r6dW.residual),
                    '6D LWA residual is valid'));
                let maxDiff6dLW = 0;
                for (let i = 0; i < 6; i++) {
                    maxDiff6dLW = Math.max(maxDiff6dLW, Math.abs(r6dW.residual[i] - r6dL.residual[i]));
                }
                check(assert(maxDiff6dLW > 1e-6,
                    '6D LWA residual differs from LOCAL residual'));
            });

            runSection('Regression: Ownership Deletion After Add', () => {
                const testSet = track(new pin.RigidConstraintSet(model));
                const cm = pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                );
                try {
                    const idx = testSet.addConstraint(cm);
                    check(assert(idx === 0 && testSet.count === 1, 'Constraint added'));

                    const modelBeforeDelete = testSet.getModel(0);
                    const dataBeforeDelete = testSet.getData(0);
                    cm.delete();

                    check(assert(testSet.count === 1, 'Set count unchanged after original model deletion'));
                    const modelAfterDelete = testSet.getModel(0);
                    check(assert(modelAfterDelete.type !== undefined && modelAfterDelete.rowDim === 3,
                        'Model info accessible after original deletion'));
                    const dataAfterDelete = testSet.getData(0);
                    check(assertVecClose(dataAfterDelete.translation, Array.from(dataBeforeDelete.translation), 1e-12,
                        'Data translation preserved after original deletion'));

                    const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);
                    const evalResult = testSet.evaluate(model, data, q);
                    check(assert(evalResult.rows === 3 && allFinite(evalResult.residual),
                        'Evaluate works after original model deletion'));
                } finally {
                    // cm already deleted manually; testSet cleaned up via track()
                }
            });

            runSection('Regression: Duplicate Constraints', () => {
                const testSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const idx0 = testSet.addConstraint(cm);
                const idx1 = testSet.addConstraint(cm);

                check(assert(idx0 === 0 && idx1 === 1,
                    'Duplicate constraints receive distinct stable indices'));
                check(assert(testSet.count === 2 && testSet.constraintDim === 6,
                    'Duplicate constraints double the set dimension'));
                check(assert(testSet.rowOffset(0) === 0 && testSet.rowOffset(1) === 3,
                    'Row offsets correct for duplicates'));
                check(assert(testSet.revision === 2, 'Revision incremented for each add'));
            });

            runSection('Regression: Mutation-Triggered Reallocation', () => {
                const testSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                testSet.addConstraint(cm);

                const chol = track(pin.createContactCholeskyDecomposition(model, testSet));
                check(assert(chol.constraintDim === 3, 'Cholesky initialized with one constraint'));

                chol.compute(model, data, testSet, 1e-4);
                check(assert(chol.size === model.nv + 3, 'Cholesky size reflects 1 constraint'));

                const cm2 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                testSet.addConstraint(cm2);

                chol.compute(model, data, testSet, 1e-4);
                check(assert(chol.constraintDim === 9, 'Cholesky reallocated to 3+6 constraints'));
                check(assert(chol.size === model.nv + 9, 'Cholesky size updated after reallocation'));

                try {
                    chol.solve(new Float64Array(chol.size));
                    check(assert(true, 'Solve works after reallocation'));
                } catch (e) {
                    check(assert(false, `Solve after reallocation failed: ${e.message}`));
                }
            });

            runSection('Regression: Error Recovery', () => {
                let errorCaught;

                errorCaught = false;
                try {
                    const wrongSet = new pin.RigidConstraintSet(model);
                    const cmWorld = track(pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.WORLD
                    ));
                    wrongSet.addConstraint(cmWorld);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'WORLD frame addConstraint throws recoverable error'));

                errorCaught = false;
                try {
                    const badSet = new pin.RigidConstraintSet(model);
                    const cmUndef = track(pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_UNDEFINED, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                    ));
                    badSet.addConstraint(cmUndef);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Undefined contact type throws recoverable error'));

                errorCaught = false;
                try {
                    choleskySet.getModel(999);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Out-of-range getModel index throws'));

                errorCaught = false;
                try {
                    choleskySet.getData(-1);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Negative getData index throws'));

                errorCaught = false;
                try {
                    choleskySet.rowOffset(500);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Out-of-range rowOffset throws'));

                errorCaught = false;
                try {
                    choleskySet.setConstraintGains(0,
                        new Float64Array([NaN, Infinity, 0]),
                        new Float64Array([0, 0, 0]));
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Non-finite gains throw recoverable error'));

                errorCaught = false;
                try {
                    choleskySet.setConstraintGains(0,
                        new Float64Array([1, 1]),
                        new Float64Array([1, 1]));
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Wrong gain dimension throws recoverable error'));

                const forceAfterGainError = choleskySet.getData(0).contactForce;
                check(assertVecClose(forceAfterGainError.linear, [0, 0, 0], 1e-12,
                    'Set data intact after error recovery'));

                let smallModelOwnership;
                try {
                    smallModelOwnership = track(new pin.Model());
                    const smallRz = pin.JointModelRZ();
                    try {
                        pin.addJoint(smallModelOwnership, 0, smallRz,
                            pin.SE3.fromXyzRpy(0, 0, 1, 0, 0, 0), 'j');
                    } finally {
                        smallRz.delete();
                    }
                    const wrongSet = new pin.RigidConstraintSet(smallModelOwnership);
                    const cmTopo = track(pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                    ));
                    wrongSet.addConstraint(cmTopo);
                    check(assert(false, 'Should have thrown topology mismatch'));
                } catch (e) {
                    check(assert(true, 'Topology mismatch throws recoverable error'));
                }
            });

            runSection('Regression: Set Revision Tracking', () => {
                const revSet = track(new pin.RigidConstraintSet(model));
                check(assert(revSet.revision === 0, 'New set starts at revision 0'));

                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                revSet.addConstraint(cm);
                check(assert(revSet.revision === 1, 'Add constraint increments revision'));

                revSet.setConstraintGains(0,
                    new Float64Array([42, 42, 42]),
                    new Float64Array([7, 7, 7]));
                check(assert(revSet.revision === 2, 'Set gains increments revision'));

                const cm2 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                revSet.addConstraint(cm2);
                check(assert(revSet.revision === 3, 'Second add increments revision'));
            });

            runSection('Regression: Force-Preserving Evaluation After Dynamics', () => {
                const fpSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                fpSet.addConstraint(cm);
                fpSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([2, 2, 2]));

                const settings = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                pin.initConstraintDynamics(model, data, fpSet);
                pin.constraintDynamics(model, data, qClosed,
                    new Float64Array(model.nv), new Float64Array(model.nv),
                    fpSet, settings);

                const forceAfterDyn = fpSet.getData(0).contactForce;
                check(assert(maxAbs(forceAfterDyn.linear) > 1e-12 || maxAbs(forceAfterDyn.linear) > 0,
                    'Dynamics produces non-trivial contact force'));

                fpSet.evaluate(model, data, qClosed);
                const forceAfterEval = fpSet.getData(0).contactForce;
                check(assertVecClose(forceAfterEval.linear, Array.from(forceAfterDyn.linear), 1e-12,
                    'Evaluate preserves linear contact force'));
                check(assertVecClose(forceAfterEval.angular, Array.from(forceAfterDyn.angular), 1e-12,
                    'Evaluate preserves angular contact force'));
            });

            runSection('RigidConstraintSet replaceConstraint', () => {
                const rpSet = track(new pin.RigidConstraintSet(model));

                const cm3dLocalRp = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const idx = rpSet.addConstraint(cm3dLocalRp);
                check(assert(idx === 0 && rpSet.count === 1 && rpSet.constraintDim === 3,
                    'Initial constraint added'));
                const revBefore = rpSet.revision;

                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                const cmReplaceSame = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset2, j4, taskOffset1, pin.ReferenceFrame.LOCAL
                ));
                rpSet.replaceConstraint(0, cmReplaceSame);
                check(assert(rpSet.count === 1 && rpSet.constraintDim === 3,
                    'Same-size replacement preserves count and dim'));
                check(assert(rpSet.revision === revBefore + 1,
                    'Same-size replacement increments revision'));
                check(assert(rpSet.rowOffset(0) === 0, 'Row offset preserved after same-size replacement'));

                const resultReplacedSame = rpSet.evaluate(model, data, q);
                check(assert(resultReplacedSame.rows === 3 && resultReplacedSame.cols === model.nv
                    && allFinite(resultReplacedSame.residual),
                    'Evaluate works after same-size replacement'));

                const cmReplace6d = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                rpSet.replaceConstraint(0, cmReplace6d);
                check(assert(rpSet.count === 1 && rpSet.constraintDim === 6,
                    '3D-to-6D replacement updates constraintDim to 6'));
                const resultReplaced6d = rpSet.evaluate(model, data, q);
                check(assert(resultReplaced6d.rows === 6 && allFinite(resultReplaced6d.residual),
                    'Evaluate works after 3D-to-6D replacement'));

                const cmReplace3dBack = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                rpSet.replaceConstraint(0, cmReplace3dBack);
                check(assert(rpSet.constraintDim === 3, '6D-to-3D replacement restores dim'));
                const resultReplaced3dBack = rpSet.evaluate(model, data, q);
                check(assert(resultReplaced3dBack.rows === 3 && allFinite(resultReplaced3dBack.residual),
                    'Evaluate works after 6D-to-3D replacement'));
            });

            runSection('replaceConstraint: error handling', () => {
                let errorCaught;
                const errSet = track(new pin.RigidConstraintSet(model));
                const cmBase = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                errSet.addConstraint(cmBase);

                errorCaught = false;
                try { errSet.replaceConstraint(-1, cmBase); } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Negative index throws'));

                errorCaught = false;
                try { errSet.replaceConstraint(5, cmBase); } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Out-of-range index throws'));

                errorCaught = false;
                try {
                    const cmWorld = pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.WORLD
                    );
                    try { errSet.replaceConstraint(0, cmWorld); } catch (e) { errorCaught = true; }
                    cmWorld.delete();
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'WORLD frame replacement throws'));

                errorCaught = false;
                try {
                    const cmBadJoint = pin.createRigidConstraintModel(
                        pin.ContactType.CONTACT_3D, model, 99, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                    );
                    try { errSet.replaceConstraint(0, cmBadJoint); } catch (e) { errorCaught = true; }
                    cmBadJoint.delete();
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Invalid joint ID replacement throws'));

                check(assert(errSet.count === 1 && errSet.constraintDim === 3,
                    'Set unchanged after failed replacements'));
            });

            runSection('replaceConstraint: revision causes Cholesky reallocation', () => {
                const revSet = track(new pin.RigidConstraintSet(model));
                const cm1 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                revSet.addConstraint(cm1);

                const revChol = track(pin.createContactCholeskyDecomposition(model, revSet));
                revChol.compute(model, data, revSet, 1e-4);
                check(assert(revChol.constraintDim === 3 && revChol.size === model.nv + 3,
                    'Cholesky initialized at 3 dim'));

                const cmReplace6d = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                revSet.replaceConstraint(0, cmReplace6d);
                check(assert(revSet.constraintDim === 6, 'Dimension changed by replacement'));

                revChol.compute(model, data, revSet, 1e-4);
                check(assert(revChol.constraintDim === 6 && revChol.size === model.nv + 6,
                    'Cholesky reallocated after replacement'));
                const sol = revChol.solve(new Float64Array(revChol.size));
                check(assert(allFinite(sol), 'Solve works after replacement-triggered reallocation'));
            });

            runSection('replaceConstraint: dynamics after replacement', () => {
                const dynSet = track(new pin.RigidConstraintSet(model));
                const cmInit = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                dynSet.addConstraint(cmInit);
                dynSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([2, 2, 2]));

                const settings = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                pin.constraintDynamics(model, data, qClosed,
                    new Float64Array(model.nv), new Float64Array(model.nv),
                    dynSet, settings);

                const cmNew = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset2, j4, taskOffset1, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                dynSet.replaceConstraint(0, cmNew);
                dynSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([2, 2, 2]));

                const acc = pin.constraintDynamics(model, data, qClosed,
                    new Float64Array(model.nv), new Float64Array(model.nv),
                    dynSet, settings);
                check(assert(acc.length === model.nv && allFinite(acc),
                    'Dynamics works after constraint replacement'));
                const lambdaAfter = pin.getLambdaC(data);
                check(assert(lambdaAfter.length === 3 && allFinite(lambdaAfter),
                    'Lambda_c has correct dim after replacement'));
            });

            runSection('replaceConstraint: mixed set with permanent + replaceable', () => {
                const mixSet = track(new pin.RigidConstraintSet(model));

                const cmPermanent = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                mixSet.addConstraint(cmPermanent);
                check(assert(mixSet.constraintDim === 3 && mixSet.rowOffset(0) === 0,
                    'Permanent constraint added at index 0'));

                const cmTargetInit = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                mixSet.addConstraint(cmTargetInit);
                check(assert(mixSet.count === 2 && mixSet.constraintDim === 3 + 6,
                    'Permanent + target set assembled'));
                check(assert(mixSet.rowOffset(0) === 0 && mixSet.rowOffset(1) === 3,
                    'Row offsets correct'));

                const mixQ = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                const mixChol = track(pin.createContactCholeskyDecomposition(model, mixSet));
                mixChol.compute(model, data, mixSet, 1e-4);
                check(assert(mixChol.constraintDim === 9, 'Cholesky dim matches set'));
                const sol1 = mixChol.solve(new Float64Array(mixChol.size));
                check(assert(allFinite(sol1), 'Solve on mixed set works'));

                const mixEval1 = mixSet.evaluate(model, data, mixQ);
                check(assert(mixEval1.rows === 9 && allFinite(mixEval1.residual),
                    'Evaluate on mixed set works'));

                const cmNewTarget = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset2, j4, taskOffset1, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                mixSet.replaceConstraint(1, cmNewTarget);
                check(assert(mixSet.count === 2 && mixSet.constraintDim === 3 + 3,
                    'Replaced target preserves set count, dim updated'));
                check(assert(mixSet.rowOffset(0) === 0 && mixSet.rowOffset(1) === 3,
                    'Row offsets unchanged after target replacement'));

                mixChol.compute(model, data, mixSet, 1e-4);
                check(assert(mixChol.constraintDim === 6, 'Cholesky reallocated after dim change'));
                const sol2 = mixChol.solve(new Float64Array(mixChol.size));
                check(assert(allFinite(sol2), 'Solve after dim-changing replacement works'));

                const mixEval2 = mixSet.evaluate(model, data, mixQ);
                check(assert(mixEval2.rows === 6 && allFinite(mixEval2.residual),
                    'Evaluate after target replacement works'));

                const mixSettings = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                mixSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([1, 1, 1]));
                mixSet.setConstraintGains(1,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([1, 1, 1]));
                pin.initConstraintDynamics(model, data, mixSet);
                const mixAcc = pin.constraintDynamics(model, data, mixQ,
                    new Float64Array(model.nv), new Float64Array(model.nv),
                    mixSet, mixSettings);
                check(assert(mixAcc.length === model.nv && allFinite(mixAcc),
                    'Dynamics works after target replacement'));
            });

            runSection('replaceConstraint: revision tracking', () => {
                const revSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                revSet.addConstraint(cm);
                const revAfterAdd = revSet.revision;
                check(assert(revAfterAdd === 1, 'Revision after add'));

                const cm2 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset2, j4, taskOffset1, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
                ));
                revSet.replaceConstraint(0, cm2);
                check(assert(revSet.revision === revAfterAdd + 1,
                    'Replace alone increments revision'));

                const cm3dReplace6d = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_6D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                revSet.replaceConstraint(0, cm3dReplace6d);
                check(assert(revSet.revision === revAfterAdd + 2,
                    'Second replacement increments revision again'));
            });

            runSection('Regression: One-Element Set Replaces Singleton', () => {
                const oneSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                oneSet.addConstraint(cm);

                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                const evalResult = oneSet.evaluate(model, data, q);
                check(assert(evalResult.rows === 3 && evalResult.cols === model.nv,
                    'One-element set evaluates correctly'));

                const oneCholesky = track(pin.createContactCholeskyDecomposition(model, oneSet));
                oneCholesky.compute(model, data, oneSet, 1e-4);
                const sol = oneCholesky.solve(new Float64Array(oneCholesky.size));
                check(assert(allFinite(sol), 'One-element set Cholesky solve works'));

                const oneSettings = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                oneSet.setConstraintGains(0,
                    new Float64Array([10, 10, 10]),
                    new Float64Array([2, 2, 2]));
                pin.initConstraintDynamics(model, data, oneSet);
                const acc = pin.constraintDynamics(model, data, q,
                    new Float64Array(model.nv), new Float64Array(model.nv),
                    oneSet, oneSettings);
                check(assert(acc.length === model.nv && allFinite(acc),
                    'One-element set constrained dynamics works'));
            });

            runSection('solveSVD', () => {
                // Well-conditioned square system
                const A_sq = new Float64Array([
                    4, 1, 0,
                    1, 3, 1,
                    0, 1, 2
                ]);
                const b_sq = new Float64Array([1, 2, 3]);
                const result = pin.solveSVD(A_sq, 3, 3, b_sq);

                check(assert(result.x instanceof Float64Array,
                    'x is Float64Array'));
                check(assert(result.x.length === 3,
                    'x has length 3 (cols)'));
                check(assert(typeof result.rank === 'number',
                    'rank is number'));
                check(assert(result.singularValues instanceof Float64Array,
                    'singularValues is Float64Array'));
                check(assert(result.singularValues.length === 3,
                    'singularValues has length min(rows,cols)=3'));
                check(assert(typeof result.cond === 'number' && Number.isFinite(result.cond),
                    'cond is finite number'));

                check(assert(result.rank === 3,
                    'Full rank matrix: rank=3'));

                // Reconstruct A*x to verify solution
                const Ax = new Float64Array(3);
                for (let i = 0; i < 3; i++) {
                    for (let j = 0; j < 3; j++) {
                        Ax[i] += A_sq[j * 3 + i] * result.x[j];
                    }
                }
                check(assertClose(Ax[0], b_sq[0], 1e-6,
                    'Square system: (Ax)[0] ≈ b[0]'));
                check(assertClose(Ax[1], b_sq[1], 1e-6,
                    'Square system: (Ax)[1] ≈ b[1]'));
                check(assertClose(Ax[2], b_sq[2], 1e-6,
                    'Square system: (Ax)[2] ≈ b[2]'));

                // Singular values sorted descending
                const sv = result.singularValues;
                check(assert(sv[0] >= sv[1] && sv[1] >= sv[2],
                    'Singular values are sorted descending'));
                check(assertClose(result.cond, sv[0] / sv[2], 1e-12,
                    'cond = max(sv) / min(sv)'));

                // Overdetermined system (rows > cols) — use a consistent system
                const A_over = new Float64Array([2, 0, 2, 0, 1, 1]);
                const b_over = new Float64Array([4, 1, 5]);
                const result_over = pin.solveSVD(A_over, 3, 2, b_over);
                check(assert(result_over.x.length === 2,
                    'Overdetermined: x length = cols (2)'));
                check(assert(result_over.singularValues.length === 2,
                    'Overdetermined: min(3,2)=2 singular values'));
                check(assert(allFinite(result_over.x),
                    'Overdetermined: solution has finite values'));

                const Ax_over = new Float64Array(3);
                for (let i = 0; i < 3; i++) {
                    for (let j = 0; j < 2; j++) {
                        Ax_over[i] += A_over[j * 3 + i] * result_over.x[j];
                    }
                }
                check(assertClose(Ax_over[0], b_over[0], 1e-6,
                    'Overdetermined: (Ax)[0] ≈ b[0]'));
                check(assertClose(Ax_over[1], b_over[1], 1e-6,
                    'Overdetermined: (Ax)[1] ≈ b[1]'));
                check(assertClose(Ax_over[2], b_over[2], 1e-6,
                    'Overdetermined: (Ax)[2] ≈ b[2]'));

                // Underdetermined system (rows < cols)
                const A_under = new Float64Array([
                    1, 0, 2,
                    0, 1, 1
                ]);
                const b_under = new Float64Array([3, 5]);
                const result_under = pin.solveSVD(A_under, 2, 3, b_under);
                check(assert(result_under.x.length === 3,
                    'Underdetermined: x length = cols (3)'));
                check(assert(result_under.singularValues.length === 2,
                    'Underdetermined: min(2,3)=2 singular values'));
                check(assert(allFinite(result_under.x),
                    'Underdetermined: solution has finite values'));

                // Verify Ax = b
                const Ax_under = new Float64Array(2);
                for (let i = 0; i < 2; i++) {
                    for (let j = 0; j < 3; j++) {
                        Ax_under[i] += A_under[j * 2 + i] * result_under.x[j];
                    }
                }
                check(assertClose(Ax_under[0], b_under[0], 1e-6,
                    'Underdetermined: (Ax)[0] ≈ b[0]'));
                check(assertClose(Ax_under[1], b_under[1], 1e-6,
                    'Underdetermined: (Ax)[1] ≈ b[1]'));

                // Rank-deficient matrix
                const A_def = new Float64Array([
                    1, 2, 3,
                    2, 4, 6,
                    3, 6, 9
                ]);
                const b_def = new Float64Array([6, 12, 18]);
                const result_def = pin.solveSVD(A_def, 3, 3, b_def);
                check(assert(result_def.rank === 1,
                    'Rank-deficient rank=1'));

                // Damped solution with lambda > 0
                const result_damped = pin.solveSVD(A_def, 3, 3, b_def, 1.0, 1e-6);
                check(assert(result_damped.rank === 1,
                    'Damped: rank still 1'));
                check(assert(allFinite(result_damped.x),
                    'Damped: solution remains finite'));
                let norm_undamped = 0, norm_damped = 0;
                for (let i = 0; i < 3; i++) {
                    norm_undamped += result_def.x[i] * result_def.x[i];
                    norm_damped += result_damped.x[i] * result_damped.x[i];
                }
                norm_undamped = Math.sqrt(norm_undamped);
                norm_damped = Math.sqrt(norm_damped);
                check(assert(norm_damped <= norm_undamped,
                    'Damped norm ≤ undamped norm'));

                // Full parameter overload
                const result_full = pin.solveSVD(A_sq, 3, 3, b_sq, 0.5, 1e-8);
                check(assert(result_full.x instanceof Float64Array,
                    'Full params: x is Float64Array'));
                check(assert(result_full.rank === 3,
                    'Full params: rank=3'));

                // Validation: A.length !== rows * cols
                let threw = false;
                try { pin.solveSVD(new Float64Array([1, 2, 3]), 2, 2, b_sq); }
                catch (e) { threw = true; }
                check(assert(threw, 'A.length mismatch throws'));

                // Validation: b.length !== rows
                threw = false;
                try { pin.solveSVD(A_sq, 3, 3, new Float64Array([1, 2])); }
                catch (e) { threw = true; }
                check(assert(threw, 'b.length mismatch throws'));

                // Validation: non-finite in A
                threw = false;
                const A_nan = new Float64Array([NaN, 1, 0, 1, 3, 1, 0, 1, 2]);
                try { pin.solveSVD(A_nan, 3, 3, b_sq); }
                catch (e) { threw = true; }
                check(assert(threw, 'Non-finite A throws'));

                // Validation: non-finite in b
                threw = false;
                try { pin.solveSVD(A_sq, 3, 3, new Float64Array([1, NaN, 3])); }
                catch (e) { threw = true; }
                check(assert(threw, 'Non-finite b throws'));

                // Validation: negative lambda
                threw = false;
                try { pin.solveSVD(A_sq, 3, 3, b_sq, -0.1, 1e-6); }
                catch (e) { threw = true; }
                check(assert(threw, 'Negative lambda throws'));

                // Validation: non-positive threshold
                threw = false;
                try { pin.solveSVD(A_sq, 3, 3, b_sq, 0.0, 0.0); }
                catch (e) { threw = true; }
                check(assert(threw, 'Non-positive threshold throws'));

                // Validation: zero rows
                threw = false;
                try { pin.solveSVD(new Float64Array(0), 0, 3, new Float64Array(0)); }
                catch (e) { threw = true; }
                check(assert(threw, 'Zero rows throws'));

                // Validation: zero cols
                threw = false;
                try { pin.solveSVD(new Float64Array(0), 3, 0, new Float64Array([1, 2, 3])); }
                catch (e) { threw = true; }
                check(assert(threw, 'Zero cols throws'));
            });

            runSection('updatePlacements: placement update without revision bump', () => {
                const upSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                upSet.addConstraint(cm);
                const revBefore = upSet.revision;

                const newJ1p = { translation: new Float64Array([2, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                const newJ2p = { translation: new Float64Array([3, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                upSet.updatePlacements([{ index: 0, joint1Placement: newJ1p, joint2Placement: newJ2p }]);

                check(assert(upSet.revision === revBefore,
                    'updatePlacements does not bump revision'));
                check(assert(upSet.count === 1 && upSet.constraintDim === 3,
                    'updatePlacements preserves count and dim'));

                const mi = upSet.getModel(0);
                check(assertVecClose(mi.joint1Placement.translation, [2, 0, 0], 1e-12,
                    'joint1Placement translation updated'));
                check(assertVecClose(mi.joint2Placement.translation, [3, 0, 0], 1e-12,
                    'joint2Placement translation updated'));

                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);
                const evalResult = upSet.evaluate(model, data, q);
                check(assert(evalResult.rows === 3 && allFinite(evalResult.residual),
                    'Evaluate works after placement-only update'));
            });

            runSection('updatePlacements: Cholesky reuse after placement update', () => {
                const upSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                upSet.addConstraint(cm);

                const upChol = track(pin.createContactCholeskyDecomposition(model, upSet));
                upChol.compute(model, data, upSet, 1e-4);
                check(assert(upChol.constraintDim === 3 && upChol.size === model.nv + 3,
                    'Cholesky initialized'));

                const revBefore = upSet.revision;
                const newJ1p = { translation: new Float64Array([2, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                const newJ2p = { translation: new Float64Array([3, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                upSet.updatePlacements([{ index: 0, joint1Placement: newJ1p, joint2Placement: newJ2p }]);

                check(assert(upSet.revision === revBefore,
                    'Revision unchanged after updatePlacements'));
                check(assert(upChol.constraintDim === 3 && upChol.size === model.nv + 3,
                    'Cholesky dimensions unchanged'));

                upChol.compute(model, data, upSet, 1e-4);
                const sol = upChol.solve(new Float64Array(upChol.size));
                check(assert(allFinite(sol), 'Solve works after placement-only update'));
            });

            runSection('updatePlacements: Cholesky computed before update still solves', () => {
                const upSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                upSet.addConstraint(cm);

                const upChol = track(pin.createContactCholeskyDecomposition(model, upSet));
                const q = new Float64Array([Math.PI / 4, Math.PI / 6, 2 * Math.PI / 5, -Math.PI / 5]);

                upChol.compute(model, data, upSet, 1e-4);
                const solBefore = upChol.solve(new Float64Array(upChol.size));

                const newJ1p = { translation: new Float64Array([2, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                const newJ2p = { translation: new Float64Array([3, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                upSet.updatePlacements([{ index: 0, joint1Placement: newJ1p, joint2Placement: newJ2p }]);

                upChol.compute(model, data, upSet, 1e-4);
                const solAfter = upChol.solve(new Float64Array(upChol.size));

                check(assert(solBefore.length === solAfter.length, 'Solve sizes match'));
                check(assert(allFinite(solBefore), 'Solve before update is finite'));
                check(assert(allFinite(solAfter), 'Solve after placement update is finite'));
            });

            runSection('updatePlacements: sparse update only affects specified indices', () => {
                const upSet = track(new pin.RigidConstraintSet(model));
                const cm1 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                const cm2 = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                upSet.addConstraint(cm1);
                upSet.addConstraint(cm2);

                const newJ1p = { translation: new Float64Array([5, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                const newJ2p = { translation: new Float64Array([6, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) };
                upSet.updatePlacements([{ index: 0, joint1Placement: newJ1p, joint2Placement: newJ2p }]);

                check(assertVecClose(upSet.getModel(0).joint1Placement.translation, [5, 0, 0], 1e-12,
                    'Index 0 joint1 placement updated'));
                check(assertVecClose(upSet.getModel(1).joint1Placement.translation,
                    [1, 0, 0], 1e-12,
                    'Index 1 joint1 placement unchanged'));
            });

            runSection('updatePlacements: validation errors before mutation', () => {
                let errorCaught;

                const upSet = track(new pin.RigidConstraintSet(model));
                const cm = track(pin.createRigidConstraintModel(
                    pin.ContactType.CONTACT_3D, model, j3, taskOffset1, j4, taskOffset2, pin.ReferenceFrame.LOCAL
                ));
                upSet.addConstraint(cm);
                const revBefore = upSet.revision;

                errorCaught = false;
                try {
                    upSet.updatePlacements([{ index: -1, joint1Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
                        joint2Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
                    }]);
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Negative index throws'));

                errorCaught = false;
                try {
                    upSet.updatePlacements([{ index: 99, joint1Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
                        joint2Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
                    }]);
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Out-of-range index throws'));

                errorCaught = false;
                try {
                    upSet.updatePlacements([{ index: 0, joint1Placement:
                        { translation: new Float64Array([1, NaN, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
                        joint2Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
                    }]);
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Non-finite translation throws'));

                errorCaught = false;
                try {
                    upSet.updatePlacements([{ index: 0, joint1Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, NaN, 0, 0, 0, 1]) },
                        joint2Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
                    }]);
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Non-finite rotation throws'));

                errorCaught = false;
                try {
                    upSet.updatePlacements([{ index: 0, joint1Placement:
                        { translation: new Float64Array([1, Infinity, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
                        joint2Placement:
                        { translation: new Float64Array([1, 0, 0]), rotation: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }
                    }]);
                } catch (e) { errorCaught = true; }
                check(assert(errorCaught, 'Infinite value throws'));

                check(assert(upSet.revision === revBefore,
                    'Revision unchanged after failed updatePlacements'));

                const mi2 = upSet.getModel(0);
                check(assertVecClose(mi2.joint1Placement.translation,
                    [1, 0, 0], 1e-12,
                    'Placement unchanged after failed update'));
            });

            runSection('setKinematicMetric', () => {
                const nv = model.nv;
                const diag = new Float64Array([1, 2, 3, 4]);

                pin.setKinematicMetric(data, diag);
                const M = pin.getM(data);

                for (let i = 0; i < nv; i++) {
                    check(assertClose(M[i * nv + i], diag[i], 1e-14,
                        `M(${i},${i}) equals diagonal[${i}]`));
                }

                for (let i = 0; i < nv; i++) {
                    for (let j = 0; j < nv; j++) {
                        if (i !== j) {
                            check(assertClose(M[j * nv + i], 0, 1e-14,
                                `M(${i},${j}) is zero`));
                        }
                    }
                }

                pin.crba(model, data, qClosed);
                const MAfterCrba = pin.crba(model, data, qClosed);
                let isSymmetric = true;
                for (let i = 0; i < nv; i++) {
                    for (let j = 0; j < nv; j++) {
                        if (Math.abs(MAfterCrba[i * nv + j] - MAfterCrba[j * nv + i]) > 1e-12) {
                            isSymmetric = false;
                        }
                    }
                }
                check(assert(isSymmetric && allFinite(MAfterCrba),
                    'crba overwrites M with physical mass matrix'));

                let errorCaught = false;
                try {
                    pin.setKinematicMetric(data, new Float64Array([1, 2, 3]));
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Wrong-length diagonal throws'));

                errorCaught = false;
                try {
                    pin.setKinematicMetric(data, new Float64Array([1, NaN, 3, 4]));
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Non-finite diagonal throws'));

                errorCaught = false;
                try {
                    pin.setKinematicMetric(data, new Float64Array([1, 2, Infinity, 4]));
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Infinity diagonal throws'));
            });

            runSection('KKT RHS validation: constraintDynamics input checks', () => {
                const settings = track(new pin.ProximalSettings(1e-8, 1e-6, 10));
                const velocity = new Float64Array(model.nv);
                const torque = new Float64Array(model.nv);

                const wrongQ = new Float64Array([0, 1, 2]);
                const wrongV = new Float64Array([0, 1, 2]);
                const wrongTau = new Float64Array([0, 1, 2]);
                const nanQ = new Float64Array([NaN, 0, 0, 0]);
                const nanV = new Float64Array([0, NaN, 0, 0]);
                const nanTau = new Float64Array([0, 0, NaN, 0]);

                let errorCaught;

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, wrongQ, velocity, torque, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Wrong-length q throws'));

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, qClosed, wrongV, torque, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Wrong-length v throws'));

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, qClosed, velocity, wrongTau, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Wrong-length tau throws'));

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, nanQ, velocity, torque, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Non-finite q throws'));

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, qClosed, nanV, torque, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Non-finite v throws'));

                errorCaught = false;
                try {
                    pin.constraintDynamics(model, data, qClosed, velocity, nanTau, dynamicsSet, settings);
                } catch (e) {
                    errorCaught = true;
                }
                check(assert(errorCaught, 'Non-finite tau throws'));

                const acc = pin.constraintDynamics(
                    model, data, qClosed, velocity, torque, dynamicsSet, settings
                );
                check(assert(acc.length === model.nv && allFinite(acc),
                    'Valid constraintDynamics call succeeds after prior input errors'));
                const lambda = pin.getLambdaC(data);
                check(assert(lambda.length === 3 && allFinite(lambda),
                    'GetLambdaC returns valid multipliers after input validation error recovery'));
            });

        } finally {
            for (let i = resources.length - 1; i >= 0; i--) {
                resources[i].delete();
            }
        }

        return { passed, failed };
    }
};
