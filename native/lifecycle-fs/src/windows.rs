#![cfg(windows)]

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io::{Read, Write};
use std::mem::{self, MaybeUninit};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::Path;
use std::ptr;
use std::sync::OnceLock;

#[cfg(test)]
use std::cell::RefCell;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    FileAttributeTagInfo, FileBasicInfo, FileIdInfo, FileStandardInfo,
    GetFileInformationByHandleEx, LockFileEx, UnlockFileEx, FILE_ATTRIBUTE_TAG_INFO,
    FILE_BASIC_INFO, FILE_ID_INFO, FILE_STANDARD_INFO, LOCKFILE_EXCLUSIVE_LOCK,
    LOCKFILE_FAIL_IMMEDIATELY,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::IO::OVERLAPPED;

use crate::generation::{normalize_relative_path, sha256};
use crate::protocol::{
    BoundLock, BoundQuarantine, BoundRead, HelperFailure, HelperFailureCode, HelperRequest,
    LifecycleGeneration, LifecyclePlatform, LockOwner, PlatformIdentity, QuarantineDecision,
    RecoverQuarantineResult, ReleaseLockResult, GENERATION_SCHEMA, HELPER_PROTOCOL,
};

const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
const OBJ_DONT_REPARSE: u32 = 0x0000_1000;

const DELETE: u32 = 0x0001_0000;
const FILE_READ_DATA: u32 = 0x0000_0001;
const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
const FILE_WRITE_DATA: u32 = 0x0000_0002;
const FILE_TRAVERSE: u32 = 0x0000_0020;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const SYNCHRONIZE: u32 = 0x0010_0000;

const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
const FILE_SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

const FILE_OPEN: u32 = 0x0000_0001;
const FILE_CREATE: u32 = 0x0000_0002;
const FILE_OPEN_IF: u32 = 0x0000_0003;

const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

const FILE_RENAME_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
const FILE_RENAME_POSIX_SEMANTICS: u32 = 0x0000_0002;
const FILE_DISPOSITION_DELETE: u32 = 0x0000_0001;
const FILE_DISPOSITION_POSIX_SEMANTICS: u32 = 0x0000_0002;
const FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE: u32 = 0x0000_0010;

const FILE_RENAME_INFORMATION_EX: u32 = 65;
const FILE_DISPOSITION_INFORMATION_EX: u32 = 64;

const STATUS_REPARSE_POINT_ENCOUNTERED: u32 = 0xC000_050B;
const STATUS_IO_REPARSE_TAG_NOT_HANDLED: u32 = 0xC000_0279;
const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;
const STATUS_OBJECT_PATH_NOT_FOUND: u32 = 0xC000_003A;
const STATUS_OBJECT_NAME_COLLISION: u32 = 0xC000_0035;
const STATUS_SHARING_VIOLATION: u32 = 0xC000_0043;
const STATUS_LOCK_NOT_GRANTED: u32 = 0xC000_0055;
const STATUS_DELETE_PENDING: u32 = 0xC000_0056;
const STATUS_INVALID_PARAMETER: u32 = 0xC000_000D;
const STATUS_PROCEDURE_NOT_FOUND: u32 = 0xC000_007A;
const STATUS_NOT_SUPPORTED: u32 = 0xC000_00BB;

const ERROR_INVALID_FUNCTION: u32 = 1;
const ERROR_INVALID_PARAMETER: u32 = 87;
const ERROR_CALL_NOT_IMPLEMENTED: u32 = 120;
const ERROR_NOT_SUPPORTED: u32 = 50;
const ERROR_PROC_NOT_FOUND: u32 = 127;
const ERROR_LOCK_VIOLATION: u32 = 33;
const ERROR_SHARING_VIOLATION: u32 = 32;
const ERROR_IO_PENDING: u32 = 997;

const DIRECTORY_ACCESS: u32 =
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const DIRECTORY_OPTIONS: u32 =
    FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
const READ_ACCESS: u32 = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const MUTATION_ACCESS: u32 = READ_ACCESS | FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | DELETE;
const FILE_OPTIONS: u32 =
    FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
const COORDINATOR_NAME: &str = ".maestro-lifecycle.coordinator";

type NtStatus = i32;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status_or_pointer: usize,
    information: usize,
}

type NtCreateFileFn = unsafe extern "system" fn(
    *mut HANDLE,
    u32,
    *const ObjectAttributes,
    *mut IoStatusBlock,
    *const i64,
    u32,
    u32,
    u32,
    u32,
    *const c_void,
    u32,
) -> NtStatus;
type NtOpenFileFn = unsafe extern "system" fn(
    *mut HANDLE,
    u32,
    *const ObjectAttributes,
    *mut IoStatusBlock,
    u32,
    u32,
) -> NtStatus;
type NtSetInformationFileFn =
    unsafe extern "system" fn(HANDLE, *mut IoStatusBlock, *mut c_void, u32, u32) -> NtStatus;
type RtlNtStatusToDosErrorFn = unsafe extern "system" fn(NtStatus) -> u32;

