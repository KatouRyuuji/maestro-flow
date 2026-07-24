use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::protocol::{
    BoundLock, BoundQuarantine, HelperFailure, HelperFailureCode, HelperRequest,
    LifecycleGeneration, LifecyclePlatform, PlatformIdentity, GENERATION_SCHEMA, HELPER_PROTOCOL,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationError {
    message: String,
}

impl ValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn failure(&self, request_id: impl Into<String>) -> HelperFailure {
        HelperFailure {
            protocol: HELPER_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            ok: false,
            code: HelperFailureCode::UnsafePath,
            native_status: None,
            message: self.message.clone(),
        }
    }
}

pub fn normalize_relative_path(input: &str) -> Result<String, ValidationError> {
    if input.is_empty() {
        return Err(ValidationError::new("relative path must not be empty"));
    }
    if input.contains('\0') {
        return Err(ValidationError::new("relative path contains NUL"));
    }
    if input.contains('\\') {
        return Err(ValidationError::new(
            "relative path must use normalized forward slashes",
        ));
    }
    if input.starts_with('/')
        || Path::new(input).is_absolute()
        || input.as_bytes().get(1) == Some(&b':')
    {
        return Err(ValidationError::new("relative path must not be absolute"));
    }

    let mut normalized = Vec::new();
    for component in input.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(ValidationError::new(
                "relative path contains an empty or dot component",
            ));
        }
        normalized.push(component);
    }
    Ok(normalized.join("/"))
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn canonicalize_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_value).collect()),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut canonical = Map::new();
            for (key, child) in entries {
                canonical.insert(key, canonicalize_value(child));
            }
            Value::Object(canonical)
        }
        scalar => scalar,
    }
}

pub fn canonical_json<T: Serialize>(value: &T) -> Result<String, ValidationError> {
    let value = serde_json::to_value(value)
        .map_err(|_| ValidationError::new("value cannot be represented as JSON"))?;
    serde_json::to_string(&canonicalize_value(value))
        .map_err(|_| ValidationError::new("value cannot be encoded as canonical JSON"))
}

pub fn owner_generation<T: Serialize>(value: &T) -> Result<String, ValidationError> {
    Ok(sha256(canonical_json(value)?.as_bytes()))
}

