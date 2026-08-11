// 自动发现：从 Agent 调用历史（cli-history meta.json 的 workDir）中提取
// 含 .workflow 的项目根，无需用户手动配置即可识别项目。
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config;

/// 扫描 cli-history 中所有记录的 workDir，返回含 .workflow 的工程根目录。
pub fn auto_discover_roots() -> Vec<PathBuf> {
    scan_roots_from(&config::cli_history_dir())
}

/// 核心扫描逻辑：读取目录下所有 *.meta.json 的 workDir 字段，
/// 找到含 .workflow 的项目根（workDir 本身或最近祖先）。
fn scan_roots_from(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_meta = entry
            .file_name()
            .to_str()
            .map(|n| n.ends_with(".meta.json"))
            .unwrap_or(false);
        if !path.is_file() || !is_meta {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(work_dir) = json.get("workDir").and_then(|v| v.as_str()) else {
            continue;
        };
        if work_dir.is_empty() {
            continue;
        }
        let dir_path = PathBuf::from(work_dir);
        if let Some(root) = find_workflow_ancestor(&dir_path) {
            roots.insert(PathBuf::from(config::normalize_path(&root)));
        }
    }
    roots.into_iter().collect()
}

/// 从 workDir 向上找最近的含 .workflow 的祖先（最多 8 层）。
fn find_workflow_ancestor(dir: &Path) -> Option<PathBuf> {
    if dir.join(".workflow").is_dir() {
        return Some(dir.to_path_buf());
    }
    let home = dirs::home_dir();
    let mut probe = dir.parent();
    let mut guard = 0;
    while let Some(p) = probe {
        if guard >= 8 || home.as_deref() == Some(p) {
            break;
        }
        if p.join(".workflow").is_dir() {
            return Some(p.to_path_buf());
        }
        probe = p.parent();
        guard += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("ms-autodisc-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&base);
        base
    }

    #[test]
    fn auto_discover_empty_dir() {
        let base = tmp_base("empty");
        fs::create_dir_all(base.join("history")).unwrap();
        assert!(scan_roots_from(&base.join("history")).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_discover_finds_project_from_workdir() {
        let base = tmp_base("proj");
        let proj = base.join("proj");
        fs::create_dir_all(proj.join(".workflow")).unwrap();
        fs::create_dir_all(base.join("history")).unwrap();
        fs::write(
            base.join("history/c1.meta.json"),
            format!(
                r#"{{"execId":"c1","tool":"codex","workDir":"{}"}}"#,
                proj.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        let found = scan_roots_from(&base.join("history"));
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("proj"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_discover_finds_ancestor_from_nested_workdir() {
        let base = tmp_base("nested");
        let proj = base.join("proj");
        let nested = proj.join("src/deep");
        fs::create_dir_all(nested.join(".workflow").parent().unwrap()).unwrap();
        fs::create_dir_all(proj.join(".workflow")).unwrap();
        fs::create_dir_all(base.join("history")).unwrap();
        fs::write(
            base.join("history/c3.meta.json"),
            format!(
                r#"{{"execId":"c3","tool":"codex","workDir":"{}"}}"#,
                nested.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        let found = scan_roots_from(&base.join("history"));
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("proj"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_discover_skips_non_workflow() {
        let base = tmp_base("skip");
        let proj = base.join("noproj");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(base.join("history")).unwrap();
        fs::write(
            base.join("history/c2.meta.json"),
            format!(
                r#"{{"execId":"c2","tool":"codex","workDir":"{}"}}"#,
                proj.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        assert!(scan_roots_from(&base.join("history")).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_discover_dedupes_same_project() {
        let base = tmp_base("dedupe");
        let proj = base.join("proj");
        fs::create_dir_all(proj.join(".workflow")).unwrap();
        fs::create_dir_all(base.join("history")).unwrap();
        for i in 0..3 {
            fs::write(
                base.join(format!("history/c{}.meta.json", i)),
                format!(
                    r#"{{"execId":"c{}","tool":"codex","workDir":"{}"}}"#,
                    i,
                    proj.to_string_lossy().replace('\\', "/")
                ),
            )
            .unwrap();
        }
        let found = scan_roots_from(&base.join("history"));
        assert_eq!(found.len(), 1);
        let _ = fs::remove_dir_all(&base);
    }
}