#[derive(Clone, Copy)]
struct NtdllApi {
    nt_create_file: NtCreateFileFn,
    nt_open_file: NtOpenFileFn,
    nt_set_information_file: NtSetInformationFileFn,
    rtl_nt_status_to_dos_error: RtlNtStatusToDosErrorFn,
}

static NTDLL: OnceLock<Result<NtdllApi, WindowsError>> = OnceLock::new();

#[cfg(test)]
static AMBIENT_ROOT_OPENS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TestEvent {
    ComponentOpened(usize),
    BeforeMutation,
}

#[cfg(test)]
thread_local! {
    static TEST_HOOK: RefCell<Option<Box<dyn FnMut(TestEvent)>>> = RefCell::new(None);
}

#[cfg(test)]
fn invoke_test_hook(event: TestEvent) {
    TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(event);
        }
    });
}

#[cfg(not(test))]
fn invoke_component_hook(_index: usize) {}

#[cfg(test)]
fn invoke_component_hook(index: usize) {
    invoke_test_hook(TestEvent::ComponentOpened(index));
}

#[cfg(not(test))]
fn invoke_mutation_hook() {}

#[cfg(test)]
fn invoke_mutation_hook() {
    invoke_test_hook(TestEvent::BeforeMutation);
}

#[cfg(test)]
pub mod test_support {
    use super::{TestEvent, AMBIENT_ROOT_OPENS, TEST_HOOK};
    use std::sync::atomic::Ordering;

