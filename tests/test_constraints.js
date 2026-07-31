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
            const constraintData = track(pin.createConstraintData(constraintModel));
            const cholesky = track(pin.createContactCholeskyDecomposition(model, constraintModel));

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

                const initialTransform = constraintData.c1Mc2;
                check(assert(initialTransform.translation.length === 3 && initialTransform.rotation.length === 9,
                    'Constraint data exposes c1Mc2'));
                check(assert(constraintData.c1Mc2Translation.length === 3,
                    'Constraint data exposes c1Mc2 translation'));
                const initialForce = constraintData.contactForce;
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

                const defaultData = new pin.RigidConstraintData();
                try {
                    check(assert(typeof defaultData.delete === 'function',
                        'Default RigidConstraintData constructor is usable'));
                } finally {
                    defaultData.delete();
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

                cholesky.compute(model, data, constraintModel, constraintData, factorizationMu);
                check(assertVecClose(constraintData.c1Mc2Translation, [0, 0, 0], 1e-10,
                    'Known closed configuration has zero Closure Constraint translation'));
                check(assertVecClose(constraintData.c1Mc2.rotation, [
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
                    J1Local, J2Local, constraintData.c1Mc2.rotation, model.nv
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
                constraintModel.correctorKp = new Float64Array([10, 10, 10]);
                constraintModel.correctorKd = new Float64Array([
                    criticalDamping, criticalDamping, criticalDamping,
                ]);

                const velocity = new Float64Array(model.nv);
                const torque = new Float64Array([1, 0.25, -0.5, -0.75]);
                pin.initConstraintDynamics(model, data, constraintModel);
                const acceleration1 = pin.constraintDynamics(
                    model,
                    data,
                    qClosed,
                    velocity,
                    torque,
                    constraintModel,
                    constraintData,
                    settings
                );
                const storedAcceleration1 = pin.getDDq(data);
                const lambda1 = pin.getLambdaC(data);
                const force1 = constraintData.contactForce;

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
                    J1Local, J2Local, constraintData.c1Mc2.rotation, model.nv
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
                    constraintModel,
                    constraintData,
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
                    cholesky.compute(model, data, constraintModel, constraintData, mu);

                    const constraintValue = constraintData.c1Mc2Translation;
                    const relativeRotation = constraintData.c1Mc2.rotation;
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
                    for (let i = 0; i < model.nv; i++) q[i] -= step[3 + i];
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
                pin.initConstraintDynamics(model, data, constraintModel);
                const acceleration = pin.constraintDynamics(
                    model,
                    data,
                    q,
                    new Float64Array(model.nv),
                    new Float64Array(model.nv),
                    constraintModel,
                    constraintData,
                    postProjectionSettings
                );
                check(assert(acceleration.length === model.nv && allFinite(acceleration),
                    'Projected configuration initializes constrained dynamics'));
            });
        } finally {
            for (let i = resources.length - 1; i >= 0; i--) {
                resources[i].delete();
            }
        }

        return { passed, failed };
    }
};
