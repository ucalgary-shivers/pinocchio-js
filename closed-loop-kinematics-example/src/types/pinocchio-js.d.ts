declare module "pinocchio-js" {
  interface PinocchioModuleOptions {
    locateFile?: (file: string, prefix?: string) => string;
  }

  interface JointPlacement {
    translation: Float64Array;
    rotation: Float64Array;
  }

  interface PinocchioModule {
    Model: new () => Model;
    Data: new (model: Model) => Data;
    SE3: SE3Static;
    Inertia: InertiaStatic;
    JointModelRZ: new () => JointModel;
    JointModelRX: new () => JointModel;
    JointModelRY: new () => JointModel;
    ReferenceFrame: { WORLD: number; LOCAL: number; LOCAL_WORLD_ALIGNED: number };

    addJoint: (model: Model, parentId: number, joint: JointModel, placement: SE3, name: string) => number;
    appendBodyToJoint: (model: Model, jointId: number, inertia: Inertia, placement: SE3) => void;
    forwardKinematics: (model: Model, data: Data, q: Float64Array) => void;
    getJointPlacement: (data: Data, jointId: number) => JointPlacement;
    updateFramePlacements: (model: Model, data: Data) => void;
    computeJointJacobians: (model: Model, data: Data, q: Float64Array) => void;
    getJointJacobian: (model: Model, data: Data, jointId: number, refFrame: number) => Float64Array;
    neutralConfiguration: (model: Model) => Float64Array;
    computeTotalMass: (model: Model) => number;
    flushPendingDeletes: () => void;
  }

  interface Model {
    nq: number;
    nv: number;
    njoints: number;
    delete: () => void;
    isDeleted: () => boolean;
  }

  interface Data {
    delete: () => void;
    isDeleted: () => boolean;
  }

  interface SE3 {
    delete: () => void;
    isDeleted: () => boolean;
  }

  interface SE3Static {
    identity: () => SE3;
    fromXyzRpy: (x: number, y: number, z: number, r: number, p: number, yaw: number) => SE3;
    fromRotationTranslation: (rotation: Float64Array, translation: Float64Array) => SE3;
  }

  interface Inertia {
    delete: () => void;
    isDeleted: () => boolean;
  }

  interface InertiaStatic {
    fromMassComInertia: (mass: number, com: number[], inertia: number[]) => Inertia;
  }

  interface JointModel {
    delete: () => void;
    isDeleted: () => boolean;
  }

  const init: (options?: PinocchioModuleOptions) => Promise<PinocchioModule>;
  export default init;
}