    pub fn set_hook(hook: impl FnMut(TestEvent) + 'static) {
        TEST_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub fn clear_hook() {
        TEST_HOOK.with(|slot| *slot.borrow_mut() = None);
    }

    pub fn reset_ambient_root_opens() {
        AMBIENT_ROOT_OPENS.store(0, Ordering::SeqCst);
    }

    pub fn ambient_root_opens() -> usize {
        AMBIENT_ROOT_OPENS.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContainmentCapability {
    Auto,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowsError {
    pub code: HelperFailureCode,
    pub native_status: Option<String>,
    pub message: String,
}

impl WindowsError {
    fn new(code: HelperFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            native_status: None,
            message: message.into(),
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::new(HelperFailureCode::Unsupported, message)
    }

    fn replaced(message: impl Into<String>) -> Self {
        Self::new(HelperFailureCode::Replaced, message)
    }

    fn from_status(api: &NtdllApi, status: NtStatus, context: &str) -> Self {
        let raw = status as u32;
        let code = match raw {
            STATUS_REPARSE_POINT_ENCOUNTERED | STATUS_IO_REPARSE_TAG_NOT_HANDLED => {
                HelperFailureCode::UnsafePath
            }
            STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND => {
                HelperFailureCode::Missing
            }
            STATUS_OBJECT_NAME_COLLISION => HelperFailureCode::Replaced,
            STATUS_SHARING_VIOLATION | STATUS_DELETE_PENDING | STATUS_LOCK_NOT_GRANTED => {
                HelperFailureCode::Busy
            }
            STATUS_NOT_SUPPORTED | STATUS_INVALID_PARAMETER | STATUS_PROCEDURE_NOT_FOUND => {
                HelperFailureCode::Unsupported
            }
            _ => HelperFailureCode::NativeError,
        };
        let dos = unsafe { (api.rtl_nt_status_to_dos_error)(status) };
        Self {
            code,
            native_status: Some(format!("0x{raw:08X}")),
            message: format!("{context}: NTSTATUS 0x{raw:08X} (Win32 0x{dos:08X})"),
        }
    }

    fn from_win32(error: u32, context: &str) -> Self {
        let code = match error {
            ERROR_INVALID_FUNCTION
            | ERROR_INVALID_PARAMETER
            | ERROR_CALL_NOT_IMPLEMENTED
            | ERROR_NOT_SUPPORTED
            | ERROR_PROC_NOT_FOUND => HelperFailureCode::Unsupported,
            ERROR_LOCK_VIOLATION | ERROR_SHARING_VIOLATION | ERROR_IO_PENDING => {
                HelperFailureCode::Busy
            }
            _ => HelperFailureCode::NativeError,
        };
        Self {
            code,
            native_status: Some(format!("WIN32:0x{error:08X}")),
            message: format!("{context}: Win32 error 0x{error:08X}"),
        }
    }

    fn last_win32(context: &str) -> Self {
        Self::from_win32(unsafe { GetLastError() }, context)
    }

    pub fn failure(&self, request_id: impl Into<String>) -> HelperFailure {
        HelperFailure {
            protocol: HELPER_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            ok: false,
            code: self.code,
            native_status: self.native_status.clone(),
            message: self.message.clone(),
        }
    }
}

struct NtHandle(HANDLE);

impl NtHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_file(self) -> File {
        let raw = self.0;
        mem::forget(self);
        unsafe { File::from_raw_handle(raw as RawHandle) }
    }
}

impl Drop for NtHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct ResolvedParent {
    directories: Vec<NtHandle>,
    components: Vec<String>,
    parent_chain: Vec<PlatformIdentity>,
    leaf: String,
    normalized: String,
}

impl ResolvedParent {
    fn parent_handle(&self, root: HANDLE) -> HANDLE {
        self.directories
            .last()
            .map_or(root, |directory| directory.raw())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StableSnapshot {
    identity: PlatformIdentity,
    last_write_time: i64,
    change_time: i64,
    end_of_file: i64,
}

struct OpenedEntry {
    file: File,
    bytes: Vec<u8>,
    generation: LifecycleGeneration,
}

struct CoordinatorGuard {
    file: File,
    overlapped: OVERLAPPED,
}

impl Drop for CoordinatorGuard {
    fn drop(&mut self) {
        unsafe {
            UnlockFileEx(
                self.file.as_raw_handle() as HANDLE,
                0,
                u32::MAX,
                u32::MAX,
                &mut self.overlapped,
            );
        }
    }
}

pub struct WindowsBackend {
    api: &'static NtdllApi,
    root: NtHandle,
    root_identity: PlatformIdentity,
}

impl WindowsBackend {
    pub fn open(project_root: &Path) -> Result<Self, WindowsError> {
        Self::open_with_capability(project_root, ContainmentCapability::Auto)
    }

    pub fn open_with_capability(
        project_root: &Path,
        capability: ContainmentCapability,
    ) -> Result<Self, WindowsError> {
        if capability == ContainmentCapability::Unavailable {
            return Err(WindowsError::unsupported(
                "safe NT handle-relative containment is unavailable",
            ));
        }
        let api = ntdll_api()?;
        let native_root = absolute_nt_path(project_root)?;
        #[cfg(test)]
        AMBIENT_ROOT_OPENS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = nt_create(
            api,
            ptr::null_mut(),
            &native_root,
            DIRECTORY_ACCESS,
            FILE_OPEN,
            DIRECTORY_OPTIONS,
            "open absolute project root",
        )?;
        let root_identity = identity_checked(root.raw(), true)?;
        Ok(Self {
            api,
            root,
            root_identity,
        })
    }

    pub fn read(&self, relative_path: &str) -> Result<BoundRead, WindowsError> {
        let parent = self.resolve_parent(relative_path)?;
        let opened = self.read_generation(&parent, None, false)?;
        Ok(BoundRead {
            bytes_base64: BASE64_STANDARD.encode(opened.bytes),
            generation: opened.generation,
        })
    }

    pub fn replace(
        &self,
        relative_path: &str,
        bytes: &[u8],
        expected: Option<&LifecycleGeneration>,
        owner_generation: &str,
    ) -> Result<LifecycleGeneration, WindowsError> {
        let _coordinator = self.coordinator()?;
        let parent = self.resolve_parent(relative_path)?;
        let expected_entry = match expected {
            Some(expected) => Some(self.assert_generation(&parent, expected, true)?),
            None => match self.read_generation(&parent, None, false) {
                Ok(_) => {
                    return Err(WindowsError::new(
                        HelperFailureCode::Busy,
                        "replace target already exists",
                    ))
                }
                Err(error) if error.code == HelperFailureCode::Missing => None,
                Err(error) => return Err(error),
            },
        };

        let temporary_leaf = private_leaf("replace", &parent.leaf, owner_generation)?;
        let temporary = nt_create(
            self.api,
            parent.parent_handle(self.root.raw()),
            &temporary_leaf,
            MUTATION_ACCESS,
            FILE_CREATE,
            FILE_OPTIONS,
            "create handle-relative replacement",
        )?;
        let mut temporary_file = temporary.into_file();
        if let Err(error) = temporary_file
            .write_all(bytes)
            .and_then(|_| temporary_file.sync_all())
        {
            let _ = self.set_disposition(temporary_file.as_raw_handle() as HANDLE);
            return Err(io_error(error, "write replacement bytes"));
        }

        if let Some(opened) = &expected_entry {
            invoke_mutation_hook();
            self.verify_parent_chain(&parent)?;
            self.verify_leaf_binding(&parent, &opened.generation.entry)?;
        }
        let replace_existing = expected_entry.is_some();
        if let Err(error) = self.rename_handle(
            temporary_file.as_raw_handle() as HANDLE,
            parent.parent_handle(self.root.raw()),
            &parent.leaf,
            replace_existing,
        ) {
            let _ = self.set_disposition(temporary_file.as_raw_handle() as HANDLE);
            return Err(error);
        }
        drop(temporary_file);
        drop(expected_entry);

        let mut observed = self.read_generation(&parent, Some(&sha256(bytes)), false)?;
        observed.generation.owner_generation = Some(owner_generation.to_owned());
        Ok(observed.generation)
    }

    pub fn acquire_lock(
        &self,
        relative_path: &str,
        owner: &LockOwner,
    ) -> Result<BoundLock, WindowsError> {
        let _coordinator = self.coordinator()?;
        let parent = self.resolve_parent(relative_path)?;
        let handle = match nt_create(
            self.api,
            parent.parent_handle(self.root.raw()),
            &parent.leaf,
            MUTATION_ACCESS,
            FILE_CREATE,
            FILE_OPTIONS,
            "create handle-relative lifecycle lock",
        ) {
            Err(error) if error.code == HelperFailureCode::Replaced => {
                return Err(WindowsError::new(
                    HelperFailureCode::Busy,
                    "lifecycle lock already exists",
                ))
            }
            result => result?,
        };
        let mut file = handle.into_file();
        let bytes = serde_json::to_vec(owner)
            .map_err(|_| WindowsError::new(HelperFailureCode::NativeError, "encode lock owner"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| io_error(error, "write lifecycle lock owner"))?;
        drop(file);

        let mut opened = self.read_generation(&parent, Some(&sha256(&bytes)), false)?;
        opened.generation.owner_generation = Some(owner.owner_generation.clone());
        Ok(BoundLock {
            lock_relative_path: parent.normalized,
            token: owner.token.clone(),
            owner_generation: owner.owner_generation.clone(),
            generation: opened.generation,
        })
    }

    pub fn quarantine(
        &self,
        relative_path: &str,
        expected_sha256: &str,
        request_id: &str,
        owner_generation: &str,
    ) -> Result<BoundQuarantine, WindowsError> {
        let _coordinator = self.coordinator()?;
        let parent = self.resolve_parent(relative_path)?;
        let opened = self.read_generation(&parent, Some(expected_sha256), true)?;
        let quarantine_leaf = quarantine_leaf(&parent.leaf, request_id, owner_generation)?;

        invoke_mutation_hook();
        self.verify_parent_chain(&parent)?;
        self.verify_leaf_binding(&parent, &opened.generation.entry)?;
        self.rename_handle(
            opened.file.as_raw_handle() as HANDLE,
            parent.parent_handle(self.root.raw()),
            &quarantine_leaf,
            false,
        )?;

        let quarantine_relative_path = sibling_relative_path(&parent.normalized, &quarantine_leaf);
        let moved_parent = self.resolve_parent(&quarantine_relative_path)?;
        let mut moved = self.read_generation(&moved_parent, Some(expected_sha256), false)?;
        if !same_generation(&moved.generation, &opened.generation) {
            let _ = self.rename_handle(
                opened.file.as_raw_handle() as HANDLE,
                parent.parent_handle(self.root.raw()),
                &parent.leaf,
                false,
            );
            return Err(WindowsError::replaced(
                "source generation changed while entering quarantine",
            ));
        }
        moved.generation.owner_generation = Some(owner_generation.to_owned());
        Ok(BoundQuarantine {
            original_relative_path: parent.normalized,
            quarantine_relative_path,
            request_id: request_id.to_owned(),
            owner_generation: owner_generation.to_owned(),
            expected_sha256: expected_sha256.to_owned(),
            generation: moved.generation,
        })
    }

    pub fn recover_quarantine(
        &self,
        quarantine: &BoundQuarantine,
        decision: QuarantineDecision,
    ) -> Result<RecoverQuarantineResult, WindowsError> {
        let _coordinator = self.coordinator()?;
        let source = self.resolve_parent(&quarantine.quarantine_relative_path)?;
        let opened = match self.assert_generation(&source, &quarantine.generation, true) {
            Ok(opened) => opened,
            Err(error)
                if matches!(
                    error.code,
                    HelperFailureCode::Missing | HelperFailureCode::Replaced
                ) =>
            {
                return Ok(RecoverQuarantineResult::Replaced)
            }
            Err(error) => return Err(error),
        };

        invoke_mutation_hook();
        self.verify_parent_chain(&source)?;
        self.verify_leaf_binding(&source, &opened.generation.entry)?;
        match decision {
            QuarantineDecision::Commit => {
                self.set_disposition(opened.file.as_raw_handle() as HANDLE)?;
                drop(opened);
                Ok(RecoverQuarantineResult::Committed)
            }
            QuarantineDecision::Restore => {
                let destination = self.resolve_parent(&quarantine.original_relative_path)?;
                match self.read_generation(&destination, None, false) {
                    Ok(_) => return Ok(RecoverQuarantineResult::Replaced),
                    Err(error) if error.code == HelperFailureCode::Missing => {}
                    Err(error) => return Err(error),
                }
                self.rename_handle(
                    opened.file.as_raw_handle() as HANDLE,
                    destination.parent_handle(self.root.raw()),
                    &destination.leaf,
                    false,
                )?;
                drop(opened);
                let restored =
                    self.read_generation(&destination, Some(&quarantine.expected_sha256), false)?;
                if !same_generation(&restored.generation, &quarantine.generation) {
                    return Err(WindowsError::replaced(
                        "restored name does not contain the quarantined generation",
                    ));
                }
                Ok(RecoverQuarantineResult::Restored)
            }
        }
    }

    pub fn release_lock(&self, lock: &BoundLock) -> Result<ReleaseLockResult, WindowsError> {
        let _coordinator = self.coordinator()?;
        let parent = self.resolve_parent(&lock.lock_relative_path)?;
        let opened = match self.assert_generation(&parent, &lock.generation, true) {
            Ok(opened) => opened,
            Err(error) if error.code == HelperFailureCode::Missing => {
                return Ok(ReleaseLockResult::Missing)
            }
            Err(error) if error.code == HelperFailureCode::Replaced => {
                return Ok(ReleaseLockResult::Replaced)
            }
            Err(error) => return Err(error),
        };
        let owner: LockOwner = serde_json::from_slice(&opened.bytes)
            .map_err(|_| WindowsError::replaced("lock owner bytes are not canonical"))?;
        if owner.token != lock.token || owner.owner_generation != lock.owner_generation {
            return Ok(ReleaseLockResult::Replaced);
        }

        invoke_mutation_hook();
        self.verify_parent_chain(&parent)?;
        match self.verify_leaf_binding(&parent, &opened.generation.entry) {
            Ok(()) => {}
            Err(error) if error.code == HelperFailureCode::Replaced => {
                return Ok(ReleaseLockResult::Replaced)
            }
            Err(error) => return Err(error),
        }
        self.set_disposition(opened.file.as_raw_handle() as HANDLE)?;
        drop(opened);
        Ok(ReleaseLockResult::Released)
    }

    fn resolve_parent(&self, relative_path: &str) -> Result<ResolvedParent, WindowsError> {
        let normalized = normalize_windows_relative(relative_path)?;
        let parts: Vec<&str> = normalized.split('/').collect();
        let mut directories = Vec::with_capacity(parts.len().saturating_sub(1));
        let mut components = Vec::with_capacity(parts.len().saturating_sub(1));
        let mut parent_chain = Vec::with_capacity(parts.len().saturating_sub(1));
        let mut current = self.root.raw();

        for (index, component) in parts[..parts.len() - 1].iter().enumerate() {
            let directory = nt_open(
                self.api,
                current,
                component,
                DIRECTORY_ACCESS,
                DIRECTORY_OPTIONS,
                "open handle-relative directory component",
            )?;
            let identity = identity_checked(directory.raw(), true)?;
            invoke_component_hook(index);
            current = directory.raw();
            components.push((*component).to_owned());
            parent_chain.push(identity);
            directories.push(directory);
        }

        Ok(ResolvedParent {
            directories,
            components,
            parent_chain,
            leaf: parts[parts.len() - 1].to_owned(),
            normalized,
        })
    }

    fn read_generation(
        &self,
        parent: &ResolvedParent,
        expected_hash: Option<&str>,
        mutation: bool,
    ) -> Result<OpenedEntry, WindowsError> {
        let access = if mutation {
            MUTATION_ACCESS
        } else {
            READ_ACCESS
        };
        let handle = nt_open(
            self.api,
            parent.parent_handle(self.root.raw()),
            &parent.leaf,
            access,
            FILE_OPTIONS,
            "open handle-relative lifecycle entry",
        )?;
        let mut file = handle.into_file();
        let before = stable_snapshot(file.as_raw_handle() as HANDLE, false)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| io_error(error, "read lifecycle entry"))?;
        let after = stable_snapshot(file.as_raw_handle() as HANDLE, false)?;
        if before != after {
            return Err(WindowsError::replaced(
                "entry generation changed while reading",
            ));
        }
        self.verify_parent_chain(parent)?;
        self.verify_leaf_binding(parent, &after.identity)?;

        let digest = sha256(&bytes);
        if expected_hash.is_some_and(|expected| expected != digest) {
            return Err(WindowsError::new(
                HelperFailureCode::HashMismatch,
                "entry bytes do not match the expected SHA-256",
            ));
        }
        Ok(OpenedEntry {
            file,
            bytes,
            generation: LifecycleGeneration {
                schema_version: GENERATION_SCHEMA.to_owned(),
                platform: LifecyclePlatform::Windows,
                root: self.root_identity.clone(),
                parent_chain: parent.parent_chain.clone(),
                entry: after.identity,
                sha256: digest,
                owner_generation: None,
            },
        })
    }

    fn assert_generation(
        &self,
        parent: &ResolvedParent,
        expected: &LifecycleGeneration,
        mutation: bool,
    ) -> Result<OpenedEntry, WindowsError> {
        let opened = self.read_generation(parent, Some(&expected.sha256), mutation)?;
        if same_generation(&opened.generation, expected) {
            Ok(opened)
        } else {
            Err(WindowsError::replaced(
                "entry does not match the exact expected generation",
            ))
        }
    }

    fn verify_parent_chain(&self, parent: &ResolvedParent) -> Result<(), WindowsError> {
        let mut held = Vec::with_capacity(parent.components.len());
        let mut current = self.root.raw();
        for (component, expected) in parent.components.iter().zip(&parent.parent_chain) {
            let directory = nt_open(
                self.api,
                current,
                component,
                DIRECTORY_ACCESS,
                DIRECTORY_OPTIONS,
                "revalidate handle-relative directory component",
            )?;
            let observed = identity_checked(directory.raw(), true)?;
            if &observed != expected {
                return Err(WindowsError::new(
                    HelperFailureCode::UnsafePath,
                    "directory generation changed during handle-relative traversal",
                ));
            }
            current = directory.raw();
            held.push(directory);
        }
        Ok(())
    }

    fn verify_leaf_binding(
        &self,
        parent: &ResolvedParent,
        expected: &PlatformIdentity,
    ) -> Result<(), WindowsError> {
        let current = nt_open(
            self.api,
            parent.parent_handle(self.root.raw()),
            &parent.leaf,
            READ_ACCESS,
            FILE_OPTIONS,
            "revalidate handle-relative lifecycle entry",
        )?;
        let observed = identity_checked(current.raw(), false)?;
        if &observed == expected {
            Ok(())
        } else {
            Err(WindowsError::replaced(
                "entry name no longer references the opened generation",
            ))
        }
    }

    fn coordinator(&self) -> Result<CoordinatorGuard, WindowsError> {
        let handle = nt_create(
            self.api,
            self.root.raw(),
            COORDINATOR_NAME,
            MUTATION_ACCESS,
            FILE_OPEN_IF,
            FILE_OPTIONS,
            "open handle-relative lifecycle coordinator",
        )?;
        identity_checked(handle.raw(), false)?;
        let file = handle.into_file();
        let mut overlapped = unsafe { MaybeUninit::<OVERLAPPED>::zeroed().assume_init() };
        let result = unsafe {
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        };
        if result == 0 {
            return Err(WindowsError::last_win32(
                "acquire handle-relative lifecycle coordinator",
            ));
        }
        Ok(CoordinatorGuard { file, overlapped })
    }

    fn rename_handle(
        &self,
        source: HANDLE,
        destination_parent: HANDLE,
        destination_leaf: &str,
        replace: bool,
    ) -> Result<(), WindowsError> {
        let name = encode_component(destination_leaf)?;
        let pointer_size = mem::size_of::<HANDLE>();
        let root_offset = align_up(mem::size_of::<u32>(), pointer_size);
        let length_offset = root_offset + pointer_size;
        let name_offset = length_offset + mem::size_of::<u32>();
        let mut information = vec![0_u8; name_offset + name.len() * mem::size_of::<u16>()];
        let flags = FILE_RENAME_POSIX_SEMANTICS
            | if replace {
                FILE_RENAME_REPLACE_IF_EXISTS
            } else {
                0
            };
        information[..4].copy_from_slice(&flags.to_ne_bytes());
        information[root_offset..root_offset + pointer_size]
            .copy_from_slice(&(destination_parent as usize).to_ne_bytes());
        information[length_offset..length_offset + 4]
            .copy_from_slice(&((name.len() * 2) as u32).to_ne_bytes());
        for (index, character) in name.iter().enumerate() {
            let offset = name_offset + index * 2;
            information[offset..offset + 2].copy_from_slice(&character.to_ne_bytes());
        }
        self.set_information(
            source,
            &mut information,
            FILE_RENAME_INFORMATION_EX,
            "rename exact lifecycle generation",
        )
    }

    fn set_disposition(&self, handle: HANDLE) -> Result<(), WindowsError> {
        let flags = FILE_DISPOSITION_DELETE
            | FILE_DISPOSITION_POSIX_SEMANTICS
            | FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE;
        let mut information = flags.to_ne_bytes();
        self.set_information(
            handle,
            &mut information,
            FILE_DISPOSITION_INFORMATION_EX,
            "dispose exact lifecycle generation",
        )
    }

    fn set_information(
        &self,
        handle: HANDLE,
        information: &mut [u8],
        class: u32,
        context: &str,
    ) -> Result<(), WindowsError> {
        let mut io_status = IoStatusBlock {
            status_or_pointer: 0,
            information: 0,
        };
        let status = unsafe {
            (self.api.nt_set_information_file)(
                handle,
                &mut io_status,
                information.as_mut_ptr().cast(),
                information.len() as u32,
                class,
            )
        };
        nt_result(self.api, status, context)
    }
}

pub fn dispatch(request: HelperRequest) -> Result<Value, HelperFailure> {
    let request_id = request.request_id().to_owned();
    dispatch_inner(request).map_err(|error| error.failure(request_id))
}

fn dispatch_inner(request: HelperRequest) -> Result<Value, WindowsError> {
    match request {
        HelperRequest::Read(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.read(&request.relative_path)?)
        }
        HelperRequest::Replace(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            let bytes = BASE64_STANDARD.decode(request.bytes_base64).map_err(|_| {
                WindowsError::new(HelperFailureCode::UnsafePath, "bytesBase64 is malformed")
            })?;
            serialize_result(backend.replace(
                &request.relative_path,
                &bytes,
                request.expected.as_ref(),
                &request.owner_generation,
            )?)
        }
        HelperRequest::AcquireLock(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.acquire_lock(&request.lock_relative_path, &request.owner)?)
        }
        HelperRequest::Quarantine(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.quarantine(
                &request.relative_path,
                &request.expected_sha256,
                &request.request_id_to_restore,
                &request.owner_generation,
            )?)
        }
        HelperRequest::RecoverQuarantine(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.recover_quarantine(&request.quarantine, request.decision)?)
        }
        HelperRequest::ReleaseLock(request) => {
            let backend = WindowsBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.release_lock(&request.lock)?)
        }
    }
}

