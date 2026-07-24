#[cfg(unix)]
#[path = "../src/generation.rs"]
mod generation;
#[cfg(unix)]
#[path = "../src/posix.rs"]
mod posix;
#[cfg(unix)]
#[path = "../src/protocol.rs"]
mod protocol;

#[cfg(unix)]
mod unix_tests {
    use std::fs::{self, File};
    use std::io::Write;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::generation::sha256;
    use super::posix::{
        reset_test_ambient_root_opens, test_ambient_root_opens, ContainmentCapability, PosixBackend,
    };
    use super::protocol::{
        HelperFailureCode, LockOwner, QuarantineDecision, RecoverQuarantineResult,
        ReleaseLockResult,
    };

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "maestro-lifecycle-posix-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(path.join("nested")).expect("create test root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("create fixture");
        file.write_all(bytes).expect("write fixture");
        file.sync_all().expect("sync fixture");
    }

    #[test]
    fn dirfd_containment() {
        let root = TestRoot::new("containment");
        write(&root.path().join("nested/file"), b"inside");
        let outside = root.path().with_extension("outside");
        write(&outside, b"outside");
        symlink(&outside, root.path().join("nested/link")).expect("create symlink");

        let backend = PosixBackend::open(root.path()).expect("open backend");
        let read = backend
            .read("nested/file")
            .expect("read relative descendant");
        assert_eq!(read.bytes_base64, "aW5zaWRl");

        let fallback =
            PosixBackend::open_with_capability(root.path(), ContainmentCapability::OpenAt)
                .expect("open safe per-component fallback");
        assert_eq!(
            fallback
                .read("nested/file")
                .expect("fallback relative read")
                .bytes_base64,
            "aW5zaWRl"
        );

        let symlink_error = backend.read("nested/link").expect_err("reject symlink");
        assert_eq!(symlink_error.code, HelperFailureCode::UnsafePath);
        let fallback_symlink = fallback
            .read("nested/link")
            .expect_err("fallback rejects symlink");
        assert_eq!(fallback_symlink.code, HelperFailureCode::UnsafePath);
        assert_eq!(fs::read(&outside).expect("outside bytes"), b"outside");

        #[cfg(target_os = "linux")]
        {
            let root_backend = PosixBackend::open(Path::new("/")).expect("open filesystem root");
            let cross_mount = root_backend
                .read("proc/version")
                .expect_err("reject procfs mount crossing");
            assert_eq!(cross_mount.code, HelperFailureCode::UnsafePath);

            symlink("/proc/self/fd/0", root.path().join("nested/magic"))
                .expect("create magic-link symlink");
            let magic = backend.read("nested/magic").expect_err("reject magic link");
            assert_eq!(magic.code, HelperFailureCode::UnsafePath);
        }

        let _ = fs::remove_file(outside);
    }

    #[test]
    fn unsupported_containment_fails_closed() {
        reset_test_ambient_root_opens();
        let missing =
            std::env::temp_dir().join(format!("maestro-posix-missing-{}", std::process::id()));
        let error =
            PosixBackend::open_with_capability(&missing, ContainmentCapability::Unavailable)
                .expect_err("unsupported semantics fail closed");
        assert_eq!(error.code, HelperFailureCode::Unsupported);
        assert_eq!(test_ambient_root_opens(), 0);
    }

    #[test]
    fn exact_generation_lifecycle() {
        let root = TestRoot::new("lifecycle");
        let path = root.path().join("nested/file");
        write(&path, b"generation-a");
        let backend = PosixBackend::open(root.path()).expect("open backend");
        let expected_hash = sha256(b"generation-a");

        let quarantine = backend
            .quarantine("nested/file", &expected_hash, "request-17", "owner-17")
            .expect("quarantine exact generation");
        assert!(!path.exists());
        assert!(root
            .path()
            .join(&quarantine.quarantine_relative_path)
            .exists());

        assert_eq!(
            backend
                .recover_quarantine(&quarantine, QuarantineDecision::Restore)
                .expect("restore exact generation"),
            RecoverQuarantineResult::Restored
        );
        assert_eq!(fs::read(&path).expect("restored bytes"), b"generation-a");

        let quarantine = backend
            .quarantine("nested/file", &expected_hash, "request-18", "owner-17")
            .expect("quarantine for commit");
        assert_eq!(
            backend
                .recover_quarantine(&quarantine, QuarantineDecision::Commit)
                .expect("commit exact generation"),
            RecoverQuarantineResult::Committed
        );
        assert!(!root
            .path()
            .join(&quarantine.quarantine_relative_path)
            .exists());

        let lock = backend
            .acquire_lock(
                "nested/lock",
                &LockOwner {
                    pid: std::process::id(),
                    token: "token-17".to_owned(),
                    owner_generation: "owner-17".to_owned(),
                },
            )
            .expect("acquire exact lock");
        assert_eq!(
            backend.release_lock(&lock).expect("release exact lock"),
            ReleaseLockResult::Released
        );
    }

    #[test]
    fn replacement_survives() {
        let root = TestRoot::new("replacement");
        let backend = PosixBackend::open(root.path()).expect("open backend");
        let lock = backend
            .acquire_lock(
                "nested/lock",
                &LockOwner {
                    pid: std::process::id(),
                    token: "original-token".to_owned(),
                    owner_generation: "owner-original".to_owned(),
                },
            )
            .expect("acquire original lock");
        let path = root.path().join("nested/lock");
        fs::remove_file(&path).expect("remove original generation");
        write(&path, b"replacement bytes");

        assert_eq!(
            backend
                .release_lock(&lock)
                .expect("detect stale generation"),
            ReleaseLockResult::Replaced
        );
        assert_eq!(
            fs::read(&path).expect("replacement remains"),
            b"replacement bytes"
        );
    }
}
