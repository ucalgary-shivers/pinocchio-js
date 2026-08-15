// ──────────────────────────────────────────────────────────────────
// Pinocchio WASM — Embind Wrapper
// Exposes Pinocchio's core C++ API to JavaScript via Emscripten Embind.
// ──────────────────────────────────────────────────────────────────

#include <emscripten/bind.h>
#include <emscripten/val.h>

// Pinocchio headers
#include <pinocchio/fwd.hpp>
#include <pinocchio/multibody/model.hpp>
#include <pinocchio/multibody/data.hpp>
#include <pinocchio/multibody/frame.hpp>
#include <pinocchio/algorithm/rnea.hpp>
#include <pinocchio/algorithm/jacobian.hpp>
#include <pinocchio/algorithm/center-of-mass.hpp>
#include <pinocchio/algorithm/kinematics.hpp>
#include <pinocchio/algorithm/joint-configuration.hpp>
#include <pinocchio/algorithm/frames.hpp>
#include <pinocchio/algorithm/aba.hpp>
#include <pinocchio/algorithm/crba.hpp>
#include <pinocchio/algorithm/energy.hpp>
#include <pinocchio/multibody/joint/joint-composite.hpp>
// Constraint & closed-loop kinematics
#include <pinocchio/algorithm/contact-info.hpp>
#include <pinocchio/algorithm/contact-cholesky.hpp>
#include <pinocchio/algorithm/constrained-dynamics.hpp>
#include <pinocchio/algorithm/proximal.hpp>
#include <pinocchio/spatial/explog.hpp>
#include <Eigen/SVD>
#include <stdexcept>
#include <cmath>
#include <limits>
#include <string>


using namespace emscripten;

// ─── Type Aliases ────────────────────────────────────────────────

using Model   = pinocchio::Model;
using Data    = pinocchio::Data;
using SE3     = pinocchio::SE3;
using Inertia = pinocchio::Inertia;
using JointIndex = pinocchio::JointIndex;
using FrameIndex = pinocchio::FrameIndex;

using VectorXd  = Eigen::VectorXd;
using Vector3d   = Eigen::Vector3d;
using Matrix3d   = Eigen::Matrix3d;
using MatrixXd   = Eigen::MatrixXd;

using RigidConstraintModel = pinocchio::RigidConstraintModelTpl<double, 0>;
using RigidConstraintData  = pinocchio::RigidConstraintDataTpl<double, 0>;
using ContactCholeskyDecomposition = pinocchio::ContactCholeskyDecompositionTpl<double, 0>;
using ProximalSettings = pinocchio::ProximalSettingsTpl<double>;


// ─── Eigen ↔ JavaScript Helpers ─────────────────────────────────

/**
 * Convert a JS Float64Array (or regular Array) to Eigen::VectorXd.
 */
VectorXd jsToVectorXd(const val& arr) {
    const unsigned len = arr["length"].as<unsigned>();
    VectorXd v(len);
    for (unsigned i = 0; i < len; ++i)
        v[i] = arr[i].as<double>();
    return v;
}

/**
 * Convert Eigen::VectorXd to a JS Float64Array (copy).
 */
val vectorXdToJs(const VectorXd& v) {
    val result = val::global("Float64Array").new_(v.size());
    for (Eigen::Index i = 0; i < v.size(); ++i)
        result.set(i, val(v[i]));
    return result;
}

/**
 * Convert a 3-element JS array to Eigen::Vector3d.
 */
Vector3d jsToVector3d(const val& arr) {
    return Vector3d(
        arr[0].as<double>(),
        arr[1].as<double>(),
        arr[2].as<double>()
    );
}

/**
 * Convert Eigen::Vector3d to a JS array [x, y, z].
 */
val vector3dToJs(const Vector3d& v) {
    val result = val::global("Float64Array").new_(3);
    result.set(0, val(v[0]));
    result.set(1, val(v[1]));
    result.set(2, val(v[2]));
    return result;
}

/**
 * Convert a 6-element JS array to Eigen::Matrix<double,6,1>.
 */
Eigen::Matrix<double,6,1> jsToVector6d(const val& arr) {
    Eigen::Matrix<double,6,1> v;
    for (int i = 0; i < 6; ++i)
        v[i] = arr[i].as<double>();
    return v;
}

/**
 * Convert a flat 9-element JS array to Eigen::Matrix3d (column-major input).
 */
Matrix3d jsToMatrix3d(const val& arr) {
    Matrix3d m;
    m(0,0) = arr[0].as<double>(); m(1,0) = arr[1].as<double>(); m(2,0) = arr[2].as<double>();
    m(0,1) = arr[3].as<double>(); m(1,1) = arr[4].as<double>(); m(2,1) = arr[5].as<double>();
    m(0,2) = arr[6].as<double>(); m(1,2) = arr[7].as<double>(); m(2,2) = arr[8].as<double>();
    return m;
}

/**
 * Convert a flat MatrixXd to a JS Float64Array (column-major).
 */
val matrixXdToJs(const MatrixXd& m) {
    val result = val::global("Float64Array").new_(m.rows() * m.cols());
    int idx = 0;
    for (Eigen::Index j = 0; j < m.cols(); ++j)
        for (Eigen::Index i = 0; i < m.rows(); ++i)
            result.set(idx++, val(m(i,j)));
    return result;
}

/**
 * Convert SE3 to a JS object { translation: Float64Array(3), rotation: Float64Array(9) }.
 */
val se3ToJs(const SE3& se3) {
    val result = val::object();
    result.set("translation", vector3dToJs(se3.translation()));
    result.set("rotation", matrixXdToJs(se3.rotation()));
    return result;
}

// ─── SE3 Factories ──────────────────────────────────────────────

/**
 * Create SE3 from rotation matrix (9 floats, column-major) + translation (3 floats).
 */
SE3 se3FromRotationTranslation(const val& rot, const val& trans) {
    return SE3(jsToMatrix3d(rot), jsToVector3d(trans));
}

/**
 *  Convert a JS {translation, rotation} placement object to SE3.
 */
SE3 se3FromJsPlacement(const val& placement) {
    return SE3(jsToMatrix3d(placement["rotation"]), jsToVector3d(placement["translation"]));
}

/**
 *  Create SE3 from xyz + rpy (URDF convention: fixed-axis XYZ = roll, pitch, yaw).
 */
SE3 se3FromXyzRpy(double x, double y, double z,
                  double roll, double pitch, double yaw) {
    Matrix3d R;
    double cr = cos(roll),  sr = sin(roll);
    double cp = cos(pitch), sp = sin(pitch);
    double cy = cos(yaw),   sy = sin(yaw);

    R(0,0) = cy*cp;  R(0,1) = cy*sp*sr - sy*cr;  R(0,2) = cy*sp*cr + sy*sr;
    R(1,0) = sy*cp;  R(1,1) = sy*sp*sr + cy*cr;  R(1,2) = sy*sp*cr - cy*sr;
    R(2,0) = -sp;    R(2,1) = cp*sr;              R(2,2) = cp*cr;

    return SE3(R, Vector3d(x, y, z));
}

/**
 * SE3 identity.
 */
SE3 se3Identity() {
    return SE3::Identity();
}

// ─── Inertia Factories ──────────────────────────────────────────

