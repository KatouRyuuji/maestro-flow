// .workflow/ 扫描：Session → Run 架构状态
//
// 数据源（以工程根目录 root 下的 .workflow/ 为基准）：
//   - state.json                          — 会话注册表（sessions[] + active_session_id）
//   - sessions/<id>/session.json          — 会话状态（active_run_id / latest_completed_run_id）
//   - sessions/<id>/runs/<run>/run.json   — 单次 Run 的状态、verdict、command、platform
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::normalize_path;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSummary {
    pub run_id: String,
    pub sequence: Option<i64>,
    pub status: String,
    pub verdict: Option<String>,
    pub command: Option<String>,
    pub platform: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_secs: Option<i64>,
    pub handoff_summary: Option<String>,
    pub concerns: Vec<String>,
    pub decisions: Vec<String>,
    pub gate_ids: Vec<String>,
}

/// 单个门禁条目（gates.json 的 map value）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GateInfo {
    pub key: String,
    pub title: Option<String>,
    pub scope: Option<String>,
    pub run_id: Option<String>,
    pub required: bool,
    pub blocking: bool,
    pub status: Option<String>,
    /// waiver 存在即已豁免（status 可能为 skipped）。
    pub waiver: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDetail {
    pub session: SessionSummary,
    pub runs: Vec<RunSummary>,
    pub orchestration: Option<serde_json::Value>,
    pub boundary_contract: Option<serde_json::Value>,
    /// 会话级门禁注册表（gates.json；按 key 排序保证确定性）。
    pub gates: Vec<GateInfo>,
    /// session.json 的 lifecycle 对象（sealed_at / seal_summary /
    /// promoted_spec_ids / promoted_knowhow_ids / forked_from）。
    pub lifecycle: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummary {
    pub session_id: String,
    pub intent: Option<String>,
    pub status: String,
    /// 所属工程（state.json project_name；多工程合并时用于区分）
    pub project: Option<String>,
    pub active_run_id: Option<String>,
    pub latest_completed_run_id: Option<String>,
    pub run_count: usize,
    pub latest_run: Option<RunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub has_workflow: bool,
    pub active_session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn as_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::to_owned).filter(|s| !s.is_empty())
}

fn str_field(obj: &serde_json::Value, key: &str) -> Option<String> {
    obj.get(key).and_then(as_str)
}