fn validate_non_empty(value: &str, field: &str) -> Result<(), ValidationError> {
    if value.is_empty() || value.contains('\0') {
        return Err(ValidationError::new(format!(
            "{field} must be a non-empty NUL-free string"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<(), ValidationError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ValidationError::new(format!(
            "{field} must use the sha256:<lowercase-hex> form"
        )));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ValidationError::new(format!(
            "{field} must contain 64 lowercase hexadecimal digits"
        )));
    }
    Ok(())
}

fn validate_identity(identity: &PlatformIdentity) -> Result<(), ValidationError> {
    match identity {
        PlatformIdentity::Posix { dev, ino, .. } => {
            validate_non_empty(dev, "identity.dev")?;
            validate_non_empty(ino, "identity.ino")
        }
        PlatformIdentity::Windows {
            volume_serial,
            file_id128,
            ..
        } => {
            validate_non_empty(volume_serial, "identity.volumeSerial")?;
            validate_non_empty(file_id128, "identity.fileId128")
        }
    }
}

fn identity_matches_platform(identity: &PlatformIdentity, platform: LifecyclePlatform) -> bool {
    matches!(
        (identity, platform),
        (PlatformIdentity::Posix { .. }, LifecyclePlatform::Posix)
            | (PlatformIdentity::Windows { .. }, LifecyclePlatform::Windows)
    )
}

pub fn validate_generation(generation: &LifecycleGeneration) -> Result<(), ValidationError> {
    if generation.schema_version != GENERATION_SCHEMA {
        return Err(ValidationError::new(
            "unsupported lifecycle generation schema",
        ));
    }
    validate_sha256(&generation.sha256, "generation.sha256")?;
    if let Some(owner_generation) = &generation.owner_generation {
        validate_non_empty(owner_generation, "generation.ownerGeneration")?;
    }

    let identities = std::iter::once(&generation.root)
        .chain(generation.parent_chain.iter())
        .chain(std::iter::once(&generation.entry));
    for identity in identities {
        validate_identity(identity)?;
        if !identity_matches_platform(identity, generation.platform) {
            return Err(ValidationError::new(
                "generation identity does not match its platform",
            ));
        }
    }
    Ok(())
}

fn validate_bound_lock(lock: &BoundLock) -> Result<(), ValidationError> {
    normalize_relative_path(&lock.lock_relative_path)?;
    validate_non_empty(&lock.token, "lock.token")?;
    validate_non_empty(&lock.owner_generation, "lock.ownerGeneration")?;
    validate_generation(&lock.generation)
}

fn validate_bound_quarantine(quarantine: &BoundQuarantine) -> Result<(), ValidationError> {
    normalize_relative_path(&quarantine.original_relative_path)?;
    normalize_relative_path(&quarantine.quarantine_relative_path)?;
    validate_non_empty(&quarantine.request_id, "quarantine.requestId")?;
    validate_non_empty(&quarantine.owner_generation, "quarantine.ownerGeneration")?;
    validate_sha256(&quarantine.expected_sha256, "quarantine.expectedSha256")?;
    validate_generation(&quarantine.generation)
}

fn validate_project_root(project_root: &str) -> Result<(), ValidationError> {
    validate_non_empty(project_root, "projectRoot")?;
    if !Path::new(project_root).is_absolute() {
        return Err(ValidationError::new("projectRoot must be absolute"));
    }
    Ok(())
}

fn validate_protocol_request(
    protocol: &str,
    request_id: &str,
    project_root: &str,
) -> Result<(), ValidationError> {
    if protocol != HELPER_PROTOCOL {
        return Err(ValidationError::new("unsupported helper protocol"));
    }
    validate_non_empty(request_id, "requestId")?;
    validate_project_root(project_root)
}

pub fn validate_request(request: &HelperRequest) -> Result<(), ValidationError> {
    match request {
        HelperRequest::Read(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            normalize_relative_path(&request.relative_path)?;
        }
        HelperRequest::Replace(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            normalize_relative_path(&request.relative_path)?;
            BASE64_STANDARD
                .decode(&request.bytes_base64)
                .map_err(|_| ValidationError::new("bytesBase64 is malformed"))?;
            if let Some(generation) = &request.expected {
                validate_generation(generation)?;
            }
            validate_non_empty(&request.owner_generation, "ownerGeneration")?;
        }
        HelperRequest::AcquireLock(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            normalize_relative_path(&request.lock_relative_path)?;
            if request.owner.pid == 0 {
                return Err(ValidationError::new("owner.pid must be positive"));
            }
            validate_non_empty(&request.owner.token, "owner.token")?;
            validate_non_empty(&request.owner.owner_generation, "owner.ownerGeneration")?;
        }
        HelperRequest::Quarantine(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            normalize_relative_path(&request.relative_path)?;
            validate_sha256(&request.expected_sha256, "expectedSha256")?;
            validate_non_empty(&request.request_id_to_restore, "requestIdToRestore")?;
            validate_non_empty(&request.owner_generation, "ownerGeneration")?;
        }
        HelperRequest::RecoverQuarantine(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            validate_bound_quarantine(&request.quarantine)?;
        }
        HelperRequest::ReleaseLock(request) => {
            validate_protocol_request(
                &request.protocol,
                &request.request_id,
                &request.project_root,
            )?;
            validate_bound_lock(&request.lock)?;
        }
    }
    Ok(())
}

pub fn parse_and_validate_request(input: &str) -> Result<HelperRequest, ValidationError> {
    let request: HelperRequest = serde_json::from_str(input)
        .map_err(|_| ValidationError::new("request does not satisfy the exact wire contract"))?;
    validate_request(&request)?;
    Ok(request)
}

pub fn validate_failure(failure: &HelperFailure) -> Result<(), ValidationError> {
    if failure.protocol != HELPER_PROTOCOL || failure.ok {
        return Err(ValidationError::new("invalid helper failure envelope"));
    }
    validate_non_empty(&failure.request_id, "failure.requestId")?;
    validate_non_empty(&failure.message, "failure.message")?;
    if failure
        .native_status
        .as_deref()
        .is_some_and(|status| status.is_empty() || status.contains('\0'))
    {
        return Err(ValidationError::new(
            "failure.nativeStatus must be null or a non-empty NUL-free string",
        ));
    }
    Ok(())
}