/**
 * Create Inertia from mass, center of mass [3], and inertia matrix [6] (Ixx, Ixy, Ixz, Iyy, Iyz, Izz).
 */
Inertia inertiaFromMassComInertia(double mass, const val& com_js, const val& inertia_js) {
    Vector3d com = jsToVector3d(com_js);

    double Ixx = inertia_js[0].as<double>();
    double Ixy = inertia_js[1].as<double>();
    double Ixz = inertia_js[2].as<double>();
    double Iyy = inertia_js[3].as<double>();
    double Iyz = inertia_js[4].as<double>();
    double Izz = inertia_js[5].as<double>();

    Matrix3d I;
    I << Ixx, Ixy, Ixz,
         Ixy, Iyy, Iyz,
         Ixz, Iyz, Izz;

    return Inertia(mass, com, I);
}

// ─── Joint Model Factories ──────────────────────────────────────

struct JointModelWrapper {
    enum Type {
        RX, RY, RZ,
        PX, PY, PZ,
        REVOLUTE_UNALIGNED,
        PRISMATIC_UNALIGNED,
        UNIVERSAL,
        FREE_FLYER,
        FIXED
    };

    Type type;
    Vector3d axis;
    Vector3d axis2;

    JointModelWrapper(Type t) : type(t), axis(Vector3d::UnitX()), axis2(Vector3d::UnitY()) {}
    JointModelWrapper(Type t, const Vector3d& a) : type(t), axis(a.normalized()), axis2(Vector3d::UnitY()) {}
    JointModelWrapper(const Vector3d& a1, const Vector3d& a2)
    : type(UNIVERSAL), axis(a1), axis2(a2) {}
};

JointModelWrapper makeJointModelRX() { return JointModelWrapper(JointModelWrapper::RX); }
JointModelWrapper makeJointModelRY() { return JointModelWrapper(JointModelWrapper::RY); }
JointModelWrapper makeJointModelRZ() { return JointModelWrapper(JointModelWrapper::RZ); }
JointModelWrapper makeJointModelPX() { return JointModelWrapper(JointModelWrapper::PX); }
JointModelWrapper makeJointModelPY() { return JointModelWrapper(JointModelWrapper::PY); }
JointModelWrapper makeJointModelPZ() { return JointModelWrapper(JointModelWrapper::PZ); }

JointModelWrapper makeJointModelRevoluteUnaligned(double ax, double ay, double az) {
    return JointModelWrapper(JointModelWrapper::REVOLUTE_UNALIGNED, Vector3d(ax, ay, az));
}
JointModelWrapper makeJointModelPrismaticUnaligned(double ax, double ay, double az) {
    return JointModelWrapper(JointModelWrapper::PRISMATIC_UNALIGNED, Vector3d(ax, ay, az));
}
JointModelWrapper makeJointModelUniversal(double x1, double y1, double z1,
                                          double x2, double y2, double z2) {
    const Vector3d axis1(x1, y1, z1);
    const Vector3d axis2(x2, y2, z2);
    constexpr double tolerance = 1e-12;
    if (!axis1.allFinite() || !axis2.allFinite()
        || std::abs(axis1.norm() - 1.0) > tolerance
        || std::abs(axis2.norm() - 1.0) > tolerance
        || std::abs(axis1.dot(axis2)) > tolerance)
        throw std::invalid_argument("JointModelUniversal axes must be finite, unit-length, and orthogonal");
    return JointModelWrapper(axis1, axis2);
}
JointModelWrapper makeJointModelFreeFlyer() { return JointModelWrapper(JointModelWrapper::FREE_FLYER); }
JointModelWrapper makeJointModelFixed() { return JointModelWrapper(JointModelWrapper::FIXED); }

// ─── Model Wrapper Functions ────────────────────────────────────

JointIndex modelAddJoint(Model& model,
                         JointIndex parentId,
                         const JointModelWrapper& joint,
                         const SE3& placement,
                         const std::string& name) {
    switch (joint.type) {
        case JointModelWrapper::RX:
            return model.addJoint(parentId, pinocchio::JointModelRX(), placement, name);
        case JointModelWrapper::RY:
            return model.addJoint(parentId, pinocchio::JointModelRY(), placement, name);
        case JointModelWrapper::RZ:
            return model.addJoint(parentId, pinocchio::JointModelRZ(), placement, name);
        case JointModelWrapper::PX:
            return model.addJoint(parentId, pinocchio::JointModelPX(), placement, name);
        case JointModelWrapper::PY:
            return model.addJoint(parentId, pinocchio::JointModelPY(), placement, name);
        case JointModelWrapper::PZ:
            return model.addJoint(parentId, pinocchio::JointModelPZ(), placement, name);
        case JointModelWrapper::REVOLUTE_UNALIGNED:
            return model.addJoint(parentId,
                pinocchio::JointModelRevoluteUnaligned(joint.axis),
                placement, name);
        case JointModelWrapper::PRISMATIC_UNALIGNED:
            return model.addJoint(parentId,
                pinocchio::JointModelPrismaticUnaligned(joint.axis),
                placement, name);
        case JointModelWrapper::UNIVERSAL:
            return model.addJoint(parentId,
                pinocchio::JointModelUniversal(joint.axis, joint.axis2),
                placement, name);
        case JointModelWrapper::FREE_FLYER:
            return model.addJoint(parentId, pinocchio::JointModelFreeFlyer(), placement, name);
        case JointModelWrapper::FIXED:
            return model.addJoint(parentId,
                pinocchio::JointModelComposite(0),
                placement, name);
        default:
            return 0;
    }
}

