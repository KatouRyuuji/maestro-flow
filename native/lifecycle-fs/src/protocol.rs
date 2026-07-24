use serde::{Deserialize, Serialize};

pub const HELPER_PROTOCOL: &str = "lifecycle-fs-helper/1.0";
pub const GENERATION_SCHEMA: &str = "lifecycle-fs-generation/1.0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PlatformIdentity {
    Posix {
        dev: String,
        ino: String,
        mode: u32,
    },
    Windows {
        volume_serial: String,
        file_id128: String,
        file_attributes: u32,
        reparse_tag: Option<u32>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecyclePlatform {
    Windows,
    Posix,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleGeneration {
    #[serde(rename = "schema_version")]
    pub schema_version: String,
    pub platform: LifecyclePlatform,
    pub root: PlatformIdentity,
    pub parent_chain: Vec<PlatformIdentity>,
    pub entry: PlatformIdentity,
    pub sha256: String,
    pub owner_generation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundRead {
    pub bytes_base64: String,
    pub generation: LifecycleGeneration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundLock {
    pub lock_relative_path: String,
    pub token: String,
    pub owner_generation: String,
    pub generation: LifecycleGeneration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundQuarantine {
    pub original_relative_path: String,
    pub quarantine_relative_path: String,
    pub request_id: String,
    pub owner_generation: String,
    pub expected_sha256: String,
    pub generation: LifecycleGeneration,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ReadOperation {
    #[serde(rename = "read")]
    Read,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ReplaceOperation {
    #[serde(rename = "replace")]
    Replace,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AcquireLockOperation {
    #[serde(rename = "acquire-lock")]
    AcquireLock,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum QuarantineOperation {
    #[serde(rename = "quarantine-if-hash")]
    Quarantine,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RecoverQuarantineOperation {
    #[serde(rename = "recover-quarantine")]
    RecoverQuarantine,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ReleaseLockOperation {
    #[serde(rename = "compare-release-lock")]
    ReleaseLock,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuarantineDecision {
    Restore,
    Commit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoverQuarantineResult {
    Restored,
    Committed,
    Replaced,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseLockResult {
    Released,
    Missing,
    Replaced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockOwner {
    pub pid: u32,
    pub token: String,
    pub owner_generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: ReadOperation,
    pub project_root: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: ReplaceOperation,
    pub project_root: String,
    pub relative_path: String,
    pub bytes_base64: String,
    pub expected: Option<LifecycleGeneration>,
    pub owner_generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquireLockRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: AcquireLockOperation,
    pub project_root: String,
    pub lock_relative_path: String,
    pub owner: LockOwner,
    pub stale_after_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuarantineRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: QuarantineOperation,
    pub project_root: String,
    pub relative_path: String,
    pub expected_sha256: String,
    pub request_id_to_restore: String,
    pub owner_generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverQuarantineRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: RecoverQuarantineOperation,
    pub project_root: String,
    pub quarantine: BoundQuarantine,
    pub decision: QuarantineDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseLockRequest {
    pub protocol: String,
    pub request_id: String,
    pub op: ReleaseLockOperation,
    pub project_root: String,
    pub lock: BoundLock,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum HelperRequest {
    Read(ReadRequest),
    Replace(ReplaceRequest),
    AcquireLock(AcquireLockRequest),
    Quarantine(QuarantineRequest),
    RecoverQuarantine(RecoverQuarantineRequest),
    ReleaseLock(ReleaseLockRequest),
}

impl HelperRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Read(request) => &request.request_id,
            Self::Replace(request) => &request.request_id,
            Self::AcquireLock(request) => &request.request_id,
            Self::Quarantine(request) => &request.request_id,
            Self::RecoverQuarantine(request) => &request.request_id,
            Self::ReleaseLock(request) => &request.request_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HelperFailureCode {
    UnsafePath,
    Unsupported,
    Missing,
    Replaced,
    Busy,
    HashMismatch,
    NativeError,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperSuccess<T> {
    pub protocol: String,
    pub request_id: String,
    pub ok: bool,
    pub result: T,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperFailure {
    pub protocol: String,
    pub request_id: String,
    pub ok: bool,
    pub code: HelperFailureCode,
    pub native_status: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum HelperResponse<T> {
    Success(HelperSuccess<T>),
    Failure(HelperFailure),
}
