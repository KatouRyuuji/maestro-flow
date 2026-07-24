#![cfg(unix)]

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;

use crate::generation::{normalize_relative_path, sha256};
use crate::protocol::{
    BoundLock, BoundQuarantine, BoundRead, HelperFailure, HelperFailureCode, HelperRequest,
    LifecycleGeneration, LifecyclePlatform, PlatformIdentity, QuarantineDecision,
    RecoverQuarantineResult, ReleaseLockResult, GENERATION_SCHEMA, HELPER_PROTOCOL,
};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(test)]
static AMBIENT_ROOT_OPENS: AtomicUsize = AtomicUsize::new(0);
static PRIVATE_NAME_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContainmentCapability {
    Auto,
    OpenAt,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Resolver {
    #[cfg(target_os = "linux")]
    OpenAt2,
    OpenAt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PosixError {
    pub code: HelperFailureCode,
    pub native_status: Option<String>,
    pub message: String,
}

impl PosixError {
    fn new(code: HelperFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            native_status: None,
            message: message.into(),
        }
    }

    fn from_errno(errno: i32, context: &str) -> Self {
        let code = match errno {
            libc::ENOENT => HelperFailureCode::Missing,
            libc::EEXIST | libc::EBUSY => HelperFailureCode::Busy,
            libc::ELOOP | libc::EXDEV | libc::ENOTDIR | libc::EAGAIN => {
                HelperFailureCode::UnsafePath
            }
            _ => HelperFailureCode::NativeError,
        };
        Self {
            code,
            native_status: Some(format!("errno:{errno}")),
            message: format!("{context}: {}", std::io::Error::from_raw_os_error(errno)),
        }
    }

    fn last(context: &str) -> Self {
        let errno = std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO);
        Self::from_errno(errno, context)
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::new(HelperFailureCode::Unsupported, message)
    }

    fn replaced(message: impl Into<String>) -> Self {
        Self::new(HelperFailureCode::Replaced, message)
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

struct ResolvedParent {
    _directories: Vec<OwnedFd>,
    parent_fd: RawFd,
    parent_chain: Vec<PlatformIdentity>,
    leaf: CString,
    normalized: String,
}

struct MutationGuard {
    fd: RawFd,
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.fd, libc::LOCK_UN);
        }
    }
}

#[derive(Debug)]
pub struct PosixBackend {
    root: OwnedFd,
    root_identity: PlatformIdentity,
    root_dev: u64,
    resolver: Resolver,
    safe_rename: bool,
}

impl PosixBackend {
    pub fn open(project_root: &Path) -> Result<Self, PosixError> {
        Self::open_with_capability(project_root, ContainmentCapability::Auto)
    }

    pub fn open_with_capability(
        project_root: &Path,
        capability: ContainmentCapability,
    ) -> Result<Self, PosixError> {
        if capability == ContainmentCapability::Unavailable {
            return Err(PosixError::unsupported(
                "safe dirfd-relative containment is unavailable",
            ));
        }
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err(PosixError::unsupported(
                "the POSIX backend supports Linux and macOS only",
            ));
        }

        let root_path = cstring_os(project_root.as_os_str(), "project root")?;
        #[cfg(test)]
        AMBIENT_ROOT_OPENS.fetch_add(1, Ordering::SeqCst);
        let raw = unsafe {
            libc::open(
                root_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if raw < 0 {
            return Err(PosixError::last("open project root"));
        }
        let root = unsafe { OwnedFd::from_raw_fd(raw) };
        let root_stat = fstat(root.as_raw_fd(), "fstat project root")?;
        if (root_stat.st_mode & libc::S_IFMT) != libc::S_IFDIR {
            return Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "project root is not a directory",
            ));
        }