fn serialize_result<T: Serialize>(value: T) -> Result<Value, WindowsError> {
    serde_json::to_value(value)
        .map_err(|_| WindowsError::new(HelperFailureCode::NativeError, "encode helper result"))
}

fn ntdll_api() -> Result<&'static NtdllApi, WindowsError> {
    match NTDLL.get_or_init(load_ntdll) {
        Ok(api) => Ok(api),
        Err(error) => Err(error.clone()),
    }
}

fn load_ntdll() -> Result<NtdllApi, WindowsError> {
    let module_name: Vec<u16> = OsStr::new("ntdll.dll")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe { GetModuleHandleW(module_name.as_ptr()) };
    if module.is_null() {
        return Err(WindowsError::unsupported(
            "ntdll.dll is unavailable before filesystem access",
        ));
    }
    unsafe {
        Ok(NtdllApi {
            nt_create_file: load_proc(module, b"NtCreateFile\0")?,
            nt_open_file: load_proc(module, b"NtOpenFile\0")?,
            nt_set_information_file: load_proc(module, b"NtSetInformationFile\0")?,
            rtl_nt_status_to_dos_error: load_proc(module, b"RtlNtStatusToDosError\0")?,
        })
    }
}

unsafe fn load_proc<T: Copy>(module: *mut c_void, name: &'static [u8]) -> Result<T, WindowsError> {
    let proc = GetProcAddress(module, name.as_ptr()).ok_or_else(|| {
        let symbol = String::from_utf8_lossy(&name[..name.len() - 1]);
        WindowsError {
            code: HelperFailureCode::Unsupported,
            native_status: Some(format!("0x{STATUS_PROCEDURE_NOT_FOUND:08X}")),
            message: format!("required ntdll symbol is unavailable: {symbol}"),
        }
    })?;
    Ok(mem::transmute_copy(&proc))
}