/// Read a detail list while tolerating both legacy strings and the structured
/// `{ id, text, status }` items used by current command handoffs.
fn detail_list(obj: &serde_json::Value, key: &str) -> Vec<String> {
    obj.get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    as_str(item).or_else(|| {
                        let text = str_field(item, "text")?;
                        let id = str_field(item, "id");
                        let status = str_field(item, "status");
                        let core = match id {
                            Some(id) => format!("{id} · {text}"),
                            None => text,
                        };
                        Some(match status {
                            Some(status) => format!("{core} [{status}]"),
                            None => core,
                        })
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Workflow root discovery
// ---------------------------------------------------------------------------

/// 找到 root 下的 .workflow 目录（root 本身或其直接子目录）。
pub fn find_workflow_root(root: &Path) -> Option<PathBuf> {
    let direct = root.join(".workflow");
    if direct.is_dir() {
        return Some(direct);
    }
    // 兼容 root 本身是 .workflow 目录的情况
    if root.join("state.json").is_file() {
        return Some(root.to_path_buf());
    }
    None
}

/// 列出所有可观察的工程（root 直接含 .workflow，或 root 子目录含 .workflow）。
pub fn discover_projects(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let root_path = crate::config::expand_home(root);
        if let Some(wf) = find_workflow_root(&root_path) {
            out.push(wf);
        }
        // 子目录探测（一层）：项目常以 <parent>/<proj>/.workflow 组织
        if let Ok(entries) = fs::read_dir(&root_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && find_workflow_root(&path).is_some() {
                    out.push(path.join(".workflow"));
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn project_info(wf_root: &Path) -> ProjectInfo {
    let state = read_json(&wf_root.join("state.json"));
    let name = state
        .as_ref()
        .and_then(|s| str_field(s, "project_name"))
        .unwrap_or_else(|| {
            wf_root
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| normalize_path(wf_root))
        });
    ProjectInfo {
        path: normalize_path(wf_root),
        name,
        has_workflow: true,
        active_session_id: state
            .as_ref()
            .and_then(|s| str_field(s, "active_session_id")),
    }
}

// ---------------------------------------------------------------------------
// state.json — 会话注册表
// ---------------------------------------------------------------------------

/// 读取 state.json 的会话列表（session_id → (intent, status)）。
fn read_registry(state_path: &Path) -> Vec<(String, Option<String>, Option<String>)> {
    let Some(state) = read_json(state_path) else {
        return Vec::new();
    };
    let Some(sessions) = state.get("sessions").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    sessions
        .iter()
        .filter_map(|s| {
            let id = str_field(s, "session_id")?;
            Some((id, str_field(s, "intent"), str_field(s, "status")))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// run.json 解析
// ---------------------------------------------------------------------------

fn parse_run(raw: &serde_json::Value) -> RunSummary {
    let output = raw.get("output");
    let handoff = raw.get("handoff");
    let command = raw.get("command");
    let verdict = output
        .and_then(|o| str_field(o, "verdict"))
        .or_else(|| handoff.and_then(|h| str_field(h, "verdict")));
    let started = str_field(raw, "started_at");
    let completed = str_field(raw, "completed_at").or_else(|| str_field(raw, "sealed_at"));
    let duration_secs = match (&started, &completed) {
        (Some(s), Some(e)) => {
            let parse = |iso: &str| {
                chrono::DateTime::parse_from_rfc3339(iso)
                    .ok()
                    .map(|t| t.timestamp())
            };
            match (parse(s), parse(e)) {
                (Some(a), Some(b)) if b >= a => Some(b - a),
                _ => None,
            }
        }
        _ => None,
    };
    let string_list = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    RunSummary {
        run_id: str_field(raw, "run_id").unwrap_or_default(),
        sequence: raw.get("sequence").and_then(|v| v.as_i64()),
        status: str_field(raw, "status").unwrap_or_else(|| "unknown".into()),
        verdict,
        command: command.and_then(|c| str_field(c, "name")),
        platform: str_field(raw, "resolved_platform"),
        started_at: started,
        completed_at: completed,
        duration_secs,
        handoff_summary: handoff.and_then(|h| str_field(h, "summary")),
        concerns: handoff
            .map(|h| detail_list(h, "concerns"))
            .unwrap_or_default(),
        decisions: handoff
            .map(|h| detail_list(h, "decisions"))
            .unwrap_or_default(),
        gate_ids: raw.get("gate_ids").map(string_list).unwrap_or_default(),
    }
}

/// 解析会话级 gates.json（key → GateInfo，按 key 字典序）。
pub fn scan_gates(wf_root: &Path, session_id: &str) -> Vec<GateInfo> {
    let path = wf_root.join("sessions").join(session_id).join("gates.json");
    let Some(raw) = read_json(&path) else {
        return Vec::new();
    };
    let Some(gates) = raw.get("gates").and_then(|g| g.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<GateInfo> = gates
        .values()
        .filter_map(|v| {
            let key = str_field(v, "key").unwrap_or_default();
            if key.is_empty() {
                return None;
            }
            Some(GateInfo {
                key,
                title: str_field(v, "title"),
                scope: str_field(v, "scope"),
                run_id: str_field(v, "run_id"),
                required: v.get("required").and_then(|x| x.as_bool()).unwrap_or(false),
                blocking: v.get("blocking").and_then(|x| x.as_bool()).unwrap_or(false),
                status: str_field(v, "status"),
                waiver: v.get("waiver").cloned(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// 会话完整详情：session.json 关键字段 + 全量 run 列表。
pub fn scan_session_detail(wf_root: &Path, session_id: &str) -> Option<SessionDetail> {
    let session_dir = wf_root.join("sessions").join(session_id);
    let session_json = read_json(&session_dir.join("session.json"))?;
    let runs = scan_runs(wf_root, session_id);
    let (latest_run, run_count) = load_latest_run(&session_dir);
    let status = str_field(&session_json, "status").unwrap_or_else(|| "unknown".into());
    // 工程归属：与 scan_sessions_impl 同源（state.json project_name），
    // 多工程合并时详情页可标注归属（原实现恒为 None）。
    let project = read_json(&wf_root.join("state.json"))
        .and_then(|v| str_field(&v, "project_name"));
    let session = SessionSummary {
        session_id: session_id.to_owned(),
        intent: str_field(&session_json, "intent"),
        status,
        project,
        active_run_id: str_field(&session_json, "active_run_id"),
        latest_completed_run_id: str_field(&session_json, "latest_completed_run_id"),
        run_count,
        latest_run,
    };
    Some(SessionDetail {
        session,
        runs,
        orchestration: session_json.get("orchestration").cloned(),
        boundary_contract: session_json.get("boundary_contract").cloned(),
        gates: scan_gates(wf_root, session_id),
        lifecycle: session_json.get("lifecycle").cloned(),
    })
}

/// 读取会话 runs/ 下最新的 run.json。
fn load_latest_run(session_dir: &Path) -> (Option<RunSummary>, usize) {
    let runs_dir = session_dir.join("runs");
    let Ok(entries) = fs::read_dir(&runs_dir) else {
        return (None, 0);
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    if dirs.is_empty() {
        return (None, 0);
    }
    dirs.sort(); // run_id 按 YYYYMMDD-NNN-name 字典序即时间序
    let latest = dirs.last().unwrap();
    let run = read_json(&runs_dir.join(latest).join("run.json")).map(|v| parse_run(&v));
    (run, dirs.len())
}

// ---------------------------------------------------------------------------
// 会话汇总
// ---------------------------------------------------------------------------

/// 合并 state.json 注册表与磁盘 sessions/ 目录，输出会话摘要（新→旧）。
pub fn scan_sessions(wf_root: &Path) -> Vec<SessionSummary> {
    scan_sessions_with_project(wf_root, None)
}

/// project 名用于多工程合并时标注归属；None 时从 state.json project_name 推导。
pub fn scan_sessions_with_project(wf_root: &Path, project: Option<&str>) -> Vec<SessionSummary> {
    scan_sessions_impl(wf_root, project)
}

fn scan_sessions_impl(wf_root: &Path, project: Option<&str>) -> Vec<SessionSummary> {
    let project_name = match project {
        Some(name) => Some(name.to_string()),
        None => read_json(&wf_root.join("state.json"))
            .and_then(|v| str_field(&v, "project_name")),
    };
    let registry = read_registry(&wf_root.join("state.json"));
    let sessions_dir = wf_root.join("sessions");

    let mut by_id: std::collections::BTreeMap<String, (Option<String>, Option<String>)> = registry
        .into_iter()
        .map(|(id, intent, status)| (id, (intent, status)))
        .collect();

    // 磁盘上有目录但注册表缺失的会话也纳入
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                by_id.entry(name.to_owned()).or_insert_with(|| {
                    // 尝试从 session.json 补充状态
                    let s = read_json(&path.join("session.json"));
                    (
                        str_field(s.as_ref().unwrap_or(&serde_json::Value::Null), "intent")
                            .or(None),
                        s.as_ref().and_then(|v| str_field(v, "status")),
                    )
                });
            }
        }
    }

    let mut sessions: Vec<SessionSummary> = by_id
        .into_iter()
        .map(|(id, (intent, reg_status))| {
            let session_dir = sessions_dir.join(&id);
            let (latest_run, run_count) = load_latest_run(&session_dir);
            let session_json = read_json(&session_dir.join("session.json"));
            let raw_status = session_json
                .as_ref()
                .and_then(|v| str_field(v, "status"))
                .or(reg_status)
                .unwrap_or_else(|| "unknown".into());
            SessionSummary {
                session_id: id,
                intent,
                // 展示状态：state.json/session.json 的 running 常为陈旧值（session 完成后未更新）；
                // 以最新 run.json 的实际状态为准（运行时权威）。
                status: effective_status(&raw_status, &latest_run, &session_dir),
                project: project_name.clone(),
                active_run_id: session_json
                    .as_ref()
                    .and_then(|v| str_field(v, "active_run_id")),
                latest_completed_run_id: session_json
                    .as_ref()
                    .and_then(|v| str_field(v, "latest_completed_run_id")),
                run_count,
                latest_run,
            }
        })
        .collect();

    // 排序：运行中 > 暂停 > 失败/阻塞 > 已封存，组内按 session_id 倒序（新在前）
    sessions.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    sessions.truncate(40);
    sessions
}

/// 列表展示用状态：对 running/active 做最新 run 校正（陈旧 running 降级为实际状态）。
/// 无 run 目录时：目录 24h 内有活动才视为真运行，否则视为陈旧（幽灵/已完成未更新的 session）。
fn effective_status(raw: &str, latest: &Option<RunSummary>, dir: &Path) -> String {
    let s = raw.to_ascii_lowercase();
    if s != "running" && s != "active" && s != "executing" {
        return raw.to_string();
    }
    match latest {
        Some(run) => match run.status.to_ascii_lowercase().as_str() {
            // run.json 的 running 也会陈旧（会话中断后未 seal）：started 超过 2 小时无
            // 新活动即视为陈旧 → 已封存
            "running" | "executing" | "active" => {
                let stale = run.started_at.as_deref().and_then(|iso| {
                    chrono::DateTime::parse_from_rfc3339(iso).ok()
                }).map(|t| {
                    t.signed_duration_since(chrono::Utc::now())
                        .num_minutes()
                        .unsigned_abs() > 120
                }).unwrap_or(false);
                if stale {
                    "sealed".into()
                } else {
                    "running".into()
                }
            }
            "sealed" | "completed" | "done" => "sealed".into(),
            "failed" | "blocked" => "blocked".into(),
            "paused" => "paused".into(),
            // 异常 run 状态：保持原始状态
            _ => raw.to_string(),
        },
        None => {
            let fresh = fs::metadata(dir)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map(|e| e < std::time::Duration::from_secs(24 * 3600))
                .unwrap_or(false);
            if fresh {
                raw.to_string()
            } else {
                "sealed".into()
            }
        }
    }
}

pub(crate) fn status_rank(status: &str) -> u8 {
    match status.to_ascii_lowercase().as_str() {
        "running" | "active" | "executing" => 0,
        "paused" => 1,
        "blocked" | "failed" => 2,
        _ => 3, // sealed / completed / unknown
    }
}

/// 读取某会话的完整 run 列表（供前端展开）。
pub fn scan_runs(wf_root: &Path, session_id: &str) -> Vec<RunSummary> {
    let runs_dir = wf_root.join("sessions").join(session_id).join("runs");
    let Ok(entries) = fs::read_dir(&runs_dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    dirs.sort();
    dirs.iter()
        .filter_map(|d| {
            let raw = read_json(&runs_dir.join(d).join("run.json"))?;
            Some(parse_run(&raw))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// run 产出物（report.md + outputs/ 列表 + 注册表计数）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunArtifactFile {
    pub name: String,
    pub size: u64,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunArtifacts {
    pub report_md: Option<String>,
    pub outputs: Vec<RunArtifactFile>,
    /// 会话级 evidence.json records 数
    pub evidence_records: u64,
    /// 会话级 artifacts.json artifacts 数
    pub artifacts_count: u64,
}

const REPORT_MAX_CHARS: usize = 20_000;
const OUTPUT_PREVIEW_CHARS: usize = 200;
const OUTPUT_FILE_LIMIT: usize = 30;
const OUTPUT_CONTENT_MAX_CHARS: usize = 30_000;

/// 扫描 run 产出物：report.md（截断）、outputs/ 文件（名称/大小/预览）、
/// 会话级 evidence/artifacts 注册表计数。
pub fn scan_run_artifacts(wf_root: &Path, session_id: &str, run_id: &str) -> Option<RunArtifacts> {
    let run_dir = wf_root
        .join("sessions")
        .join(session_id)
        .join("runs")
        .join(run_id);
    if !run_dir.is_dir() {
        return None;
    }
    let mut out = RunArtifacts::default();
    if let Ok(raw) = fs::read_to_string(run_dir.join("report.md")) {
        let truncated = raw.chars().take(REPORT_MAX_CHARS).collect::<String>();
        out.report_md = Some(truncated);
    }
    if let Ok(entries) = fs::read_dir(run_dir.join("outputs")) {
        let mut files: Vec<_> = entries.flatten().filter(|e| e.path().is_file()).collect();
        files.sort_by_key(|e| e.file_name());
        for f in files.into_iter().take(OUTPUT_FILE_LIMIT) {
            let name = f.file_name().to_string_lossy().to_string();
            let size = f.metadata().map(|m| m.len()).unwrap_or(0);
            let preview = fs::read_to_string(f.path())
                .map(|s| s.chars().take(OUTPUT_PREVIEW_CHARS).collect::<String>())
                .unwrap_or_default();
            out.outputs.push(RunArtifactFile { name, size, preview });
        }
    }
    let session_dir = wf_root.join("sessions").join(session_id);
    if let Ok(raw) = fs::read_to_string(session_dir.join("evidence.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            out.evidence_records = v
                .get("records")
                .and_then(|x| x.as_array())
                .map(|a| a.len() as u64)
                .unwrap_or(0);
        }
    }
    if let Ok(raw) = fs::read_to_string(session_dir.join("artifacts.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            out.artifacts_count = v
                .get("artifacts")
                .and_then(|x| x.as_object())
                .map(|o| o.len() as u64)
                .unwrap_or(0);
        }
    }
    Some(out)
}

/// 读取单个 output 文件内容（防路径逃逸：name 仅限文件名）。
pub fn read_run_output(
    wf_root: &Path,
    session_id: &str,
    run_id: &str,
    name: &str,
) -> Option<String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return None;
    }
    let path = wf_root
        .join("sessions")
        .join(session_id)
        .join("runs")
        .join(run_id)
        .join("outputs")
        .join(name);
    if !path.is_file() {
        return None;
    }
    fs::read_to_string(path)
        .ok()
        .map(|s| s.chars().take(OUTPUT_CONTENT_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("maestro-sidebar-wf-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_run_extracts_verdict_command_platform() {
        let raw: serde_json::Value = serde_json::from_str(
            r#"{
              "run_id": "20260723-001-status",
              "sequence": 1,
              "status": "sealed",
              "command": { "name": "status", "version": "1.0" },
              "output": { "verdict": "ready", "produces": [] },
              "handoff": { "verdict": "ready", "summary": "ok" },
              "resolved_platform": "claude",
              "started_at": "2026-07-23T08:11:23+08:00",
              "completed_at": "2026-07-23T08:12:10+08:00"
            }"#,
        )
        .unwrap();
        let run = parse_run(&raw);
        assert_eq!(run.run_id, "20260723-001-status");
        assert_eq!(run.verdict.as_deref(), Some("ready"));
        assert_eq!(run.command.as_deref(), Some("status"));
        assert_eq!(run.platform.as_deref(), Some("claude"));
        assert_eq!(run.sequence, Some(1));
        assert!(run.completed_at.is_some());
    }

    #[test]
    fn parse_run_extracts_structured_handoff_details() {
        let raw: serde_json::Value = serde_json::from_str(
            r#"{
              "run_id": "20260810-002-review",
              "status": "sealed",
              "handoff": {
                "summary": "Review found a required fix loop.",
                "decisions": [
                  { "id": "D1", "text": "Insert repair before WP-06.", "status": "accepted" },
                  "Keep the existing scope."
                ],
                "concerns": ["WP-06 must not start before re-review."]
              },
              "gate_ids": ["GATE-review", "GATE-WP06"]
            }"#,
        )
        .unwrap();

        let run = parse_run(&raw);
        assert_eq!(
            run.handoff_summary.as_deref(),
            Some("Review found a required fix loop.")
        );
        assert_eq!(
            run.decisions,
            vec![
                "D1 · Insert repair before WP-06. [accepted]",
                "Keep the existing scope."
            ]
        );
        assert_eq!(run.concerns, vec!["WP-06 must not start before re-review."]);
        assert_eq!(run.gate_ids, vec!["GATE-review", "GATE-WP06"]);
    }

    #[test]
    fn parse_run_falls_back_to_sealed_at() {
        let raw: serde_json::Value = serde_json::from_str(
            r#"{"run_id": "r1", "status": "sealed", "sealed_at": "2026-07-23T08:12:10+08:00"}"#,
        )
        .unwrap();
        let run = parse_run(&raw);
        assert_eq!(
            run.completed_at.as_deref(),
            Some("2026-07-23T08:12:10+08:00")
        );
        assert_eq!(run.verdict, None);
    }

    #[test]
    fn scan_sessions_reads_registry_and_runs() {
        let root = tmp_dir("scan");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/20260723-alpha/runs/20260723-001-status")).unwrap();
        fs::write(
            wf.join("state.json"),
            r#"{"project_name":"demo","active_session_id":"20260723-alpha","sessions":[{"session_id":"20260723-alpha","intent":"验证端到端","status":"running"}]}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/20260723-alpha/session.json"),
            r#"{"session_id":"20260723-alpha","active_run_id":"20260723-001-status","status":"running"}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/20260723-alpha/runs/20260723-001-status/run.json"),
            r#"{"run_id":"20260723-001-status","status":"sealed","command":{"name":"status"},"output":{"verdict":"ready"},"resolved_platform":"claude"}"#,
        )
        .unwrap();

        let sessions = scan_sessions(&wf);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.session_id, "20260723-alpha");
        assert_eq!(s.intent.as_deref(), Some("验证端到端"));
        // 有效状态：registry 标 running 但最新 run 已 sealed → 展示为 sealed
        assert_eq!(s.status, "sealed");
        assert_eq!(s.active_run_id.as_deref(), Some("20260723-001-status"));
        assert_eq!(s.run_count, 1);
        let run = s.latest_run.as_ref().unwrap();
        assert_eq!(run.verdict.as_deref(), Some("ready"));
        assert_eq!(run.platform.as_deref(), Some("claude"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_session_detail_backfills_project() {
        let root = tmp_dir("detail-proj");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s1/runs/r1")).unwrap();
        fs::write(
            wf.join("state.json"),
            r#"{"project_name":"demo","sessions":[{"session_id":"s1"}]}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s1/session.json"),
            r#"{"session_id":"s1","status":"sealed"}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s1/runs/r1/run.json"),
            r#"{"run_id":"r1","status":"sealed"}"#,
        )
        .unwrap();

        let detail = scan_session_detail(&wf, "s1").unwrap();
        assert_eq!(detail.session.project.as_deref(), Some("demo"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_gates_parses_status_and_flags() {
        let root = tmp_dir("gates");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s1")).unwrap();
        fs::write(
            wf.join("sessions/s1/gates.json"),
            r#"{"schema_version":"gates/1.0","gates":{
              "GATE-A": {"key":"GATE-A","title":"Entry check","scope":"entry","run_id":"r1","required":false,"blocking":false,"status":"skipped","waiver":null},
              "GATE-B": {"key":"GATE-B","title":"Exit check","scope":"exit","run_id":"r1","required":true,"blocking":true,"status":"passed"}
            }}"#,
        )
        .unwrap();

        let gates = scan_gates(&wf, "s1");
        assert_eq!(gates.len(), 2);
        assert_eq!(gates[0].key, "GATE-A");
        assert_eq!(gates[0].status.as_deref(), Some("skipped"));
        assert!(!gates[0].required);
        let b = &gates[1];
        assert_eq!(b.title.as_deref(), Some("Exit check"));
        assert!(b.required && b.blocking);
        assert_eq!(b.status.as_deref(), Some("passed"));
        // 缺 gates.json → 空
        assert!(scan_gates(&wf, "missing").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_run_artifacts_reads_report_outputs_and_registry_counts() {
        let root = tmp_dir("artifacts");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s1/runs/r1/outputs")).unwrap();
        fs::write(
            wf.join("sessions/s1/runs/r1/report.md"),
            "# Report\n\nsummary body",
        )
        .unwrap();
        fs::write(wf.join("sessions/s1/runs/r1/outputs/findings.json"), "{\"a\":1}").unwrap();
        fs::write(wf.join("sessions/s1/runs/r1/outputs/note.txt"), "hello preview").unwrap();
        fs::write(
            wf.join("sessions/s1/evidence.json"),
            r#"{"records":[{"id":"E1"},{"id":"E2"}]}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s1/artifacts.json"),
            r#"{"artifacts":{"a":1,"b":2,"c":3}}"#,
        )
        .unwrap();

        let a = scan_run_artifacts(&wf, "s1", "r1").unwrap();
        assert_eq!(a.report_md.as_deref(), Some("# Report\n\nsummary body"));
        assert_eq!(a.outputs.len(), 2);
        assert_eq!(a.outputs[0].name, "findings.json");
        assert_eq!(a.outputs[1].preview, "hello preview");
        assert_eq!(a.evidence_records, 2);
        assert_eq!(a.artifacts_count, 3);
        // 不存在的 run → None
        assert!(scan_run_artifacts(&wf, "s1", "nope").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_run_output_blocks_path_escape() {
        let root = tmp_dir("escape");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s1/runs/r1/outputs")).unwrap();
        fs::write(wf.join("sessions/s1/runs/r1/outputs/ok.json"), "fine").unwrap();
        assert_eq!(read_run_output(&wf, "s1", "r1", "ok.json").as_deref(), Some("fine"));
        assert!(read_run_output(&wf, "s1", "r1", "../secret").is_none());
        assert!(read_run_output(&wf, "s1", "r1", "a/b").is_none());
        assert!(read_run_output(&wf, "s1", "r1", "..\\evil").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_sessions_missing_dir_returns_empty() {
        let root = tmp_dir("empty");
        assert!(scan_sessions(&root.join(".workflow")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_projects_finds_nested_workflow() {
        let root = tmp_dir("discover");
        fs::create_dir_all(root.join("proj/.workflow")).unwrap();
        let projects = discover_projects(&[root.to_string_lossy().into_owned()]);
        assert_eq!(projects.len(), 1);
        assert!(projects[0].ends_with(".workflow"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_runs_returns_sorted_list() {
        let root = tmp_dir("runs");
        let wf = root.join(".workflow");
        let sdir = wf.join("sessions/s1/runs");
        fs::create_dir_all(sdir.join("20260723-002-verify")).unwrap();
        fs::create_dir_all(sdir.join("20260723-001-execute")).unwrap();
        fs::write(
            sdir.join("20260723-001-execute/run.json"),
            r#"{"run_id":"20260723-001-execute","command":{"name":"execute"},"output":{"verdict":"ready"}}"#,
        )
        .unwrap();
        fs::write(
            sdir.join("20260723-002-verify/run.json"),
            r#"{"run_id":"20260723-002-verify","command":{"name":"verify"},"output":{"verdict":"blocked"}}"#,
        )
        .unwrap();

        let runs = scan_runs(&wf, "s1");
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].run_id, "20260723-001-execute");
        assert_eq!(runs[1].run_id, "20260723-002-verify");
        assert_eq!(runs[1].verdict.as_deref(), Some("blocked"));
        let _ = fs::remove_dir_all(&root);
    }
}