JointIndex modelAddJointWithLimits(Model& model,
                                   JointIndex parentId,
                                   const JointModelWrapper& joint,
                                   const SE3& placement,
                                   const std::string& name,
                                   const val& maxEffort_js,
                                   const val& maxVelocity_js,
                                   const val& minConfig_js,
                                   const val& maxConfig_js) {
    VectorXd maxEffort = jsToVectorXd(maxEffort_js);
    VectorXd maxVelocity = jsToVectorXd(maxVelocity_js);
    VectorXd minConfig = jsToVectorXd(minConfig_js);
    VectorXd maxConfig = jsToVectorXd(maxConfig_js);

    switch (joint.type) {
        case JointModelWrapper::RX:
            return model.addJoint(parentId, pinocchio::JointModelRX(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::RY:
            return model.addJoint(parentId, pinocchio::JointModelRY(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::RZ:
            return model.addJoint(parentId, pinocchio::JointModelRZ(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::PX:
            return model.addJoint(parentId, pinocchio::JointModelPX(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::PY:
            return model.addJoint(parentId, pinocchio::JointModelPY(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::PZ:
            return model.addJoint(parentId, pinocchio::JointModelPZ(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::REVOLUTE_UNALIGNED:
            return model.addJoint(parentId,
                pinocchio::JointModelRevoluteUnaligned(joint.axis),
                placement, name, maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::PRISMATIC_UNALIGNED:
            return model.addJoint(parentId,
                pinocchio::JointModelPrismaticUnaligned(joint.axis),
                placement, name, maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::UNIVERSAL:
            return model.addJoint(parentId,
                pinocchio::JointModelUniversal(joint.axis, joint.axis2),
                placement, name, maxEffort, maxVelocity, minConfig, maxConfig);
        case JointModelWrapper::FREE_FLYER:
            return model.addJoint(parentId, pinocchio::JointModelFreeFlyer(), placement, name,
                                  maxEffort, maxVelocity, minConfig, maxConfig);
        default:
            return 0;
    }
}

void modelAppendBodyToJoint(Model& model,
                            JointIndex jointId,
                            const Inertia& inertia,
                            const SE3& bodyPlacement) {
    model.appendBodyToJoint(jointId, inertia, bodyPlacement);
}

FrameIndex modelAddFrame(Model& model, const std::string& name,
                         JointIndex parentJointId, const SE3& placement) {
    if (parentJointId >= model.njoints)
        throw std::invalid_argument("addFrame: parentJointId is out of range");
    for (int i = 0; i < 3; ++i)
        if (!std::isfinite(placement.translation()[i]))
            throw std::invalid_argument("addFrame: placement contains non-finite values");
    for (int row = 0; row < 3; ++row)
        for (int col = 0; col < 3; ++col)
            if (!std::isfinite(placement.rotation()(row, col)))
                throw std::invalid_argument("addFrame: placement contains non-finite values");
    return model.addFrame(pinocchio::Frame(name, parentJointId, placement, pinocchio::OP_FRAME));
}

// ─── RigidConstraintModel Wrapper ────────────────────────────────

// Derive to make the protected default constructor accessible.
struct RigidConstraintModelEx : public RigidConstraintModel {
    RigidConstraintModelEx()
    : RigidConstraintModel() {}

    RigidConstraintModelEx(pinocchio::ContactType type,
                           const Model& model,
                           JointIndex joint1_id,
                           const SE3& joint1_placement,
                           JointIndex joint2_id,
                           const SE3& joint2_placement,
                           pinocchio::ReferenceFrame reference_frame = pinocchio::LOCAL)
    : RigidConstraintModel(type, model, joint1_id, joint1_placement,
                           joint2_id, joint2_placement, reference_frame) {}

    RigidConstraintModelEx(pinocchio::ContactType type,
                           const Model& model,
                           JointIndex joint1_id,
                           const SE3& joint1_placement,
                           pinocchio::ReferenceFrame reference_frame = pinocchio::LOCAL)
    : RigidConstraintModel(type, model, joint1_id, joint1_placement, reference_frame) {}

    int getSize() const { return size(); }

    pinocchio::ContactType getType() const { return type; }
    JointIndex getJoint1Id() const { return joint1_id; }
    JointIndex getJoint2Id() const { return joint2_id; }
    val getJoint1Placement() const { return se3ToJs(joint1_placement); }
    val getJoint2Placement() const { return se3ToJs(joint2_placement); }
    pinocchio::ReferenceFrame getRefFrame() const { return reference_frame; }

    val getCorrectorKp() const { return vectorXdToJs(corrector.Kp); }
    void setCorrectorKp(const val& kp_js) {
        VectorXd kp = jsToVectorXd(kp_js);
        corrector.Kp = kp;
    }

    val getCorrectorKd() const { return vectorXdToJs(corrector.Kd); }
    void setCorrectorKd(const val& kd_js) {
        VectorXd kd = jsToVectorXd(kd_js);
        corrector.Kd = kd;
    }
};

RigidConstraintModelEx* createRigidConstraintModel(pinocchio::ContactType type,
                                                    const Model& model,
                                                    JointIndex joint1_id,
                                                    const SE3& joint1_placement,
                                                    JointIndex joint2_id,
                                                    const SE3& joint2_placement,
                                                    pinocchio::ReferenceFrame reference_frame) {
    return new RigidConstraintModelEx(type, model, joint1_id, joint1_placement,
                                       joint2_id, joint2_placement, reference_frame);
}

RigidConstraintModelEx* createConstraintFromFrames(const Model& model,
                                                    FrameIndex frameAId,
                                                    FrameIndex frameBId,
                                                    pinocchio::ContactType type,
                                                    pinocchio::ReferenceFrame referenceFrame) {
    if (frameAId >= model.nframes || frameBId >= model.nframes)
        throw std::out_of_range("createConstraintFromFrames: frame ID is out of range");
    if (type != pinocchio::CONTACT_3D && type != pinocchio::CONTACT_6D)
        throw std::invalid_argument("createConstraintFromFrames supports CONTACT_3D and CONTACT_6D only");
    if (referenceFrame != pinocchio::LOCAL && referenceFrame != pinocchio::LOCAL_WORLD_ALIGNED)
        throw std::invalid_argument("createConstraintFromFrames supports LOCAL and LOCAL_WORLD_ALIGNED only");

    const pinocchio::Frame& frameA = model.frames[frameAId];
    const pinocchio::Frame& frameB = model.frames[frameBId];
    return new RigidConstraintModelEx(type, model,
                                      frameA.parentJoint, frameA.placement,
                                      frameB.parentJoint, frameB.placement,
                                      referenceFrame);
}

// The set is the ownership boundary for constraint algorithms.  In particular,
// models are copied on insertion so callers may safely delete their builder
// handles afterwards.
struct RigidConstraintSetEx {
    PINOCCHIO_STD_VECTOR_WITH_EIGEN_ALLOCATOR(RigidConstraintModel) models;
    PINOCCHIO_STD_VECTOR_WITH_EIGEN_ALLOCATOR(RigidConstraintData) datas;
    unsigned nq, nv, njoints;
    unsigned revision_;
    int constraint_dim_;

    explicit RigidConstraintSetEx(const Model& model)
        : nq(model.nq), nv(model.nv), njoints(model.njoints), revision_(0), constraint_dim_(0) {}

    static void finitePlacement(const SE3& p, const char* name) {
        for (int i = 0; i < 3; ++i)
            if (!std::isfinite(p.translation()[i])) throw std::invalid_argument(std::string(name) + " contains non-finite values");
        for (int r = 0; r < 3; ++r) for (int c = 0; c < 3; ++c)
            if (!std::isfinite(p.rotation()(r,c))) throw std::invalid_argument(std::string(name) + " contains non-finite values");
    }

    int addConstraint(const RigidConstraintModelEx& input) {
        if (input.type != pinocchio::CONTACT_3D && input.type != pinocchio::CONTACT_6D)
            throw std::invalid_argument("RigidConstraintSet supports CONTACT_3D and CONTACT_6D only");
        if (input.reference_frame == pinocchio::WORLD)
            throw std::invalid_argument("RigidConstraintSet does not support WORLD reference frame");
        if (input.joint1_id >= njoints || input.joint2_id >= njoints)
            throw std::invalid_argument("RigidConstraintModel joint is incompatible with the set topology");
        finitePlacement(input.joint1_placement, "joint1_placement");
        finitePlacement(input.joint2_placement, "joint2_placement");
        if (input.corrector.Kp.size() != input.size() || input.corrector.Kd.size() != input.size())
            throw std::invalid_argument("RigidConstraintModel corrector dimensions do not match its type");
        for (int i = 0; i < input.size(); ++i)
            if (!std::isfinite(input.corrector.Kp[i]) || !std::isfinite(input.corrector.Kd[i]))
                throw std::invalid_argument("RigidConstraintModel corrector contains non-finite values");
        models.push_back(input);
        datas.emplace_back(models.back());
        constraint_dim_ += models.back().size();
        ++revision_;
        return static_cast<int>(models.size() - 1);
    }

    void replaceConstraint(int index, const RigidConstraintModelEx& input) {
        if (index < 0 || index >= count()) throw std::out_of_range("constraint index out of range");
        if (input.type != pinocchio::CONTACT_3D && input.type != pinocchio::CONTACT_6D)
            throw std::invalid_argument("RigidConstraintSet supports CONTACT_3D and CONTACT_6D only");
        if (input.reference_frame == pinocchio::WORLD)
            throw std::invalid_argument("RigidConstraintSet does not support WORLD reference frame");
        if (input.joint1_id >= njoints || input.joint2_id >= njoints)
            throw std::invalid_argument("RigidConstraintModel joint is incompatible with the set topology");
        finitePlacement(input.joint1_placement, "joint1_placement");
        finitePlacement(input.joint2_placement, "joint2_placement");
        if (input.corrector.Kp.size() != input.size() || input.corrector.Kd.size() != input.size())
            throw std::invalid_argument("RigidConstraintModel corrector dimensions do not match its type");
        for (int i = 0; i < input.size(); ++i)
            if (!std::isfinite(input.corrector.Kp[i]) || !std::isfinite(input.corrector.Kd[i]))
                throw std::invalid_argument("RigidConstraintModel corrector contains non-finite values");
        int old_size = models[index].size();
        models[index] = input;
        datas[index] = RigidConstraintData(models[index]);
        constraint_dim_ += models[index].size() - old_size;
        ++revision_;
    }

    int count() const { return static_cast<int>(models.size()); }
    int constraintDim() const { return constraint_dim_; }
    unsigned revision() const { return revision_; }
    int rowOffset(int index) const {
        if (index < 0 || index >= count()) throw std::out_of_range("constraint index out of range");
        int offset = 0; for (int i = 0; i < index; ++i) offset += models[i].size(); return offset;
    }
    val modelInfo(int index) const {
        if (index < 0 || index >= count()) throw std::out_of_range("constraint index out of range");
        const auto& m = models[index]; val out = val::object();
        out.set("index", index); out.set("rowOffset", rowOffset(index)); out.set("rowDim", m.size());
        out.set("type", m.type); out.set("referenceFrame", m.reference_frame);
        out.set("joint1Id", m.joint1_id); out.set("joint2Id", m.joint2_id);
        out.set("joint1Placement", se3ToJs(m.joint1_placement)); out.set("joint2Placement", se3ToJs(m.joint2_placement));
        out.set("correctorKp", vectorXdToJs(m.corrector.Kp)); out.set("correctorKd", vectorXdToJs(m.corrector.Kd));
        return out;
    }
    val dataInfo(int index) const {
        if (index < 0 || index >= count()) throw std::out_of_range("constraint index out of range");
        const auto& d = datas[index]; val out = val::object();
        out.set("index", index); out.set("rowOffset", rowOffset(index)); out.set("rowDim", models[index].size());
        out.set("c1Mc2", se3ToJs(d.c1Mc2)); out.set("translation", vector3dToJs(d.c1Mc2.translation()));
        val force = val::object(); force.set("linear", vector3dToJs(d.contact_force.linear()));
        force.set("angular", vector3dToJs(d.contact_force.angular())); out.set("contactForce", force); return out;
    }

    void setConstraintGains(int index, const val& kp_js, const val& kd_js) {
        if (index < 0 || index >= count()) throw std::out_of_range("constraint index out of range");
        VectorXd kp = jsToVectorXd(kp_js);
        VectorXd kd = jsToVectorXd(kd_js);
        if ((int)kp.size() != models[index].size() || (int)kd.size() != models[index].size())
            throw std::invalid_argument("gain dimensions must match constraint dimension");
        for (int i = 0; i < kp.size(); ++i)
            if (!std::isfinite(kp[i]) || !std::isfinite(kd[i]))
                throw std::invalid_argument("gains must be finite");
        models[index].corrector.Kp = kp;
        models[index].corrector.Kd = kd;
        ++revision_;
    }

    val evaluate(const Model& model, Data& data, const val& q_js) {
        VectorXd q = jsToVectorXd(q_js);

        pinocchio::forwardKinematics(model, data, q);
        pinocchio::computeJointJacobians(model, data, q);

        int rows = constraint_dim_;
        int cols = model.nv;

        val residual = val::global("Float64Array").new_(rows);
        val jacobian = val::global("Float64Array").new_(rows * cols);

        int row_offset = 0;
        for (int i = 0; i < count(); ++i) {
            int dim = models[i].size();

            models[i].calc(model, data, datas[i]);

            if (models[i].type == pinocchio::CONTACT_3D) {
                if (models[i].reference_frame == pinocchio::LOCAL) {
                    Vector3d r = -datas[i].c1Mc2.translation();
                    for (int j = 0; j < 3; ++j) residual.set(row_offset + j, val(r[j]));
                } else {
                    Vector3d r = datas[i].oMc1.translation() - datas[i].oMc2.translation();
                    for (int j = 0; j < 3; ++j) residual.set(row_offset + j, val(r[j]));
                }
            } else {
                if (models[i].reference_frame == pinocchio::LOCAL) {
                    auto motion = pinocchio::log6(datas[i].c1Mc2);
                    Eigen::Matrix<double,6,1> r = -motion.toVector();
                    for (int j = 0; j < 6; ++j) residual.set(row_offset + j, val(r[j]));
                } else {
                    Vector3d linear = datas[i].oMc1.translation() - datas[i].oMc2.translation();
                    Matrix3d R_relative = datas[i].oMc2.rotation() * datas[i].oMc1.rotation().transpose();
                    Vector3d angular = -pinocchio::log3(R_relative);
                    for (int j = 0; j < 3; ++j) residual.set(row_offset + j, val(linear[j]));
                    for (int j = 0; j < 3; ++j) residual.set(row_offset + 3 + j, val(angular[j]));
                }
            }

			MatrixXd Jc = MatrixXd::Zero(dim, cols);
			models[i].jacobian(model, data, datas[i], Jc);

			if (models[i].reference_frame == pinocchio::LOCAL &&
				models[i].type == pinocchio::CONTACT_6D) {
				Eigen::Matrix<double, 6, 6> Jlog;
				pinocchio::Jlog6(datas[i].c1Mc2, Jlog);
				Jc = Jlog * Jc;
			}

            double sign = (models[i].reference_frame == pinocchio::LOCAL) ? -1.0 : 1.0;
            for (int col = 0; col < cols; ++col)
                for (int row = 0; row < dim; ++row)
                    jacobian.set((row_offset + row) + col * rows, val(sign * Jc(row, col)));

            row_offset += dim;
        }

        val result = val::object();
        result.set("residual", residual);
        result.set("jacobian", jacobian);
        result.set("rows", rows);
        result.set("cols", cols);
        return result;
    }

    void updatePlacements(const val& updates) {
        int len = updates["length"].as<int>();
        for (int i = 0; i < len; ++i) {
            val entry = updates[i];
            int index = entry["index"].as<int>();
            if (index < 0 || index >= count())
                throw std::out_of_range("updatePlacements: constraint index out of range");
            if (models[index].reference_frame == pinocchio::WORLD)
                throw std::invalid_argument("RigidConstraintSet does not support WORLD reference frame");
            val j1p = entry["joint1Placement"];
            val j2p = entry["joint2Placement"];
            finitePlacement(se3FromJsPlacement(j1p), "joint1Placement");
            finitePlacement(se3FromJsPlacement(j2p), "joint2Placement");
        }
        for (int i = 0; i < len; ++i) {
            val entry = updates[i];
            int index = entry["index"].as<int>();
            val j1p = entry["joint1Placement"];
            val j2p = entry["joint2Placement"];
            models[index].joint1_placement = se3FromJsPlacement(j1p);
            models[index].joint2_placement = se3FromJsPlacement(j2p);
        }
    }
};

// ─── ProximalSettings Wrapper ────────────────────────────────────

ProximalSettings makeProximalSettings(double accuracy, double mu, int maxIter) {
    return ProximalSettings(accuracy, mu, maxIter);
}

double proximalGetAbsoluteAccuracy(const ProximalSettings& s) { return s.absolute_accuracy; }
double proximalGetRelativeAccuracy(const ProximalSettings& s) { return s.relative_accuracy; }
double proximalGetMu(const ProximalSettings& s) { return s.mu; }
int proximalGetMaxIter(const ProximalSettings& s) { return s.max_iter; }
double proximalGetAbsoluteResidual(const ProximalSettings& s) { return s.absolute_residual; }
double proximalGetRelativeResidual(const ProximalSettings& s) { return s.relative_residual; }
int proximalGetIter(const ProximalSettings& s) { return s.iter; }

// ─── ContactCholeskyDecomposition Wrapper ────────────────────────

// Wraps ContactCholeskyDecompositionTpl for embind.  Accepts a
// RigidConstraintSet whose owned native model/data vectors are passed
// directly to Pinocchio.  The decomposition tracks the set revision that
// was used for allocation and reallocates before computation when
// structural members have changed.  No set reference is retained.
struct ContactCholeskyDecompositionEx {
    ContactCholeskyDecomposition chol;
    unsigned last_revision_;
    int last_constraint_dim_;

    ContactCholeskyDecompositionEx() : chol(), last_revision_(0), last_constraint_dim_(0) {}

    ContactCholeskyDecompositionEx(const Model& model, const RigidConstraintSetEx& set)
        : chol(), last_revision_(0), last_constraint_dim_(0) {
        if (set.count() > 0) {
            chol.allocate(model, set.models);
            last_revision_ = set.revision();
            last_constraint_dim_ = set.constraintDim();
        }
    }

    void compute(const Model& model, Data& data,
                 RigidConstraintSetEx& set,
                 double mu) {
        if (!std::isfinite(mu))
            throw std::invalid_argument("ContactCholeskyDecomposition: mu must be finite");
        if (mu < 0)
            throw std::invalid_argument("ContactCholeskyDecomposition: mu must be nonnegative");
        if (set.nq != model.nq || set.nv != model.nv)
            throw std::invalid_argument("ContactCholeskyDecomposition: set topology does not match model");
        if (set.count() > 0) {
            if (set.revision() != last_revision_ || set.constraintDim() != last_constraint_dim_) {
                chol.allocate(model, set.models);
                last_revision_ = set.revision();
                last_constraint_dim_ = set.constraintDim();
            }
            chol.compute(model, data, set.models, set.datas, mu);
        }
    }

    val solve(const val& rhs_js) {
        if (chol.size() == 0)
            throw std::logic_error("ContactCholeskyDecomposition: solve called before allocation/computation");
        VectorXd rhs = jsToVectorXd(rhs_js);
        if (rhs.size() != static_cast<Eigen::Index>(chol.size()))
            throw std::invalid_argument("ContactCholeskyDecomposition: rhs size " + std::to_string(rhs.size()) + " must equal decomposition size " + std::to_string(chol.size()));
        VectorXd result = chol.solve(rhs);
        return vectorXdToJs(result);
    }

    int getSize() const { return (int)chol.size(); }
    int constraintDim() const { return (int)chol.constraintDim(); }
};

ContactCholeskyDecompositionEx* createContactCholeskyDecomposition(
    const Model& model,
    const RigidConstraintSetEx& set) {
    return new ContactCholeskyDecompositionEx(model, set);
}

// ─── Algorithm Wrappers ─────────────────────────────────────────

val rnea_js(Model& model, Data& data,
            const val& q_js, const val& v_js, const val& a_js) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);
    VectorXd a = jsToVectorXd(a_js);
    pinocchio::rnea(model, data, q, v, a);
    return vectorXdToJs(data.tau);
}

val aba_js(Model& model, Data& data,
            const val& q_js, const val& v_js, const val& tau_js) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);
    VectorXd tau = jsToVectorXd(tau_js);
    pinocchio::aba(model, data, q, v, tau);
    return vectorXdToJs(data.ddq);
}

val crba_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    pinocchio::crba(model, data, q);
    data.M.triangularView<Eigen::StrictlyLower>() = data.M.transpose().triangularView<Eigen::StrictlyLower>();
    return matrixXdToJs(data.M);
}

void setKinematicMetric_js(Data& data, const val& diagonal_js) {
    VectorXd diagonal = jsToVectorXd(diagonal_js);
    const Eigen::Index nv = data.M.rows();

    if (diagonal.size() != nv)
        throw std::invalid_argument("setKinematicMetric: diagonal.length must equal model.nv (got " + std::to_string(diagonal.size()) + ", expected " + std::to_string(nv) + ")");

    for (Eigen::Index i = 0; i < nv; ++i) {
        if (!std::isfinite(diagonal[i]))
            throw std::invalid_argument("setKinematicMetric: diagonal contains non-finite value at index " + std::to_string(i));
        if (diagonal[i] <= 0)
            throw std::invalid_argument("setKinematicMetric: diagonal must be strictly positive (got " + std::to_string(diagonal[i]) + " at index " + std::to_string(i) + ")");
    }

    data.M.setZero();
    for (Eigen::Index i = 0; i < nv; ++i)
        data.M(i, i) = diagonal[i];
}

double computeKineticEnergy_js(Model& model, Data& data, const val& q_js, const val& v_js) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);
    return pinocchio::computeKineticEnergy(model, data, q, v);
}

double computePotentialEnergy_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    return pinocchio::computePotentialEnergy(model, data, q);
}

val computeGeneralizedGravity_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    pinocchio::computeGeneralizedGravity(model, data, q);
    return vectorXdToJs(data.g);
}

val nonLinearEffects_js(Model& model, Data& data, const val& q_js, const val& v_js) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);
    pinocchio::nonLinearEffects(model, data, q, v);
    return vectorXdToJs(data.nle);
}

void forwardKinematics_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    pinocchio::forwardKinematics(model, data, q);
}

void computeJointJacobians_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    pinocchio::computeJointJacobians(model, data, q);
}

val getJointJacobian_js(const Model& model, Data& data,
                        JointIndex jointId, int refFrame) {
    pinocchio::ReferenceFrame rf = static_cast<pinocchio::ReferenceFrame>(refFrame);
    MatrixXd J = MatrixXd::Zero(6, model.nv);
    pinocchio::getJointJacobian(model, data, jointId, rf, J);
    return matrixXdToJs(J);
}

val getFrameJacobian_js(const Model& model, Data& data,
                          JointIndex jointId,
                          const SE3& placement,
                          pinocchio::ReferenceFrame refFrame) {
    return matrixXdToJs(pinocchio::getFrameJacobian(model, data, jointId, placement, refFrame));
}

val getFrameJacobianById_js(const Model& model, Data& data,
                            FrameIndex frameId,
                            pinocchio::ReferenceFrame refFrame) {
    MatrixXd J = MatrixXd::Zero(6, model.nv);
    pinocchio::getFrameJacobian(model, data, frameId, refFrame, J);
    return matrixXdToJs(J);
}

void updateFramePlacements_js(Model& model, Data& data) {
    pinocchio::updateFramePlacements(model, data);
}

val getJointPlacement_js(const Data& data, JointIndex jointId) {
    const pinocchio::SE3& placement = data.oMi[jointId];
    val result = val::object();
    result.set("translation", vector3dToJs(placement.translation()));
    result.set("rotation", matrixXdToJs(placement.rotation()));
    return result;
}

val getFramePlacement_js(const Data& data, FrameIndex frameId) {
    return se3ToJs(data.oMf[frameId]);
}

val centerOfMass_js(Model& model, Data& data, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);
    pinocchio::centerOfMass(model, data, q);
    return vector3dToJs(data.com[0]);
}