fn nt_open(
    api: &NtdllApi,
    root: HANDLE,
    name: &str,
    desired_access: u32,
    options: u32,
    context: &str,
) -> Result<NtHandle, WindowsError> {
    let mut name = NtName::new(name)?;
    let mut attributes = name.attributes(root);
    let mut handle = ptr::null_mut();
    let mut io_status = IoStatusBlock {
        status_or_pointer: 0,
        information: 0,
    };
    let status = unsafe {
        (api.nt_open_file)(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            FILE_SHARE_ALL,
            options,
        )
    };
    nt_result(api, status, context)?;
    if handle.is_null() {
        return Err(WindowsError::new(
            HelperFailureCode::NativeError,
            format!("{context}: NT returned a null handle"),
        ));
    }
    Ok(NtHandle(handle))
}

fn nt_create(
    api: &NtdllApi,
    root: HANDLE,
    name: &str,
    desired_access: u32,
    disposition: u32,
    options: u32,
    context: &str,
) -> Result<NtHandle, WindowsError> {
    let mut name = NtName::new(name)?;
    let mut attributes = name.attributes(root);
    let mut handle = ptr::null_mut();
    let mut io_status = IoStatusBlock {
        status_or_pointer: 0,
        information: 0,
    };
    let status = unsafe {
        (api.nt_create_file)(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_ALL,
            disposition,
            options,
            ptr::null(),
            0,
        )
    };
    nt_result(api, status, context)?;
    if handle.is_null() {
        return Err(WindowsError::new(
            HelperFailureCode::NativeError,
            format!("{context}: NT returned a null handle"),
        ));
    }
    Ok(NtHandle(handle))
}