        let resolver = match capability {
            ContainmentCapability::OpenAt => Resolver::OpenAt,
            ContainmentCapability::Auto => detect_resolver(root.as_raw_fd())?,
            ContainmentCapability::Unavailable => unreachable!(),
        };
        Ok(Self {
            root,
            root_identity: identity(&root_stat),
            root_dev: root_stat.st_dev as u64,
            resolver,
            safe_rename: detect_safe_rename(),
        })
    }

    pub fn read(&self, relative_path: &str) -> Result<BoundRead, PosixError> {
        let parent = self.resolve_parent(relative_path)?;
        let (bytes, generation) = self.read_generation(&parent, None)?;
        Ok(BoundRead {
            bytes_base64: BASE64_STANDARD.encode(bytes),
            generation,
        })
    }

    pub fn replace(
        &self,
        relative_path: &str,
        bytes: &[u8],
        expected: Option<&LifecycleGeneration>,
        owner_generation: &str,
    ) -> Result<LifecycleGeneration, PosixError> {
        self.require_safe_rename()?;
        let _guard = self.mutation_guard()?;
        let parent = self.resolve_parent(relative_path)?;
        if let Some(expected) = expected {
            self.assert_generation(&parent, expected)?;
        } else if self.stat_leaf(&parent).is_ok() {
            return Err(PosixError::new(
                HelperFailureCode::Busy,
                "replace target already exists",
            ));
        }

        let temporary = private_leaf("replace", relative_path, owner_generation)?;
        let temporary_fd = self.create_exclusive(parent.parent_fd, &temporary)?;
        {
            let mut file = File::from(temporary_fd);
            if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                let _ = unlink(parent.parent_fd, &temporary);
                return Err(io_error(error, "write replacement bytes"));
            }
        }

        let rename_result = if expected.is_some() {
            self.exchange(parent.parent_fd, &temporary, &parent.leaf)
        } else {
            self.rename_noreplace(parent.parent_fd, &temporary, parent.parent_fd, &parent.leaf)
        };
        if let Err(error) = rename_result {
            let _ = unlink(parent.parent_fd, &temporary);
            return Err(error);
        }

        if let Some(expected) = expected {
            let displaced = self.read_generation_named(&parent, &temporary, None);
            match displaced {
                Ok((_, generation)) if same_generation(&generation, expected) => {
                    unlink(parent.parent_fd, &temporary)?;
                }
                _ => {
                    let rollback = self.exchange(parent.parent_fd, &temporary, &parent.leaf);
                    if rollback.is_err() {
                        return Err(PosixError::replaced(
                            "replacement race detected and rollback failed",
                        ));
                    }
                    return Err(PosixError::replaced(
                        "replacement generation changed before atomic exchange",
                    ));
                }
            }
        }

        let (_, mut generation) = self.read_generation(&parent, None)?;
        generation.owner_generation = Some(owner_generation.to_owned());
        Ok(generation)
    }

    pub fn acquire_lock(
        &self,
        relative_path: &str,
        owner: &crate::protocol::LockOwner,
    ) -> Result<BoundLock, PosixError> {
        let _guard = self.mutation_guard()?;
        let parent = self.resolve_parent(relative_path)?;
        let fd = self.create_exclusive(parent.parent_fd, &parent.leaf)?;
        {
            let mut file = File::from(fd);
            let bytes = serde_json::to_vec(owner).map_err(|_| {
                PosixError::new(HelperFailureCode::NativeError, "encode lock owner")
            })?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| io_error(error, "write lock owner"))?;
        }
        let (_, mut generation) = self.read_generation(&parent, None)?;
        generation.owner_generation = Some(owner.owner_generation.clone());
        Ok(BoundLock {
            lock_relative_path: parent.normalized,
            token: owner.token.clone(),
            owner_generation: owner.owner_generation.clone(),
            generation,
        })
    }

    pub fn quarantine(
        &self,
        relative_path: &str,
        expected_sha256: &str,
        request_id: &str,
        owner_generation: &str,
    ) -> Result<BoundQuarantine, PosixError> {
        self.require_safe_rename()?;
        let _guard = self.mutation_guard()?;
        let parent = self.resolve_parent(relative_path)?;
        let (_, observed) = self.read_generation(&parent, Some(expected_sha256))?;
        let quarantine_leaf = private_leaf("quarantine", relative_path, request_id)?;
        self.rename_noreplace(
            parent.parent_fd,
            &parent.leaf,
            parent.parent_fd,
            &quarantine_leaf,
        )?;

        let moved = self.read_generation_named(&parent, &quarantine_leaf, Some(expected_sha256));
        if !matches!(&moved, Ok((_, generation)) if same_generation(generation, &observed)) {
            let _ = self.rename_noreplace(
                parent.parent_fd,
                &quarantine_leaf,
                parent.parent_fd,
                &parent.leaf,
            );
            return Err(PosixError::replaced(
                "source generation changed while entering quarantine",
            ));
        }

        let quarantine_relative_path = sibling_relative_path(&parent.normalized, &quarantine_leaf)?;
        let (_, mut generation) = moved?;
        generation.owner_generation = Some(owner_generation.to_owned());
        Ok(BoundQuarantine {
            original_relative_path: parent.normalized,
            quarantine_relative_path,
            request_id: request_id.to_owned(),
            owner_generation: owner_generation.to_owned(),
            expected_sha256: expected_sha256.to_owned(),
            generation,
        })
    }

    pub fn recover_quarantine(
        &self,
        quarantine: &BoundQuarantine,
        decision: QuarantineDecision,
    ) -> Result<RecoverQuarantineResult, PosixError> {
        self.require_safe_rename()?;
        if quarantine.generation.sha256 != quarantine.expected_sha256
            || quarantine.generation.owner_generation.as_deref()
                != Some(quarantine.owner_generation.as_str())
        {
            return Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "quarantine binding does not match its generation",
            ));
        }
        if parent_portion(&quarantine.original_relative_path)
            != parent_portion(&quarantine.quarantine_relative_path)
        {
            return Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "quarantine and restore names must share one retained parent dirfd",
            ));
        }
        let _guard = self.mutation_guard()?;
        let source = self.resolve_parent(&quarantine.quarantine_relative_path)?;
        let claimed = match self.claim_exact(&source, &quarantine.generation, "recover") {
            Ok(claimed) => claimed,
            Err(error) if error.code == HelperFailureCode::Missing => {
                return Ok(RecoverQuarantineResult::Replaced)
            }
            Err(error) if error.code == HelperFailureCode::Replaced => {
                return Ok(RecoverQuarantineResult::Replaced)
            }
            Err(error) => return Err(error),
        };

        match decision {
            QuarantineDecision::Commit => {
                unlink(source.parent_fd, &claimed)?;
                Ok(RecoverQuarantineResult::Committed)
            }
            QuarantineDecision::Restore => {
                let destination = self.resolve_parent(&quarantine.original_relative_path)?;
                if self.stat_leaf(&destination).is_ok() {
                    let _ = self.rename_noreplace(
                        source.parent_fd,
                        &claimed,
                        source.parent_fd,
                        &source.leaf,
                    );
                    return Ok(RecoverQuarantineResult::Replaced);
                }
                if let Err(error) = self.rename_noreplace(
                    source.parent_fd,
                    &claimed,
                    destination.parent_fd,
                    &destination.leaf,
                ) {
                    let _ = self.rename_noreplace(
                        source.parent_fd,
                        &claimed,
                        source.parent_fd,
                        &source.leaf,
                    );
                    if matches!(
                        error.code,
                        HelperFailureCode::Busy | HelperFailureCode::Replaced
                    ) {
                        return Ok(RecoverQuarantineResult::Replaced);
                    }
                    return Err(error);
                }
                let restored =
                    self.read_generation(&destination, Some(&quarantine.expected_sha256));
                if !matches!(restored, Ok((_, ref generation)) if same_generation(generation, &quarantine.generation))
                {
                    return Err(PosixError::replaced(
                        "restored name does not contain the quarantined generation",
                    ));
                }
                Ok(RecoverQuarantineResult::Restored)
            }
        }
    }

    pub fn release_lock(&self, lock: &BoundLock) -> Result<ReleaseLockResult, PosixError> {
        self.require_safe_rename()?;
        let _guard = self.mutation_guard()?;
        let parent = self.resolve_parent(&lock.lock_relative_path)?;
        let (bytes, observed) = match self.read_generation(&parent, Some(&lock.generation.sha256)) {
            Ok(observed) => observed,
            Err(error) if error.code == HelperFailureCode::HashMismatch => {
                return Ok(ReleaseLockResult::Replaced)
            }
            Err(error) if error.code == HelperFailureCode::Missing => {
                return Ok(ReleaseLockResult::Missing)
            }
            Err(error) => return Err(error),
        };
        let Ok(owner) = serde_json::from_slice::<crate::protocol::LockOwner>(&bytes) else {
            return Ok(ReleaseLockResult::Replaced);
        };
        if !same_generation(&observed, &lock.generation)
            || owner.token != lock.token
            || owner.owner_generation != lock.owner_generation
            || lock.generation.owner_generation.as_deref() != Some(lock.owner_generation.as_str())
        {
            return Ok(ReleaseLockResult::Replaced);
        }
        match self.claim_exact(&parent, &lock.generation, "release") {
            Ok(claimed) => {
                unlink(parent.parent_fd, &claimed)?;
                Ok(ReleaseLockResult::Released)
            }
            Err(error) if error.code == HelperFailureCode::Missing => {
                Ok(ReleaseLockResult::Missing)
            }
            Err(error) if error.code == HelperFailureCode::Replaced => {
                Ok(ReleaseLockResult::Replaced)
            }
            Err(error) => Err(error),
        }
    }

    fn claim_exact(
        &self,
        parent: &ResolvedParent,
        expected: &LifecycleGeneration,
        purpose: &str,
    ) -> Result<CString, PosixError> {
        let claimed = unique_private_leaf(purpose, &parent.normalized)?;
        self.rename_noreplace(parent.parent_fd, &parent.leaf, parent.parent_fd, &claimed)?;
        let observed = self.read_generation_named(parent, &claimed, Some(&expected.sha256));
        if matches!(&observed, Ok((_, generation)) if same_generation(generation, expected)) {
            return Ok(claimed);
        }
        let restore =
            self.rename_noreplace(parent.parent_fd, &claimed, parent.parent_fd, &parent.leaf);
        if restore.is_err() {
            return Err(PosixError::replaced(
                "claimed replacement generation could not be restored to its name",
            ));
        }
        match observed {
            Err(error) if error.code == HelperFailureCode::Missing => Err(error),
            _ => Err(PosixError::replaced(
                "entry changed before exact-generation mutation",
            )),
        }
    }

    fn resolve_parent(&self, relative_path: &str) -> Result<ResolvedParent, PosixError> {
        let normalized = normalize_relative_path(relative_path)
            .map_err(|error| PosixError::from(error.failure("posix")))?;
        let parts: Vec<&str> = normalized.split('/').collect();
        let leaf = CString::new(parts[parts.len() - 1]).map_err(|_| {
            PosixError::new(HelperFailureCode::UnsafePath, "relative path contains NUL")
        })?;
        let mut directories = Vec::with_capacity(parts.len().saturating_sub(1));
        let mut parent_chain = Vec::with_capacity(parts.len().saturating_sub(1));
        let mut current = self.root.as_raw_fd();

        for component in &parts[..parts.len() - 1] {
            let component = CString::new(*component).map_err(|_| {
                PosixError::new(HelperFailureCode::UnsafePath, "relative path contains NUL")
            })?;
            let directory = self.secure_open(
                current,
                &component,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )?;
            let stat = fstat(directory.as_raw_fd(), "fstat descendant directory")?;
            self.require_same_mount(&stat)?;
            if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR {
                return Err(PosixError::new(
                    HelperFailureCode::UnsafePath,
                    "descendant component is not a directory",
                ));
            }
            parent_chain.push(identity(&stat));
            current = directory.as_raw_fd();
            directories.push(directory);
        }

        Ok(ResolvedParent {
            _directories: directories,
            parent_fd: current,
            parent_chain,
            leaf,
            normalized,
        })
    }

    fn secure_open(
        &self,
        parent_fd: RawFd,
        name: &CStr,
        flags: i32,
    ) -> Result<OwnedFd, PosixError> {
        #[cfg(target_os = "linux")]
        if self.resolver == Resolver::OpenAt2 {
            return openat2(parent_fd, name, flags);
        }
        openat_nofollow(parent_fd, name, flags)
    }

    fn stat_leaf(&self, parent: &ResolvedParent) -> Result<libc::stat, PosixError> {
        let stat = fstatat(parent.parent_fd, &parent.leaf, "fstatat descendant entry")?;
        self.require_same_mount(&stat)?;
        if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
            return Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "symbolic links and magic links are forbidden",
            ));
        }
        Ok(stat)
    }

    fn read_generation(
        &self,
        parent: &ResolvedParent,
        expected_hash: Option<&str>,
    ) -> Result<(Vec<u8>, LifecycleGeneration), PosixError> {
        self.read_generation_named(parent, &parent.leaf, expected_hash)
    }

    fn read_generation_named(
        &self,
        parent: &ResolvedParent,
        name: &CStr,
        expected_hash: Option<&str>,
    ) -> Result<(Vec<u8>, LifecycleGeneration), PosixError> {
        let path_stat = fstatat(parent.parent_fd, name, "fstatat descendant entry")?;
        self.require_same_mount(&path_stat)?;
        if (path_stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
            return Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "lifecycle entry is not a regular file",
            ));
        }
        let fd = self.secure_open(parent.parent_fd, name, libc::O_RDONLY | libc::O_CLOEXEC)?;
        let opened_stat = fstat(fd.as_raw_fd(), "fstat opened lifecycle entry")?;
        if !same_identity_stat(&path_stat, &opened_stat) {
            return Err(PosixError::replaced(
                "entry generation changed between fstatat and openat",
            ));
        }

        let mut file = File::from(fd);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| io_error(error, "read lifecycle entry"))?;
        let after_stat = fstat(file.as_raw_fd(), "fstat lifecycle entry after read")?;
        if !same_identity_stat(&opened_stat, &after_stat)
            || opened_stat.st_size != after_stat.st_size
            || opened_stat.st_mtime != after_stat.st_mtime
            || opened_stat.st_ctime != after_stat.st_ctime
        {
            return Err(PosixError::replaced(
                "entry generation changed while reading",
            ));
        }
        let after_path = fstatat(parent.parent_fd, name, "fstatat lifecycle entry after read")?;
        if !same_identity_stat(&after_stat, &after_path) {
            return Err(PosixError::replaced(
                "entry name was replaced while reading",
            ));
        }

        let digest = sha256(&bytes);
        if expected_hash.is_some_and(|expected| expected != digest) {
            return Err(PosixError::new(
                HelperFailureCode::HashMismatch,
                "entry bytes do not match the expected SHA-256",
            ));
        }
        Ok((
            bytes,
            LifecycleGeneration {
                schema_version: GENERATION_SCHEMA.to_owned(),
                platform: LifecyclePlatform::Posix,
                root: self.root_identity.clone(),
                parent_chain: parent.parent_chain.clone(),
                entry: identity(&after_stat),
                sha256: digest,
                owner_generation: None,
            },
        ))
    }

    fn assert_generation(
        &self,
        parent: &ResolvedParent,
        expected: &LifecycleGeneration,
    ) -> Result<(), PosixError> {
        let (_, observed) = match self.read_generation(parent, Some(&expected.sha256)) {
            Ok(observed) => observed,
            Err(error) if error.code == HelperFailureCode::HashMismatch => {
                return Err(PosixError::replaced(
                    "entry bytes do not match the exact expected generation",
                ))
            }
            Err(error) => return Err(error),
        };
        if same_generation(&observed, expected) {
            Ok(())
        } else {
            Err(PosixError::replaced(
                "entry does not match the exact expected generation",
            ))
        }
    }

    fn create_exclusive(&self, parent_fd: RawFd, name: &CStr) -> Result<OwnedFd, PosixError> {
        let raw = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if raw < 0 {
            Err(PosixError::last("openat exclusive lifecycle entry"))
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(raw) })
        }
    }

    fn mutation_guard(&self) -> Result<MutationGuard, PosixError> {
        let result = unsafe { libc::flock(self.root.as_raw_fd(), libc::LOCK_EX) };
        if result == 0 {
            return Ok(MutationGuard {
                fd: self.root.as_raw_fd(),
            });
        }
        let errno = last_errno();
        if matches!(errno, libc::ENOSYS | libc::ENOTSUP) {
            Err(PosixError::unsupported(
                "coordinator flock semantics are unavailable",
            ))
        } else {
            Err(PosixError::from_errno(errno, "acquire coordinator flock"))
        }
    }

    fn require_same_mount(&self, stat: &libc::stat) -> Result<(), PosixError> {
        if stat.st_dev as u64 == self.root_dev {
            Ok(())
        } else {
            Err(PosixError::new(
                HelperFailureCode::UnsafePath,
                "cross-mount traversal is forbidden",
            ))
        }
    }

    fn require_safe_rename(&self) -> Result<(), PosixError> {
        if self.safe_rename {
            Ok(())
        } else {
            Err(PosixError::unsupported(
                "safe dirfd-relative rename semantics are unavailable",
            ))
        }
    }

    fn rename_noreplace(
        &self,
        from_fd: RawFd,
        from: &CStr,
        to_fd: RawFd,
        to: &CStr,
    ) -> Result<(), PosixError> {
        #[cfg(target_os = "linux")]
        {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    from_fd,
                    from.as_ptr(),
                    to_fd,
                    to.as_ptr(),
                    1_u32,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let errno = last_errno();
            if errno != libc::ENOSYS {
                return Err(PosixError::from_errno(errno, "renameat2 lifecycle entry"));
            }
            return Err(PosixError::unsupported(
                "renameat2 RENAME_NOREPLACE is unavailable",
            ));
        }
        #[cfg(target_os = "macos")]
        {
            const RENAME_SWAP: u32 = 0x0000_0002;
            const RENAME_EXCL: u32 = 0x0000_0004;
            let _ = RENAME_SWAP;
            let result =
                unsafe { renameatx_np(from_fd, from.as_ptr(), to_fd, to.as_ptr(), RENAME_EXCL) };
            if result == 0 {
                return Ok(());
            }
            let errno = last_errno();
            if errno != libc::ENOSYS && errno != libc::ENOTSUP {
                return Err(PosixError::from_errno(
                    errno,
                    "renameatx_np lifecycle entry",
                ));
            }
            match fstatat(to_fd, to, "fstatat rename destination") {
                Ok(_) => {
                    return Err(PosixError::new(
                        HelperFailureCode::Busy,
                        "rename destination already exists",
                    ))
                }
                Err(error) if error.code == HelperFailureCode::Missing => {}
                Err(error) => return Err(error),
            }
            let fallback = unsafe { libc::renameat(from_fd, from.as_ptr(), to_fd, to.as_ptr()) };
            if fallback == 0 {
                Ok(())
            } else {
                Err(PosixError::last("renameat lifecycle entry"))
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (from_fd, from, to_fd, to);
            Err(PosixError::unsupported(
                "safe POSIX rename semantics are unavailable",
            ))
        }
    }

    fn exchange(&self, left_fd: RawFd, left: &CStr, right: &CStr) -> Result<(), PosixError> {
        #[cfg(target_os = "linux")]
        {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    left_fd,
                    left.as_ptr(),
                    left_fd,
                    right.as_ptr(),
                    2_u32,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let errno = last_errno();
            if errno == libc::ENOSYS {
                Err(PosixError::unsupported(
                    "renameat2 RENAME_EXCHANGE is unavailable",
                ))
            } else {
                Err(PosixError::from_errno(
                    errno,
                    "exchange lifecycle generation",
                ))
            }
        }
        #[cfg(target_os = "macos")]
        {
            const RENAME_SWAP: u32 = 0x0000_0002;
            let result = unsafe {
                renameatx_np(left_fd, left.as_ptr(), left_fd, right.as_ptr(), RENAME_SWAP)
            };
            if result == 0 {
                Ok(())
            } else {
                let errno = last_errno();
                if matches!(errno, libc::ENOSYS | libc::ENOTSUP) {
                    Err(PosixError::unsupported(
                        "renameatx_np RENAME_SWAP is unavailable",
                    ))
                } else {
                    Err(PosixError::from_errno(
                        errno,
                        "exchange lifecycle generation",
                    ))
                }
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (left_fd, left, right);
            Err(PosixError::unsupported(
                "safe POSIX exchange semantics are unavailable",
            ))
        }
    }
}

pub fn dispatch(request: HelperRequest) -> Result<Value, HelperFailure> {
    let request_id = request.request_id().to_owned();
    let result = dispatch_inner(request);
    result.map_err(|error| error.failure(request_id))
}

fn dispatch_inner(request: HelperRequest) -> Result<Value, PosixError> {
    match request {
        HelperRequest::Read(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.read(&request.relative_path)?)
        }
        HelperRequest::Replace(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            let bytes = BASE64_STANDARD.decode(request.bytes_base64).map_err(|_| {
                PosixError::new(HelperFailureCode::UnsafePath, "bytesBase64 is malformed")
            })?;
            serialize_result(backend.replace(
                &request.relative_path,
                &bytes,
                request.expected.as_ref(),
                &request.owner_generation,
            )?)
        }
        HelperRequest::AcquireLock(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.acquire_lock(&request.lock_relative_path, &request.owner)?)
        }
        HelperRequest::Quarantine(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.quarantine(
                &request.relative_path,
                &request.expected_sha256,
                &request.request_id_to_restore,
                &request.owner_generation,
            )?)
        }
        HelperRequest::RecoverQuarantine(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.recover_quarantine(&request.quarantine, request.decision)?)
        }
        HelperRequest::ReleaseLock(request) => {
            let backend = PosixBackend::open(Path::new(&request.project_root))?;
            serialize_result(backend.release_lock(&request.lock)?)
        }
    }
}

