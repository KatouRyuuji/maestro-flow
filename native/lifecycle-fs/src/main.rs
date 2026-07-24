mod generation;
#[cfg(all(unix, feature = "posix"))]
mod posix;
mod protocol;
#[cfg(all(windows, feature = "windows"))]
mod windows;

use std::io::{self, Read};

use generation::{parse_and_validate_request, validate_failure};
use protocol::{
    HelperFailure, HelperFailureCode, HelperRequest, HelperResponse, HelperSuccess, HELPER_PROTOCOL,
};
use serde_json::Value;

fn request_id_from_json(input: &str) -> String {
    serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|value| value.get("requestId")?.as_str().map(str::to_owned))
        .filter(|request_id| !request_id.is_empty() && !request_id.contains('\0'))
        .unwrap_or_else(|| "invalid-request".to_owned())
}

fn unsupported(request_id: String) -> HelperFailure {
    HelperFailure {
        protocol: HELPER_PROTOCOL.to_owned(),
        request_id,
        ok: false,
        code: HelperFailureCode::Unsupported,
        native_status: None,
        message: "no platform backend was selected".to_owned(),
    }
}

#[cfg(all(unix, feature = "posix"))]
fn platform_dispatch(request: HelperRequest) -> Result<Value, HelperFailure> {
    posix::dispatch(request)
}

#[cfg(all(windows, feature = "windows"))]
fn platform_dispatch(request: HelperRequest) -> Result<Value, HelperFailure> {
    windows::dispatch(request)
}

#[cfg(not(any(all(unix, feature = "posix"), all(windows, feature = "windows"))))]
fn platform_dispatch(request: HelperRequest) -> Result<Value, HelperFailure> {
    Err(unsupported(request.request_id().to_owned()))
}

fn run() -> HelperResponse<Value> {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        return HelperResponse::Failure(HelperFailure {
            protocol: HELPER_PROTOCOL.to_owned(),
            request_id: "invalid-request".to_owned(),
            ok: false,
            code: HelperFailureCode::NativeError,
            native_status: None,
            message: "failed to read UTF-8 request bytes".to_owned(),
        });
    }

    let fallback_request_id = request_id_from_json(&input);
    match parse_and_validate_request(&input) {
        Ok(request) => {
            let request_id = request.request_id().to_owned();
            match platform_dispatch(request) {
                Ok(result) => HelperResponse::Success(HelperSuccess {
                    protocol: HELPER_PROTOCOL.to_owned(),
                    request_id,
                    ok: true,
                    result,
                }),
                Err(failure) => HelperResponse::Failure(failure),
            }
        }
        Err(error) => HelperResponse::Failure(error.failure(fallback_request_id)),
    }
}

fn main() {
    let response = run();
    if let HelperResponse::Failure(failure) = &response {
        if validate_failure(failure).is_err() {
            std::process::exit(1);
        }
    }
    match serde_json::to_string(&response) {
        Ok(document) => println!("{document}"),
        Err(_) => std::process::exit(1),
    }
}