struct NtName {
    wide: Vec<u16>,
    unicode: UnicodeString,
}

impl NtName {
    fn new(value: &str) -> Result<Self, WindowsError> {
        let mut wide: Vec<u16> = OsStr::new(value).encode_wide().collect();
        let byte_length = wide
            .len()
            .checked_mul(2)
            .and_then(|length| u16::try_from(length).ok())
            .ok_or_else(|| {
                WindowsError::new(
                    HelperFailureCode::UnsafePath,
                    "NT object name exceeds UNICODE_STRING",
                )
            })?;
        let unicode = UnicodeString {
            length: byte_length,
            maximum_length: byte_length,
            buffer: wide.as_mut_ptr(),
        };
        Ok(Self { wide, unicode })
    }

    fn attributes(&mut self, root: HANDLE) -> ObjectAttributes {
        debug_assert_eq!(self.unicode.buffer, self.wide.as_mut_ptr());
        ObjectAttributes {
            length: mem::size_of::<ObjectAttributes>() as u32,
            root_directory: root,
            object_name: &mut self.unicode,
            attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            security_descriptor: ptr::null_mut(),
            security_quality_of_service: ptr::null_mut(),
        }
    }
}

fn nt_result(api: &NtdllApi, status: NtStatus, context: &str) -> Result<(), WindowsError> {
    if status >= 0 {
        Ok(())
    } else {
        Err(WindowsError::from_status(api, status, context))
    }
}