fn serialize_result<T: Serialize>(value: T) -> Result<Value, PosixError> {
    serde_json::to_value(value)
        .map_err(|_| PosixError::new(HelperFailureCode::NativeError, "encode helper result"))
}

fn same_generation(left: &LifecycleGeneration, right: &LifecycleGeneration) -> bool {
    left.schema_version == right.schema_version
        && left.platform == right.platform
        && left.root == right.root
        && left.parent_chain == right.parent_chain
        && left.entry == right.entry
        && left.sha256 == right.sha256
}

fn sibling_relative_path(normalized: &str, leaf: &CStr) -> Result<String, PosixError> {
    let leaf = leaf.to_str().map_err(|_| {
        PosixError::new(
            HelperFailureCode::NativeError,
            "generated quarantine name is not UTF-8",
        )
    })?;
    Ok(match normalized.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{leaf}"),
        None => leaf.to_owned(),
    })
}

fn parent_portion(normalized: &str) -> &str {
    normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

fn private_leaf(kind: &str, path: &str, nonce: &str) -> Result<CString, PosixError> {
    let digest = sha256(format!("{kind}\0{path}\0{nonce}").as_bytes());
    CString::new(format!(".lifecycle-{kind}-{}", &digest[7..]))
        .map_err(|_| PosixError::new(HelperFailureCode::NativeError, "invalid private name"))
}

fn unique_private_leaf(kind: &str, path: &str) -> Result<CString, PosixError> {
    let sequence = PRIVATE_NAME_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    private_leaf(
        kind,
        path,
        &format!("{}:{timestamp}:{sequence}", std::process::id()),
    )
}

fn cstring_os(value: &OsStr, label: &str) -> Result<CString, PosixError> {
    CString::new(value.as_bytes()).map_err(|_| {
        PosixError::new(
            HelperFailureCode::UnsafePath,
            format!("{label} contains NUL"),
        )
    })
}

fn identity(stat: &libc::stat) -> PlatformIdentity {
    PlatformIdentity::Posix {
        dev: (stat.st_dev as u64).to_string(),
        ino: (stat.st_ino as u64).to_string(),
        mode: stat.st_mode as u32,
    }
}

fn same_identity_stat(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_mode == right.st_mode
}

fn fstat(fd: RawFd, context: &str) -> Result<libc::stat, PosixError> {
    let mut stat = MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        Err(PosixError::last(context))
    } else {
        Ok(unsafe { stat.assume_init() })
    }
}

