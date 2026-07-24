#[path = "../src/generation.rs"]
mod generation;
#[path = "../src/protocol.rs"]
mod protocol;

use std::io::Write;
use std::process::{Command, Stdio};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use generation::{canonical_json, parse_and_validate_request};
use protocol::{
    BoundLock, BoundRead, HelperFailure, HelperFailureCode, HelperRequest, LifecycleGeneration,
    LifecyclePlatform, PlatformIdentity, GENERATION_SCHEMA, HELPER_PROTOCOL,
};
use serde_json::{json, Value};

fn project_root() -> String {
    std::env::current_dir()
        .expect("current directory")
        .canonicalize()
        .expect("canonical current directory")
        .to_string_lossy()
        .into_owned()
}

fn posix_generation() -> LifecycleGeneration {
    LifecycleGeneration {
        schema_version: GENERATION_SCHEMA.to_owned(),
        platform: LifecyclePlatform::Posix,
        root: PlatformIdentity::Posix {
            dev: "9007199254740993".to_owned(),
            ino: "9007199254740995".to_owned(),
            mode: 0o40755,
        },
        parent_chain: vec![PlatformIdentity::Posix {
            dev: "9007199254740997".to_owned(),
            ino: "9007199254740999".to_owned(),
            mode: 0o40700,
        }],
        entry: PlatformIdentity::Posix {
            dev: "9007199254741001".to_owned(),
            ino: "9007199254741003".to_owned(),
            mode: 0o100600,
        },
        sha256: format!("sha256:{}", "a".repeat(64)),
        owner_generation: Some("owner-generation-17".to_owned()),
    }
}

fn invoke_helper(request: &Value) -> (i32, HelperFailure) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lifecycle-fs-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn lifecycle helper");
    child
        .stdin
        .take()
        .expect("helper stdin")
        .write_all(
            serde_json::to_string(request)
                .expect("serialize request")
                .as_bytes(),
        )
        .expect("write helper request");
    let output = child.wait_with_output().expect("wait for helper");
    let failure = serde_json::from_slice(&output.stdout).expect("decode helper failure");
    (output.status.code().expect("helper exit code"), failure)
}

#[test]
fn rejects_unsafe_requests() {
    let root = project_root();
    let requests = [
        json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "unknown-key",
            "op": "read",
            "projectRoot": root,
            "relativePath": "safe/file.json",
            "unexpected": true
        }),
        json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "absolute",
            "op": "read",
            "projectRoot": root,
            "relativePath": "/outside"
        }),
        json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "dot-dot",
            "op": "replace",
            "projectRoot": root,
            "relativePath": "safe/../outside",
            "bytesBase64": "",
            "expected": null,
            "ownerGeneration": "owner"
        }),
        json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "backslash",
            "op": "acquire-lock",
            "projectRoot": root,
            "lockRelativePath": "safe\\lock",
            "owner": {"pid": 1, "token": "token", "ownerGeneration": "owner"},
            "staleAfterMs": 1000
        }),
        json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "nul",
            "op": "quarantine-if-hash",
            "projectRoot": root,
            "relativePath": "safe\u{0}file",
            "expectedSha256": format!("sha256:{}", "b".repeat(64)),
            "requestIdToRestore": "restore-request",
            "ownerGeneration": "owner"
        }),
    ];

    for request in requests {
        let (exit_code, failure) = invoke_helper(&request);
        assert_eq!(exit_code, 0);
        assert_eq!(failure.protocol, HELPER_PROTOCOL);
        assert!(!failure.ok);
        assert_eq!(failure.code, HelperFailureCode::UnsafePath);
        assert_eq!(failure.native_status, None);
    }
}

#[test]
fn path_escape_regression() {
    let root = project_root();
    let attempts = [
        "/absolute",
        "C:/absolute",
        ".",
        "..",
        "a/../b",
        "a//b",
        "a\\b",
        "a\0b",
    ];
    let mut backend_dispatches = 0;

    for relative_path in attempts {
        let request = json!({
            "protocol": HELPER_PROTOCOL,
            "requestId": "escape-regression",
            "op": "read",
            "projectRoot": root,
            "relativePath": relative_path
        });
        if parse_and_validate_request(&request.to_string()).is_ok() {
            backend_dispatches += 1;
        }
    }

    assert_eq!(
        backend_dispatches, 0,
        "unsafe path reached backend dispatch marker"
    );
}

#[test]
fn generation_roundtrip() {
    let generation = posix_generation();
    let lock = BoundLock {
        lock_relative_path: ".maestro/knowhow/.lifecycle.lock".to_owned(),
        token: "token-with-exact-bytes".to_owned(),
        owner_generation: "owner-generation-17".to_owned(),
        generation,
    };

    let document = serde_json::to_string(&lock).expect("serialize bound lock");
    let decoded: BoundLock = serde_json::from_str(&document).expect("deserialize bound lock");
    assert_eq!(decoded, lock);
    assert_eq!(
        canonical_json(&decoded).expect("canonical bound lock"),
        canonical_json(&lock).expect("canonical source lock")
    );

    let value: Value = serde_json::from_str(&document).expect("bound lock JSON");
    assert_eq!(value["generation"]["root"]["dev"], "9007199254740993");
    assert_eq!(
        value["generation"]["ownerGeneration"],
        "owner-generation-17"
    );
    assert_eq!(value["token"], "token-with-exact-bytes");
}

#[test]
fn payload_above_eight_mib() {
    let bytes = vec![0x5a; 8 * 1024 * 1024 + 1];
    let encoded = BASE64_STANDARD.encode(&bytes);
    let request = json!({
        "protocol": HELPER_PROTOCOL,
        "requestId": "large-payload",
        "op": "replace",
        "projectRoot": project_root(),
        "relativePath": "knowhow/large.md",
        "bytesBase64": encoded,
        "expected": null,
        "ownerGeneration": "owner-large"
    });

    let parsed = parse_and_validate_request(&request.to_string()).expect("large request accepted");
    let HelperRequest::Replace(parsed) = parsed else {
        panic!("expected replace request");
    };
    assert_eq!(
        BASE64_STANDARD
            .decode(&parsed.bytes_base64)
            .expect("decode payload"),
        bytes
    );

    let bound = BoundRead {
        bytes_base64: parsed.bytes_base64,
        generation: posix_generation(),
    };
    let roundtrip: BoundRead =
        serde_json::from_str(&serde_json::to_string(&bound).expect("serialize large bound read"))
            .expect("deserialize large bound read");
    assert_eq!(
        BASE64_STANDARD
            .decode(roundtrip.bytes_base64)
            .expect("decode roundtrip"),
        bytes
    );
}

#[test]
fn rejects_malformed_base64_and_nested_unknown_keys() {
    let malformed = json!({
        "protocol": HELPER_PROTOCOL,
        "requestId": "malformed-base64",
        "op": "replace",
        "projectRoot": project_root(),
        "relativePath": "knowhow/file.md",
        "bytesBase64": "not base64!",
        "expected": null,
        "ownerGeneration": "owner"
    });
    assert!(parse_and_validate_request(&malformed.to_string()).is_err());

    let mut generation = serde_json::to_value(posix_generation()).expect("generation value");
    generation["entry"]["unexpected"] = json!(true);
    let nested_unknown = json!({
        "protocol": HELPER_PROTOCOL,
        "requestId": "nested-unknown",
        "op": "replace",
        "projectRoot": project_root(),
        "relativePath": "knowhow/file.md",
        "bytesBase64": "",
        "expected": generation,
        "ownerGeneration": "owner"
    });
    assert!(parse_and_validate_request(&nested_unknown.to_string()).is_err());
}