fn query_information<T>(handle: HANDLE, class: i32, context: &str) -> Result<T, WindowsError> {
    let mut value = MaybeUninit::<T>::zeroed();
    let result = unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            value.as_mut_ptr().cast(),
            mem::size_of::<T>() as u32,
        )
    };
    if result == 0 {
        Err(WindowsError::last_win32(context))
    } else {
        Ok(unsafe { value.assume_init() })
    }
}

fn identity_checked(handle: HANDLE, directory: bool) -> Result<PlatformIdentity, WindowsError> {
    let tag: FILE_ATTRIBUTE_TAG_INFO =
        query_information(handle, FileAttributeTagInfo, "query reparse attributes")?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            format!("reparse point is forbidden (tag 0x{:08X})", tag.ReparseTag),
        ));
    }
    let is_directory = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != directory {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            if directory {
                "descendant component is not a directory"
            } else {
                "lifecycle entry is not a regular file"
            },
        ));
    }
    let file_id: FILE_ID_INFO = query_information(handle, FileIdInfo, "query 128-bit file ID")?;
    Ok(PlatformIdentity::Windows {
        volume_serial: file_id.VolumeSerialNumber.to_string(),
        file_id128: file_id
            .FileId
            .Identifier
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        file_attributes: tag.FileAttributes,
        reparse_tag: None,
    })
}