fn fstatat(fd: RawFd, name: &CStr, context: &str) -> Result<libc::stat, PosixError> {
    let mut stat = MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            fd,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        Err(PosixError::last(context))
    } else {
        Ok(unsafe { stat.assume_init() })
    }
}

fn unlink(fd: RawFd, name: &CStr) -> Result<(), PosixError> {
    if unsafe { libc::unlinkat(fd, name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(PosixError::last("unlinkat exact lifecycle generation"))
    }
}

fn openat_nofollow(fd: RawFd, name: &CStr, flags: i32) -> Result<OwnedFd, PosixError> {
    let raw = unsafe { libc::openat(fd, name.as_ptr(), flags | libc::O_NOFOLLOW) };
    if raw < 0 {
        Err(PosixError::last("openat contained descendant"))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(raw) })
    }
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[cfg(target_os = "linux")]
const RESOLVE_NO_XDEV: u64 = 0x01;
#[cfg(target_os = "linux")]
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
#[cfg(target_os = "linux")]
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
#[cfg(target_os = "linux")]
const RESOLVE_BENEATH: u64 = 0x08;

#[cfg(target_os = "linux")]
fn openat2(fd: RawFd, name: &CStr, flags: i32) -> Result<OwnedFd, PosixError> {
    let how = OpenHow {
        flags: (flags | libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV,
    };
    let raw = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            fd,
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if raw < 0 {
        Err(PosixError::last("openat2 contained descendant"))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(raw as RawFd) })
    }
}

