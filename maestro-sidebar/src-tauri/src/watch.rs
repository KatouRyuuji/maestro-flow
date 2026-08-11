// 文件系统监听：.workflow 关键文件与 cli-history 变化时向协调器发送重建信号。
use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

const REDISCOVER: Duration = Duration::from_secs(60);

/// 事件是否与可见状态相关。JSONL carries live agent deltas, while the
/// coordinator's 250ms trailing debounce coalesces bursty writes.
fn is_relevant(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name == "state.json"
        || name == "session.json"
        || name == "run.json"
        || name.ends_with(".meta.json")
        || name.ends_with(".jsonl")
}

/// 期望的监听集合：(路径, 是否递归)。.workflow 目录递归，cli-history 非递归。
fn desired_watches() -> Vec<(PathBuf, bool)> {
    let cfg = crate::config::load();
    let mut projects = crate::workflow::discover_projects(&cfg.roots);
    // 自动识别的项目也纳入监听
    for auto_root in crate::auto::auto_discover_roots() {
        if let Some(wf) = crate::workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    let mut out: Vec<(PathBuf, bool)> = projects.into_iter().map(|p| (p, true)).collect();
    let history = crate::config::cli_history_dir();
    if history.is_dir() {
        out.push((history, false));
    }
    out
}

/// 启动 watcher 线程：监听集合每 60s 重新对齐（roots 可动态变化），
/// 相关文件事件经 debounce 后发 `request` 信号（协调器串行重建快照）。
pub fn spawn_watcher(request: mpsc::Sender<()>) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Event>();
        let mut watcher = notify::recommended_watcher(move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .expect("failed to create watcher");
        let mut watched: Vec<PathBuf> = Vec::new();

        loop {
            // 对齐监听集合
            let desired = desired_watches();
            watched.retain(|p| {
                if desired.iter().any(|(d, _)| d == p) {
                    true
                } else {
                    let _ = watcher.unwatch(p);
                    false
                }
            });
            for (path, recursive) in &desired {
                if !watched.contains(path) {
                    let mode = if *recursive {
                        RecursiveMode::Recursive
                    } else {
                        RecursiveMode::NonRecursive
                    };
                    if watcher.watch(path, mode).is_ok() {
                        watched.push(path.clone());
                    }
                }
            }

            // 等待事件或 rediscover 超时
            let deadline = std::time::Instant::now() + REDISCOVER;
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(event) => {
                        let kind = matches!(
                            event.kind,
                            notify::EventKind::Create(_)
                                | notify::EventKind::Modify(_)
                                | notify::EventKind::Remove(_)
                        );
                        if kind && event.paths.iter().any(|p| is_relevant(p)) {
                            // Signal immediately; RuntimeCoordinator owns burst debouncing.
                            let _ = request.send(());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_stream_writes_are_relevant() {
        assert!(is_relevant(Path::new("pi-123.jsonl")));
        assert!(is_relevant(Path::new("pi-123.meta.json")));
        assert!(!is_relevant(Path::new("notes.txt")));
    }
}