double computeTotalMass_js(const Model& model) {
    return pinocchio::computeTotalMass(model);
}

val randomConfiguration_js(const Model& model) {
    VectorXd q = pinocchio::randomConfiguration(model);
    return vectorXdToJs(q);
}

val neutralConfiguration_js(const Model& model) {
    VectorXd q = pinocchio::neutral(model);
    return vectorXdToJs(q);
}

val integrate_js(const Model& model, const val& q_js, const val& v_js) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("integrate: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (v.size() != model.nv)
        throw std::invalid_argument("integrate: v.length must equal model.nv (got " + std::to_string(v.size()) + ", expected " + std::to_string(model.nv) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("integrate: q contains non-finite value at index " + std::to_string(i));
    for (Eigen::Index i = 0; i < v.size(); ++i)
        if (!std::isfinite(v[i]))
            throw std::invalid_argument("integrate: v contains non-finite value at index " + std::to_string(i));

    VectorXd qout(model.nq);
    pinocchio::integrate(model, q, v, qout);
    return vectorXdToJs(qout);
}

val integrateScaled_js(const Model& model, const val& q_js, const val& v_js, double scale) {
    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("integrate: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (v.size() != model.nv)
        throw std::invalid_argument("integrate: v.length must equal model.nv (got " + std::to_string(v.size()) + ", expected " + std::to_string(model.nv) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("integrate: q contains non-finite value at index " + std::to_string(i));
    for (Eigen::Index i = 0; i < v.size(); ++i)
        if (!std::isfinite(v[i]))
            throw std::invalid_argument("integrate: v contains non-finite value at index " + std::to_string(i));

    if (!std::isfinite(scale))
        throw std::invalid_argument("integrate: scale is non-finite");

    v *= scale;
    VectorXd qout(model.nq);
    pinocchio::integrate(model, q, v, qout);
    return vectorXdToJs(qout);
}

val difference_js(const Model& model, const val& q0_js, const val& q1_js) {
    VectorXd q0 = jsToVectorXd(q0_js);
    VectorXd q1 = jsToVectorXd(q1_js);

    if (q0.size() != model.nq)
        throw std::invalid_argument("difference: q0.length must equal model.nq (got " + std::to_string(q0.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (q1.size() != model.nq)
        throw std::invalid_argument("difference: q1.length must equal model.nq (got " + std::to_string(q1.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q0.size(); ++i) {
        if (!std::isfinite(q0[i]))
            throw std::invalid_argument("difference: q0 contains non-finite value at index " + std::to_string(i));
        if (!std::isfinite(q1[i]))
            throw std::invalid_argument("difference: q1 contains non-finite value at index " + std::to_string(i));
    }

    VectorXd dvout(model.nv);
    pinocchio::difference(model, q0, q1, dvout);
    return vectorXdToJs(dvout);
}

val differenceScaled_js(const Model& model, const val& q0_js, const val& q1_js, double scale) {
    VectorXd q0 = jsToVectorXd(q0_js);
    VectorXd q1 = jsToVectorXd(q1_js);

    if (q0.size() != model.nq)
        throw std::invalid_argument("difference: q0.length must equal model.nq (got " + std::to_string(q0.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (q1.size() != model.nq)
        throw std::invalid_argument("difference: q1.length must equal model.nq (got " + std::to_string(q1.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q0.size(); ++i) {
        if (!std::isfinite(q0[i]))
            throw std::invalid_argument("difference: q0 contains non-finite value at index " + std::to_string(i));
        if (!std::isfinite(q1[i]))
            throw std::invalid_argument("difference: q1 contains non-finite value at index " + std::to_string(i));
    }

    if (!std::isfinite(scale))
        throw std::invalid_argument("difference: scale is non-finite");

    VectorXd dvout(model.nv);
    pinocchio::difference(model, q0, q1, dvout);
    dvout *= scale;
    return vectorXdToJs(dvout);
}

// ─── Configuration-space: interpolate / normalize / isNormalized ──

val interpolate_js(const Model& model, const val& q0_js, const val& q1_js, double alpha) {
    VectorXd q0 = jsToVectorXd(q0_js);
    VectorXd q1 = jsToVectorXd(q1_js);

    if (q0.size() != model.nq)
        throw std::invalid_argument("interpolate: q0.length must equal model.nq (got " + std::to_string(q0.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (q1.size() != model.nq)
        throw std::invalid_argument("interpolate: q1.length must equal model.nq (got " + std::to_string(q1.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q0.size(); ++i) {
        if (!std::isfinite(q0[i]))
            throw std::invalid_argument("interpolate: q0 contains non-finite value at index " + std::to_string(i));
        if (!std::isfinite(q1[i]))
            throw std::invalid_argument("interpolate: q1 contains non-finite value at index " + std::to_string(i));
    }

    if (!std::isfinite(alpha))
        throw std::invalid_argument("interpolate: alpha is non-finite");

    VectorXd qout = pinocchio::interpolate(model, q0, q1, alpha);
    return vectorXdToJs(qout);
}

val normalize_js(const Model& model, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("normalize: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("normalize: q contains non-finite value at index " + std::to_string(i));

    VectorXd qcopy = q;
    pinocchio::normalize(model, qcopy);
    return vectorXdToJs(qcopy);
}

bool isNormalized_js(const Model& model, const val& q_js) {
    VectorXd q = jsToVectorXd(q_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("isNormalized: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("isNormalized: q contains non-finite value at index " + std::to_string(i));

    return pinocchio::isNormalized(model, q, 1e-6);
}

bool isNormalizedPrec_js(const Model& model, const val& q_js, double precision) {
    VectorXd q = jsToVectorXd(q_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("isNormalized: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("isNormalized: q contains non-finite value at index " + std::to_string(i));

    if (!std::isfinite(precision))
        throw std::invalid_argument("isNormalized: precision is non-finite");
    if (precision <= 0)
        throw std::invalid_argument("isNormalized: precision must be positive (got " + std::to_string(precision) + ")");

    return pinocchio::isNormalized(model, q, precision);
}

// ─── solveSVD ────────────────────────────────────────────────────

val solveSVD_impl(const val& A_js, int rows, int cols, const val& b_js,
                  double lambda, double threshold) {
    if (rows <= 0)
        throw std::invalid_argument("solveSVD: rows must be positive (got " + std::to_string(rows) + ")");
    if (cols <= 0)
        throw std::invalid_argument("solveSVD: cols must be positive (got " + std::to_string(cols) + ")");

    unsigned Alen = A_js["length"].as<unsigned>();
    if (Alen != static_cast<unsigned>(rows * cols))
        throw std::invalid_argument("solveSVD: A.length must equal rows * cols (got " + std::to_string(Alen) + ", expected " + std::to_string(rows * cols) + ")");

    unsigned blen = b_js["length"].as<unsigned>();
    if (blen != static_cast<unsigned>(rows))
        throw std::invalid_argument("solveSVD: b.length must equal rows (got " + std::to_string(blen) + ", expected " + std::to_string(rows) + ")");

    if (!std::isfinite(lambda))
        throw std::invalid_argument("solveSVD: lambda is non-finite");
    if (lambda < 0)
        throw std::invalid_argument("solveSVD: lambda must be non-negative (got " + std::to_string(lambda) + ")");

    if (!std::isfinite(threshold))
        throw std::invalid_argument("solveSVD: threshold is non-finite");
    if (threshold <= 0)
        throw std::invalid_argument("solveSVD: relative threshold must be positive (got " + std::to_string(threshold) + ")");

    Eigen::MatrixXd A_mat(rows, cols);
    for (int j = 0; j < cols; ++j)
        for (int i = 0; i < rows; ++i) {
            double val = A_js[j * rows + i].as<double>();
            if (!std::isfinite(val))
                throw std::invalid_argument("solveSVD: A contains non-finite value at (" + std::to_string(i) + "," + std::to_string(j) + ")");
            A_mat(i, j) = val;
        }

    Eigen::VectorXd b_vec(rows);
    for (int i = 0; i < rows; ++i) {
        double val = b_js[i].as<double>();
        if (!std::isfinite(val))
            throw std::invalid_argument("solveSVD: b contains non-finite value at index " + std::to_string(i));
        b_vec(i) = val;
    }

    Eigen::JacobiSVD<Eigen::MatrixXd> svd(A_mat, Eigen::ComputeThinU | Eigen::ComputeThinV);
    Eigen::VectorXd svals = svd.singularValues();

    int rank = 0;
    if (svals.size() > 0) {
        double rel_threshold = threshold * svals(0);
        for (Eigen::Index i = 0; i < svals.size(); ++i)
            if (svals(i) > rel_threshold) rank++;
    }

    double cond = std::numeric_limits<double>::infinity();
    if (svals.size() > 0 && svals(svals.size() - 1) > 0)
        cond = svals(0) / svals(svals.size() - 1);

    Eigen::VectorXd x(cols);
    if (svals.size() > 0) {
        Eigen::VectorXd UTb = svd.matrixU().transpose() * b_vec;
        Eigen::VectorXd damped(svals.size());
        for (Eigen::Index i = 0; i < svals.size(); ++i) {
            double s = svals(i);
            double denom = s * s + lambda * lambda;
            damped(i) = (denom > 0) ? (s / denom) * UTb(i) : 0.0;
        }
        x = svd.matrixV() * damped;
    } else {
        x.setZero();
    }

    val result = val::object();
    result.set("x", vectorXdToJs(x));
    result.set("rank", val(rank));
    result.set("singularValues", vectorXdToJs(svals));
    result.set("cond", val(cond));
    return result;
}

val solveSVD_js(const val& A_js, int rows, int cols, const val& b_js) {
    return solveSVD_impl(A_js, rows, cols, b_js, 0.0, 1e-6);
}

val solveSVD_full_js(const val& A_js, int rows, int cols, const val& b_js,
                     double lambda, double threshold) {
    return solveSVD_impl(A_js, rows, cols, b_js, lambda, threshold);
}

// ─── Constraint Dynamics Wrappers ────────────────────────────────

void initConstraintDynamics_js(Model& model, Data& data,
                               const RigidConstraintSetEx& set) {
    if (set.nq != model.nq || set.nv != model.nv)
        throw std::invalid_argument("initConstraintDynamics: set topology does not match model");
    if (set.count() > 0)
        pinocchio::initConstraintDynamics(model, data, set.models);
}

val constraintDynamics_js(Model& model, Data& data,
                          const val& q_js, const val& v_js, const val& tau_js,
                          RigidConstraintSetEx& set,
                          ProximalSettings& settings) {
    if (set.nq != model.nq || set.nv != model.nv)
        throw std::invalid_argument("constraintDynamics: set topology does not match model");

    VectorXd q = jsToVectorXd(q_js);
    VectorXd v = jsToVectorXd(v_js);
    VectorXd tau = jsToVectorXd(tau_js);

    if (q.size() != model.nq)
        throw std::invalid_argument("constraintDynamics: q.length must equal model.nq (got " + std::to_string(q.size()) + ", expected " + std::to_string(model.nq) + ")");
    if (v.size() != model.nv)
        throw std::invalid_argument("constraintDynamics: v.length must equal model.nv (got " + std::to_string(v.size()) + ", expected " + std::to_string(model.nv) + ")");
    if (tau.size() != model.nv)
        throw std::invalid_argument("constraintDynamics: tau.length must equal model.nv (got " + std::to_string(tau.size()) + ", expected " + std::to_string(model.nv) + ")");

    for (Eigen::Index i = 0; i < q.size(); ++i)
        if (!std::isfinite(q[i]))
            throw std::invalid_argument("constraintDynamics: q contains non-finite value at index " + std::to_string(i));
    for (Eigen::Index i = 0; i < v.size(); ++i)
        if (!std::isfinite(v[i]))
            throw std::invalid_argument("constraintDynamics: v contains non-finite value at index " + std::to_string(i));
    for (Eigen::Index i = 0; i < tau.size(); ++i)
        if (!std::isfinite(tau[i]))
            throw std::invalid_argument("constraintDynamics: tau contains non-finite value at index " + std::to_string(i));

    if (set.count() > 0) {
        pinocchio::initConstraintDynamics(model, data, set.models);
        pinocchio::constraintDynamics(model, data, q, v, tau, set.models, set.datas, settings);
    } else {
        pinocchio::aba(model, data, q, v, tau);
    }

    return vectorXdToJs(data.ddq);
}

// ─── Data accessors ─────────────────────────────────────────────

val dataTau(const Data& data) { return vectorXdToJs(data.tau); }
val dataNle(const Data& data) { return vectorXdToJs(data.nle); }

val dataComAt(const Data& data, unsigned idx) {
    return vector3dToJs(data.com[idx]);
}

val dataDDq(const Data& data) { return vectorXdToJs(data.ddq); }
val dataLambdaC(const Data& data) { return vectorXdToJs(data.lambda_c); }
val dataM(const Data& data) { return matrixXdToJs(data.M); }

// ─── Embind Module ──────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(pinocchio_wasm) {

    // ── Reference Frame enum ──
    enum_<pinocchio::ReferenceFrame>("ReferenceFrame")
        .value("WORLD", pinocchio::WORLD)
        .value("LOCAL", pinocchio::LOCAL)
        .value("LOCAL_WORLD_ALIGNED", pinocchio::LOCAL_WORLD_ALIGNED)
        ;

    // ── ContactType enum ──
    enum_<pinocchio::ContactType>("ContactType")
        .value("CONTACT_3D", pinocchio::CONTACT_3D)
        .value("CONTACT_6D", pinocchio::CONTACT_6D)
        .value("CONTACT_UNDEFINED", pinocchio::CONTACT_UNDEFINED)
        ;

    // ── SE3 ──
    class_<SE3>("SE3")
        .class_function("identity", &se3Identity)
        .class_function("fromRotationTranslation", &se3FromRotationTranslation)
        .class_function("fromXyzRpy", &se3FromXyzRpy)
        ;

    // ── Inertia ──
    class_<Inertia>("Inertia")
        .class_function("fromMassComInertia", &inertiaFromMassComInertia)
        ;

    // ── JointModelWrapper ──
    class_<JointModelWrapper>("JointModel");

    function("JointModelRX", &makeJointModelRX);
    function("JointModelRY", &makeJointModelRY);
    function("JointModelRZ", &makeJointModelRZ);
    function("JointModelPX", &makeJointModelPX);
    function("JointModelPY", &makeJointModelPY);
    function("JointModelPZ", &makeJointModelPZ);
    function("JointModelRevoluteUnaligned", &makeJointModelRevoluteUnaligned);
    function("JointModelPrismaticUnaligned", &makeJointModelPrismaticUnaligned);
    function("JointModelUniversal", &makeJointModelUniversal);
    function("JointModelFreeFlyer", &makeJointModelFreeFlyer);
    function("JointModelFixed", &makeJointModelFixed);

    // ── Model ──
    class_<Model>("Model")
        .constructor<>()
        .property("nq", &Model::nq)
        .property("nv", &Model::nv)
        .property("njoints", &Model::njoints)
        .property("name", &Model::name)
        ;

    function("addJoint", &modelAddJoint);
    function("addJointWithLimits", &modelAddJointWithLimits);
    function("appendBodyToJoint", &modelAppendBodyToJoint);
    function("addFrame", &modelAddFrame);

    // ── Data ──
    class_<Data>("Data")
        .constructor<const Model&>()
        ;

    function("getTau", &dataTau);
    function("getNle", &dataNle);
    function("getComAt", &dataComAt);
    function("getDDq", &dataDDq);
    function("getLambdaC", &dataLambdaC);
    function("getM", &dataM);

    // ── RigidConstraintModel ──
    class_<RigidConstraintModelEx>("RigidConstraintModel")
        .property("type", &RigidConstraintModelEx::getType)
        .property("joint1_id", &RigidConstraintModelEx::getJoint1Id)
        .property("joint2_id", &RigidConstraintModelEx::getJoint2Id)
        .property("joint1_placement", &RigidConstraintModelEx::getJoint1Placement)
        .property("joint2_placement", &RigidConstraintModelEx::getJoint2Placement)
        .property("reference_frame", &RigidConstraintModelEx::getRefFrame)
        .property("size", &RigidConstraintModelEx::getSize)
        .property("correctorKp", &RigidConstraintModelEx::getCorrectorKp, &RigidConstraintModelEx::setCorrectorKp)
        .property("correctorKd", &RigidConstraintModelEx::getCorrectorKd, &RigidConstraintModelEx::setCorrectorKd)
        ;

    function("createRigidConstraintModel", &createRigidConstraintModel, allow_raw_pointers());
    function("createConstraintFromFrames", &createConstraintFromFrames, allow_raw_pointers());

    class_<RigidConstraintSetEx>("RigidConstraintSet")
        .constructor<const Model&>()
        .function("addConstraint", &RigidConstraintSetEx::addConstraint)
        .function("replaceConstraint", &RigidConstraintSetEx::replaceConstraint)
        .function("getModel", &RigidConstraintSetEx::modelInfo)
        .function("getData", &RigidConstraintSetEx::dataInfo)
        .function("evaluate", &RigidConstraintSetEx::evaluate)
        .function("updatePlacements", &RigidConstraintSetEx::updatePlacements)
        .function("setConstraintGains", &RigidConstraintSetEx::setConstraintGains)
        .property("count", &RigidConstraintSetEx::count)
        .property("constraintDim", &RigidConstraintSetEx::constraintDim)
        .property("revision", &RigidConstraintSetEx::revision)
        .function("rowOffset", &RigidConstraintSetEx::rowOffset);

    // ── ProximalSettings ──
    class_<ProximalSettings>("ProximalSettings")
        .constructor<double, double, int>()
        .property("absolute_accuracy", &proximalGetAbsoluteAccuracy)
        .property("relative_accuracy", &proximalGetRelativeAccuracy)
        .property("mu", &proximalGetMu)
        .property("max_iter", &proximalGetMaxIter)
        .property("absolute_residual", &proximalGetAbsoluteResidual)
        .property("relative_residual", &proximalGetRelativeResidual)
        .property("iter", &proximalGetIter)
        ;

    // ── ContactCholeskyDecomposition ──
    class_<ContactCholeskyDecompositionEx>("ContactCholeskyDecomposition")
        .constructor<>()
        .function("compute", &ContactCholeskyDecompositionEx::compute)
        .function("solve", &ContactCholeskyDecompositionEx::solve)
        .property("size", &ContactCholeskyDecompositionEx::getSize)
        .property("constraintDim", &ContactCholeskyDecompositionEx::constraintDim)
        ;

    function("createContactCholeskyDecomposition", &createContactCholeskyDecomposition, allow_raw_pointers());

    // ── Algorithms ──
    function("rnea", &rnea_js);
    function("aba", &aba_js);
    function("crba", &crba_js);
    function("setKinematicMetric", &setKinematicMetric_js);
    function("computeKineticEnergy", &computeKineticEnergy_js);
    function("computePotentialEnergy", &computePotentialEnergy_js);
    function("computeGeneralizedGravity", &computeGeneralizedGravity_js);
    function("nonLinearEffects", &nonLinearEffects_js);
    function("forwardKinematics", &forwardKinematics_js);
    function("updateFramePlacements", &updateFramePlacements_js);
    function("getJointPlacement", &getJointPlacement_js);
    function("getFramePlacement", &getFramePlacement_js);
    function("computeJointJacobians", &computeJointJacobians_js);
    function("getJointJacobian", &getJointJacobian_js);
    function("getFrameJacobian", &getFrameJacobian_js);
    function("getFrameJacobian", &getFrameJacobianById_js);
    function("centerOfMass", &centerOfMass_js);
    function("computeTotalMass", &computeTotalMass_js);
    function("randomConfiguration", &randomConfiguration_js);
    function("neutralConfiguration", &neutralConfiguration_js);
    function("integrate", &integrate_js);
    function("integrate", &integrateScaled_js);
    function("difference", &difference_js);
    function("difference", &differenceScaled_js);
    function("interpolate", &interpolate_js);
    function("normalize", &normalize_js);
    function("isNormalized", &isNormalized_js);
    function("isNormalized", &isNormalizedPrec_js);

    // ── Constraint Algorithms ──
    function("initConstraintDynamics", &initConstraintDynamics_js);
    function("constraintDynamics", &constraintDynamics_js);

    // ── SVD Solver ──
    function("solveSVD", &solveSVD_js);
    function("solveSVD", &solveSVD_full_js);
}