fn stable_snapshot(handle: HANDLE, directory: bool) -> Result<StableSnapshot, WindowsError> {
    let identity = identity_checked(handle, directory)?;
    let basic: FILE_BASIC_INFO =
        query_information(handle, FileBasicInfo, "query stable basic information")?;
    let standard: FILE_STANDARD_INFO =
        query_information(handle, FileStandardInfo, "query stable file size")?;
    Ok(StableSnapshot {
        identity,
        last_write_time: basic.LastWriteTime,
        change_time: basic.ChangeTime,
        end_of_file: standard.EndOfFile,
    })
}

fn normalize_windows_relative(input: &str) -> Result<String, WindowsError> {
    let normalized = normalize_relative_path(input).map_err(|error| {
        let failure = error.failure("windows");
        WindowsError::new(failure.code, failure.message)
    })?;
    for component in normalized.split('/') {
        encode_component(component)?;
    }
    Ok(normalized)
}

fn encode_component(component: &str) -> Result<Vec<u16>, WindowsError> {
    if component.is_empty()
        || component.contains(['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'])
        || component.ends_with(['.', ' '])
    {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            "relative path contains an unsafe Windows component",
        ));
    }
    let encoded: Vec<u16> = OsStr::new(component).encode_wide().collect();
    if encoded.is_empty() || encoded.len() > 255 {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            "relative path component exceeds the Windows filename limit",
        ));
    }
    Ok(encoded)
}

fn absolute_nt_path(path: &Path) -> Result<String, WindowsError> {
    if !path.is_absolute() {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            "project root must be an absolute Windows path",
        ));
    }
    let raw = path.to_str().ok_or_else(|| {
        WindowsError::new(
            HelperFailureCode::UnsafePath,
            "project root is not valid Unicode",
        )
    })?;
    if raw.contains('\0') {
        return Err(WindowsError::new(
            HelperFailureCode::UnsafePath,
            "project root contains NUL",
        ));
    }
    let normalized = raw.replace('/', "\\");
    if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
        Ok(format!(r"\??\UNC\{rest}"))
    } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
        Ok(format!(r"\??\{rest}"))
    } else if let Some(rest) = normalized.strip_prefix(r"\\") {
        Ok(format!(r"\??\UNC\{rest}"))
    } else {
        Ok(format!(r"\??\{normalized}"))
    }
}

fn private_leaf(kind: &str, leaf: &str, nonce: &str) -> Result<String, WindowsError> {
    let value = format!(".{leaf}.maestro-{kind}.{nonce}");
    encode_component(&value)?;
    Ok(value)
}

fn quarantine_leaf(
    leaf: &str,
    request_id: &str,
    owner_generation: &str,
) -> Result<String, WindowsError> {
    let value = format!(".{leaf}.maestro-quarantine.{request_id}.{owner_generation}");
    encode_component(&value)?;
    Ok(value)
}

fn sibling_relative_path(normalized: &str, leaf: &str) -> String {
    match normalized.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{leaf}"),
        None => leaf.to_owned(),
    }
}

fn same_generation(left: &LifecycleGeneration, right: &LifecycleGeneration) -> bool {
    left.schema_version == right.schema_version
        && left.platform == right.platform
        && left.root == right.root
        && left.parent_chain == right.parent_chain
        && left.entry == right.entry
        && left.sha256 == right.sha256
}

fn align_up(value: usize, alignment: usize) -> usize {
    (value + alignment - 1) & !(alignment - 1)
}

fn io_error(error: std::io::Error, context: &str) -> WindowsError {
    error.raw_os_error().map_or_else(
        || {
            WindowsError::new(
                HelperFailureCode::NativeError,
                format!("{context}: {error}"),
            )
        },
        |code| WindowsError::from_win32(code as u32, context),
    )
}