fn detect_resolver(root_fd: RawFd) -> Result<Resolver, PosixError> {
    #[cfg(target_os = "linux")]
    {
        let dot = CStr::from_bytes_with_nul(b".\0").expect("static C string");
        match openat2(
            root_fd,
            dot,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        ) {
            Ok(_) => Ok(Resolver::OpenAt2),
            Err(error)
                if matches!(
                    error.native_status.as_deref(),
                    Some(status)
                        if status == format!("errno:{}", libc::ENOSYS)
                            || status == format!("errno:{}", libc::EINVAL)
                ) =>
            {
                Ok(Resolver::OpenAt)
            }
            Err(error) => Err(error),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = root_fd;
        Ok(Resolver::OpenAt)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = root_fd;
        Err(PosixError::unsupported(
            "safe dirfd-relative containment is unavailable",
        ))
    }
}

fn detect_safe_rename() -> bool {
    #[cfg(target_os = "linux")]
    {
        let empty = CStr::from_bytes_with_nul(b"\0").expect("static C string");
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                -1_i32,
                empty.as_ptr(),
                -1_i32,
                empty.as_ptr(),
                1_u32,
            )
        };
        result == 0 || last_errno() != libc::ENOSYS
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

fn io_error(error: std::io::Error, context: &str) -> PosixError {
    error
        .raw_os_error()
        .map(|errno| PosixError::from_errno(errno, context))
        .unwrap_or_else(|| PosixError::new(HelperFailureCode::NativeError, context))
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

impl From<HelperFailure> for PosixError {
    fn from(failure: HelperFailure) -> Self {
        Self {
            code: failure.code,
            native_status: failure.native_status,
            message: failure.message,
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn renameatx_np(
        from_fd: libc::c_int,
        from: *const libc::c_char,
        to_fd: libc::c_int,
        to: *const libc::c_char,
        flags: libc::c_uint,
    ) -> libc::c_int;
}

#[cfg(test)]
pub fn reset_test_ambient_root_opens() {
    AMBIENT_ROOT_OPENS.store(0, Ordering::SeqCst);
}

#[cfg(test)]
pub fn test_ambient_root_opens() -> usize {
    AMBIENT_ROOT_OPENS.load(Ordering::SeqCst)
}
