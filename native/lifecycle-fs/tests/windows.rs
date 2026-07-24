#![cfg(windows)]

#[path = "../src/generation.rs"]
mod generation;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/windows.rs"]
mod windows;

mod windows_tests {
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::generation::sha256;
    use super::protocol::{
        HelperFailureCode, LockOwner, QuarantineDecision, RecoverQuarantineResult,
        ReleaseLockResult,
    };
    use super::windows::test_support::{
        ambient_root_opens, clear_hook, reset_ambient_root_opens, set_hook,
    };
    use super::windows::{ContainmentCapability, TestEvent, WindowsBackend};

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "maestro-lifecycle-windows-{label}-{}-{nonce}",
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

    struct HookReset;

    impl Drop for HookReset {
        fn drop(&mut self) {
            clear_hook();
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("create fixture");
        file.write_all(bytes).expect("write fixture");
        file.sync_all().expect("sync fixture");
    }

    fn junction(link: &Path, target: &Path) {
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink");
        assert!(
            output.status.success(),
            "mklink failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn remove_junction(path: &Path) {
        fs::remove_dir(path).expect("remove junction without traversing it");
    }

    #[test]
    fn root_handle_relative() {
        let root = TestRoot::new("root-relative");
        let outside = TestRoot::new("root-relative-outside");
        write(&root.path().join("nested/file"), b"inside");
        write(&outside.path().join("nested/sentinel"), b"outside");
        let link = root.path().join("junction");
        junction(&link, &outside.path().join("nested"));

        let backend = WindowsBackend::open(root.path()).expect("open NT backend");
        let read = backend
            .read("nested/file")
            .expect("read handle-relative descendant");
        assert_eq!(read.bytes_base64, "aW5zaWRl");

        let created = backend
            .replace("nested/replaced", b"first", None, "owner-create")
            .expect("create handle-relative entry");
        let replaced = backend
            .replace(
                "nested/replaced",
                b"second",
                Some(&created),
                "owner-replace",
            )
            .expect("atomically replace expected generation");
        assert_eq!(replaced.sha256, sha256(b"second"));
        assert_eq!(
            fs::read(root.path().join("nested/replaced")).expect("replacement bytes"),
            b"second"
        );

        let error = backend
            .read("junction/sentinel")
            .expect_err("junction must fail closed");
        assert_eq!(error.code, HelperFailureCode::UnsafePath);
        assert_eq!(
            fs::read(outside.path().join("nested/sentinel")).expect("outside sentinel"),
            b"outside"
        );

        reset_ambient_root_opens();
        let missing = root.path().join("does-not-exist");
        let unsupported =
            WindowsBackend::open_with_capability(&missing, ContainmentCapability::Unavailable)
                .err()
                .expect("unsupported capability must fail before access");
        assert_eq!(unsupported.code, HelperFailureCode::Unsupported);
        assert_eq!(ambient_root_opens(), 0);

        drop(backend);
        remove_junction(&link);
    }

    #[test]
    fn ancestor_swap_regression() {
        let root = TestRoot::new("ancestor-swap");
        let outside = TestRoot::new("ancestor-swap-outside");
        write(&root.path().join("nested/file"), b"inside generation");
        write(&outside.path().join("nested/file"), b"outside sentinel");
        let nested = root.path().join("nested");
        let held = root.path().join("held-generation");
        let target = outside.path().join("nested");

        let backend = WindowsBackend::open(root.path()).expect("open NT backend");
        let nested_for_hook = nested.clone();
        let held_for_hook = held.clone();
        let target_for_hook = target.clone();
        let mut swapped = false;
        set_hook(move |event| {
            if event == TestEvent::ComponentOpened(0) && !swapped {
                fs::rename(&nested_for_hook, &held_for_hook).expect("move checked ancestor");
                junction(&nested_for_hook, &target_for_hook);
                swapped = true;
            }
        });
        let _reset = HookReset;

        let error = backend
            .read("nested/file")
            .expect_err("ancestor replacement must fail closed");
        assert_eq!(error.code, HelperFailureCode::UnsafePath);
        assert_eq!(
            fs::read(outside.path().join("nested/file")).expect("outside sentinel"),
            b"outside sentinel"
        );

        clear_hook();
        drop(backend);
        remove_junction(&nested);
        fs::rename(&held, &nested).expect("restore test directory");
    }

    #[test]
    fn exact_generation_release() {
        let root = TestRoot::new("exact-generation");
        let path = root.path().join("nested/file");
        write(&path, b"generation-a");
        let backend = WindowsBackend::open(root.path()).expect("open NT backend");
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
        assert!(!root.path().join("nested/lock").exists());

        let lock = backend
            .acquire_lock(
                "nested/replaced-lock",
                &LockOwner {
                    pid: std::process::id(),
                    token: "old-token".to_owned(),
                    owner_generation: "old-owner".to_owned(),
                },
            )
            .expect("acquire replaceable lock");
        let lock_path = root.path().join("nested/replaced-lock");
        let displaced = root.path().join("nested/displaced-lock");
        let lock_for_hook = lock_path.clone();
        let displaced_for_hook = displaced.clone();
        set_hook(move |event| {
            if event == TestEvent::BeforeMutation {
                fs::rename(&lock_for_hook, &displaced_for_hook)
                    .expect("move original lock generation");
                write(&lock_for_hook, b"new owner");
            }
        });
        let _reset = HookReset;
        assert_eq!(
            backend
                .release_lock(&lock)
                .expect("report replacement generation"),
            ReleaseLockResult::Replaced
        );
        assert_eq!(
            fs::read(&lock_path).expect("replacement survives"),
            b"new owner"
        );
        clear_hook();
        fs::remove_file(lock_path).expect("remove replacement fixture");
        fs::remove_file(displaced).expect("remove displaced fixture");
    }

    #[test]
    fn replacement_lock_regression() {
        let root = TestRoot::new("replacement-lock");
        let backend = WindowsBackend::open(root.path()).expect("open NT backend");
        let lock = backend
            .acquire_lock(
                "nested/lock",
                &LockOwner {
                    pid: std::process::id(),
                    token: "busy-token".to_owned(),
                    owner_generation: "busy-owner".to_owned(),
                },
            )
            .expect("acquire lock");
        let lock_path = root.path().join("nested/lock");

        let no_delete_share = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&lock_path)
            .expect("hold lock without delete sharing");
        let busy = backend
            .release_lock(&lock)
            .expect_err("sharing violation must be visible");
        assert_eq!(busy.code, HelperFailureCode::Busy);
        assert!(lock_path.exists());
        drop(no_delete_share);

        assert_eq!(
            backend
                .release_lock(&lock)
                .expect("release after sharing clears"),
            ReleaseLockResult::Released
        );
        assert!(!lock_path.exists());
    }
}
