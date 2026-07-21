This prototype uses [pinocchio js](https://github.com/Mostafasaad1/pinocchio-js) to compute and test the forward kinematics, inverse force-to-torque capabilities.

## Get Start
1. npm install
2. npm run dev
3. Open the example at `http://localhost:5173`

## Mechanism Topology
This example replicates the 2DoF pantograph structure to examine the closed-loop kinematics, which is achieved by adding a closure constraint to an open-loop kinematic tree.

The model is defined in the `pinocchio-adapter.ts::buildPinocchioModel()`.

                     Ground / universe (joint 0) 
                            |      |
		                    J1 == J2   (Overlap start point)
	                       /        \
                     Link 1          Link 2
                        /              \
                       J3               J4
                        \               /
                     Link 3           Link 4
		                  \           /
	                        C1 == C2
	                       closure point

- **Branch A** (red): ground joint `J1` → distal joint `J3` → closure frame `C1`
- **Branch B** (blue): ground joint `J2` → distal joint `J4` → closure frame `C2`
- The loop is closed when `C1` and `C2` coincide by enforcing the closure constraint.

## FK and the Closure Projection

1. Click the FK tab on top.
2. Adjust the joint angles by moving the sliders at the bottom of the page.
3. Three.js calls `main::updateView()`, which:
	1. Calls WASM `forwardKinematics(model, data, q)` + `getJointPlacement(...)` through `pinocchio-adapter::fk()`
	2. Updates the link and joint rendering.
4. Press the "PROJECT TO CLOSURE" button to merge the `C1` and `C2` positions.
5. `main.ts` calls the DLS solver to converge the `C1` and `C2` positions through multiple iterations in the `btnProject` event.
	1. Checks the `C1` to `C2` distance by calling `main::closureResidual()`.
	2. Gets the Jacobian matrix by calling `main::closureJacobian(q, active)`, which helps convert joint velocity into the derivative of the closure distance.
	3. Uses Gaussian elimination, the Jacobian matrix, and matrix inversion to find the smallest joint movement that closes the gap.
	- The DLS solver is written in JS, which duplicates the Pinocchio implementation; however, `pinocchio_js` does not expose it.
6. Three.js calls `updateView()` to render the new position.

## IK
1. Click the IK tab on top.
2. Move the target cursor on the page.
3. `main.ts` calls the DLS solver to converge the endpoint distance to the target in `main::doTargetIKSolve()`.
4. Three.js calls `updateView()` to render the new position.

## Force to Torque
1. Click the Force to Torque tab on top.
2. Set the force vector in the bottom panel, and select which joints are active/passive (above the sliders).
3. `force-torque.ts` calls `adapter.computeJointJacobians(q)` to get two Jacobian matrices that convert joint velocity into endpoint velocity.
4. Combines the independent endpoint Jacobians into the closed-loop endpoint Jacobian with the closure constraint applied (the two endpoint forces are connected).
5. Reduces the passive-joint partition in the closed-loop endpoint Jacobian (`force-torque.ts::computeReducedJacobian()`).
	1. Infers the passive joint movement based on the active joint movement.
	2. Reduces the size of the Jacobian by substituting the passive joints with active joints.
6. Computes the torque using the Jacobian (`force-torque.ts::computeForceTorque`).
7. Updates the visualization (`main::updateForceTorqueDisplay()`).