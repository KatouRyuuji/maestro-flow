// .workflow/ 扫描：Session → Run 架构状态
//
// 数据源（以工程根目录 root 下的 .workflow/ 为基准）：
//   - state.json                          — 会话注册表（sessions[] + active_session_id）
//   - sessions/<id>/session.json          — 会话状态（active_run_id / latest_completed_run_id）
//   - sessions/<id>/runs/<run>/run.json   — 单次 Run 的状态、verdict、command、platform
//
// 兼容双代模型：command-run/1.x + session/1.x（legacy）与
// run/3.0 + session/3.0（v3，字段归一化见 parse_run_v3 / v3_* 辅助函数）。
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
    /// Legacy command-run execution platform. Canonical run/3.0 records use
    /// actor_id instead and must not conflate actor identity with a platform.
    pub platform: Option<String>,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub revision: Option<i64>,
    #[serde(default)]
    pub attempt: Option<i64>,
    #[serde(default)]
    pub retry_of_run_id: Option<String>,
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
    /// Canonical session/3.0 decision references. Legacy sessions expose an
    /// empty list because their decision model lives under orchestration.
    #[serde(default)]
    pub decisions: Vec<serde_json::Value>,
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
    /// 受信任的 .workflow 归一化路径；全局模式下用于无歧义详情定位。
    #[serde(default)]
    pub project_path: Option<String>,
    /// Full canonical active set. Legacy sessions contain zero or one entry.
    #[serde(default)]
    pub active_run_ids: Vec<String>,
    /// Singular compatibility alias selected from the active set.
    pub active_run_id: Option<String>,
    pub latest_completed_run_id: Option<String>,
    #[serde(default)]
    pub orchestration_revision: Option<i64>,
    #[serde(default)]
    pub activity_revision: Option<i64>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
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

fn timestamp_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn run_sort_timestamp(run: &RunSummary) -> Option<i64> {
    [
        run.created_at.as_deref(),
        run.started_at.as_deref(),
        run.completed_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(timestamp_millis)
}

fn run_sort_timestamp_option(run: &Option<RunSummary>) -> Option<i64> {
    run.as_ref().and_then(run_sort_timestamp)
}

fn session_sort_timestamp(session: &SessionSummary) -> Option<i64> {
    [session.updated_at.as_deref(), session.created_at.as_deref()]
        .into_iter()
        .flatten()
        .find_map(timestamp_millis)
        .or_else(|| run_sort_timestamp_option(&session.latest_run))
}

fn completed_run_sort_timestamp(run: &RunSummary) -> Option<i64> {
    [
        run.completed_at.as_deref(),
        run.started_at.as_deref(),
        run.created_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(timestamp_millis)
}

fn compare_runs(left: &RunSummary, right: &RunSummary) -> std::cmp::Ordering {
    run_sort_timestamp(left)
        .cmp(&run_sort_timestamp(right))
        .then_with(|| left.run_id.cmp(&right.run_id))
}

fn is_completed_run(run: &RunSummary) -> bool {
    matches!(
        run.status.to_ascii_lowercase().as_str(),
        "completed" | "done" | "sealed"
    )
}

fn latest_completed_run_id(runs: &[RunSummary]) -> Option<String> {
    runs.iter()
        .filter(|run| is_completed_run(run))
        .max_by(|left, right| {
            completed_run_sort_timestamp(left)
                .cmp(&completed_run_sort_timestamp(right))
                .then_with(|| left.run_id.cmp(&right.run_id))
        })
        .map(|run| run.run_id.clone())
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

/// 解析 run.json：command-run/1.x（既有）与 run/3.0（session/3.0 的 Run 模型）双兼容。
/// run/3.0 的字段全部在顶层：command 是字符串、verdict/summary 独立字段、
/// 结束时间为 ended_at（sealed 时 sealed_at）、执行者为 actor_id。
fn parse_run(raw: &serde_json::Value) -> RunSummary {
    if str_field(raw, "schema_version").as_deref() == Some("run/3.0") {
        return parse_run_v3(raw);
    }
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
        actor_id: str_field(raw, "actor_id"),
        created_at: str_field(raw, "created_at"),
        revision: raw.get("revision").and_then(|value| value.as_i64()),
        attempt: raw.get("attempt").and_then(|value| value.as_i64()),
        retry_of_run_id: str_field(raw, "retry_of_run_id"),
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

/// run/3.0 解析：顶层字段直读；run 列表展示所需字段全部归一化到 RunSummary。
fn parse_run_v3(raw: &serde_json::Value) -> RunSummary {
    let created = str_field(raw, "created_at");
    let started = str_field(raw, "started_at");
    let completed = str_field(raw, "ended_at").or_else(|| str_field(raw, "sealed_at"));
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
    RunSummary {
        run_id: str_field(raw, "run_id").unwrap_or_default(),
        sequence: None, // run/3.0 无 sequence；时间线用 run_id 排序
        status: str_field(raw, "status").unwrap_or_else(|| "unknown".into()),
        verdict: str_field(raw, "verdict"),
        command: str_field(raw, "command"),
        platform: None,
        actor_id: str_field(raw, "actor_id"),
        created_at: created,
        revision: raw.get("revision").and_then(|value| value.as_i64()),
        attempt: raw.get("attempt").and_then(|value| value.as_i64()),
        retry_of_run_id: str_field(raw, "retry_of_run_id"),
        started_at: started,
        completed_at: completed,
        duration_secs,
        handoff_summary: str_field(raw, "summary"),
        concerns: Vec::new(),
        decisions: Vec::new(),
        gate_ids: Vec::new(),
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

// ---------------------------------------------------------------------------
// session/3.0 兼容：把 v3 会话文档归一化为 sidebar 展示形状（引用不复制）
// ---------------------------------------------------------------------------

/// session.json 是否为 session/3.0 文档。
fn is_session_v3(v: &serde_json::Value) -> bool {
    str_field(v, "schema_version").as_deref() == Some("session/3.0")
}

/// session/3.0 无 intent 字段，会话目标在 objective。
fn v3_intent(v: &serde_json::Value) -> Option<String> {
    str_field(v, "objective")
}

/// Return the complete active set for either schema generation.
fn active_run_ids(v: &serde_json::Value) -> Vec<String> {
    if is_session_v3(v) {
        return v
            .get("active_run_ids")
            .and_then(|value| value.as_array())
            .map(|items| items.iter().filter_map(as_str).collect())
            .unwrap_or_default();
    }
    str_field(v, "active_run_id").into_iter().collect()
}

/// Pick the most recently created/started active Run for consumers that still
/// understand only one active_run_id. Unknown references remain plural-only
/// because canonical hash ordering carries no chronology.
fn compatible_active_run_id(v: &serde_json::Value, runs: &[RunSummary]) -> Option<String> {
    if !is_session_v3(v) {
        return str_field(v, "active_run_id");
    }
    let ids = active_run_ids(v);
    runs.iter()
        .filter(|run| ids.iter().any(|id| id == &run.run_id))
        .max_by(|left, right| compare_runs(left, right))
        .map(|run| run.run_id.clone())
}

/// session/3.0 stores a sorted set of Run IDs, not chronological history.
/// Resolve the latest attempt from Run metadata and retain run_ids losslessly.
fn v3_orchestration(v: &serde_json::Value, runs: &[RunSummary]) -> Option<serde_json::Value> {
    let chain = v.get("chain")?.as_array()?;
    let steps: Vec<serde_json::Value> = chain
        .iter()
        .map(|step| {
            let mut s = step.clone();
            if s.get("run_id").is_none() {
                let ids: Vec<String> = s
                    .get("run_ids")
                    .and_then(|value| value.as_array())
                    .map(|items| items.iter().filter_map(as_str).collect())
                    .unwrap_or_default();
                let latest = runs
                    .iter()
                    .filter(|run| ids.iter().any(|id| id == &run.run_id))
                    .max_by(|left, right| {
                        left.attempt
                            .cmp(&right.attempt)
                            .then_with(|| compare_runs(left, right))
                    });
                if let Some(latest) = latest {
                    s["run_id"] = serde_json::Value::String(latest.run_id.clone());
                }
            }
            s
        })
        .collect();
    Some(serde_json::json!({
        "engine": "chain-v3",
        "orchestration_revision": v.get("orchestration_revision").cloned(),
        "activity_revision": v.get("activity_revision").cloned(),
        "chain": steps,
    }))
}

/// session/3.0 无 boundary_contract 对象：objective 入 In Scope，DoD 独立字段。
fn v3_boundary_contract(v: &serde_json::Value) -> Option<serde_json::Value> {
    let in_scope = v3_intent(v).map(|o| vec![o]).unwrap_or_default();
    Some(serde_json::json!({
        "in_scope": in_scope,
        "out_of_scope": [],
        "constraints": [],
        "definition_of_done": str_field(v, "definition_of_done").unwrap_or_default(),
    }))
}

/// session/3.0 无 lifecycle 对象：completed_at/archived_at → 封存时间（收据卡展示）。
fn v3_lifecycle(v: &serde_json::Value) -> Option<serde_json::Value> {
    Some(serde_json::json!({
        "sealed_at": str_field(v, "completed_at").or_else(|| str_field(v, "archived_at")),
        "promoted_spec_ids": [],
        "promoted_knowhow_ids": [],
        "forked_from": null,
    }))
}

/// 会话完整详情：session.json 关键字段 + 全量 run 列表。
pub fn scan_session_detail(wf_root: &Path, session_id: &str) -> Option<SessionDetail> {
    let session_dir = wf_root.join("sessions").join(session_id);
    let session_json = read_json(&session_dir.join("session.json"))?;
    let is_v3 = is_session_v3(&session_json);
    let (runs, run_count) = load_runs(&session_dir);
    let latest_run = runs.last().cloned();
    let all_active_run_ids = active_run_ids(&session_json);
    let status = effective_status(
        &str_field(&session_json, "status").unwrap_or_else(|| "unknown".into()),
        &latest_run,
        &session_dir,
        is_v3,
    );
    // 工程归属：与 scan_sessions_impl 同源（state.json project_name），
    // 多工程合并时详情页可标注归属（原实现恒为 None）。
    let project =
        read_json(&wf_root.join("state.json")).and_then(|v| str_field(&v, "project_name"));
    let session = SessionSummary {
        session_id: session_id.to_owned(),
        intent: str_field(&session_json, "intent").or_else(|| v3_intent(&session_json)),
        status,
        project,
        project_path: Some(normalize_path(wf_root)),
        active_run_ids: all_active_run_ids,
        active_run_id: compatible_active_run_id(&session_json, &runs),
        latest_completed_run_id: str_field(&session_json, "latest_completed_run_id")
            .or_else(|| latest_completed_run_id(&runs)),
        orchestration_revision: session_json
            .get("orchestration_revision")
            .and_then(|value| value.as_i64()),
        activity_revision: session_json
            .get("activity_revision")
            .and_then(|value| value.as_i64()),
        created_at: str_field(&session_json, "created_at"),
        updated_at: str_field(&session_json, "updated_at"),
        run_count,
        latest_run,
    };
    let orchestration = if is_v3 {
        v3_orchestration(&session_json, &runs)
    } else {
        session_json.get("orchestration").cloned()
    };
    Some(SessionDetail {
        session,
        runs,
        orchestration,
        decisions: if is_v3 {
            session_json
                .get("decisions")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        boundary_contract: if is_v3 {
            v3_boundary_contract(&session_json)
        } else {
            session_json.get("boundary_contract").cloned()
        },
        gates: scan_gates(wf_root, session_id),
        lifecycle: if is_v3 {
            v3_lifecycle(&session_json)
        } else {
            session_json.get("lifecycle").cloned()
        },
    })
}

/// Read and timestamp-sort every valid run.json. Hash-based v3 Run IDs have no
/// chronology, so IDs are only a deterministic tie-breaker/fallback.
fn load_runs(session_dir: &Path) -> (Vec<RunSummary>, usize) {
    let runs_dir = session_dir.join("runs");
    let Ok(entries) = fs::read_dir(&runs_dir) else {
        return (Vec::new(), 0);
    };
    let dirs: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect();
    let run_count = dirs.len();
    let mut runs: Vec<RunSummary> = dirs
        .iter()
        .filter_map(|dir| read_json(&runs_dir.join(dir).join("run.json")))
        .map(|raw| parse_run(&raw))
        .collect();
    runs.sort_by(compare_runs);
    (runs, run_count)
}

/// Read the chronologically latest valid run.json.
#[cfg(test)]
fn load_latest_run(session_dir: &Path) -> (Option<RunSummary>, usize) {
    let (runs, run_count) = load_runs(session_dir);
    (runs.last().cloned(), run_count)
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
        None => read_json(&wf_root.join("state.json")).and_then(|v| str_field(&v, "project_name")),
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
                        s.as_ref()
                            .and_then(|v| str_field(v, "intent").or_else(|| v3_intent(v)))
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
            let (runs, run_count) = load_runs(&session_dir);
            let latest_run = runs.last().cloned();
            let session_json = read_json(&session_dir.join("session.json"));
            let intent = session_json
                .as_ref()
                .and_then(|v| str_field(v, "intent").or_else(|| v3_intent(v)))
                .or(intent);
            let raw_status = session_json
                .as_ref()
                .and_then(|v| str_field(v, "status"))
                .or(reg_status)
                .unwrap_or_else(|| "unknown".into());
            let is_v3 = session_json.as_ref().map(is_session_v3).unwrap_or(false);
            let all_active_run_ids = session_json
                .as_ref()
                .map(active_run_ids)
                .unwrap_or_default();
            SessionSummary {
                session_id: id,
                intent,
                // Legacy Session states can be stale and are reconciled from
                // their latest Run. Canonical session/3.0 status is authority.
                status: effective_status(&raw_status, &latest_run, &session_dir, is_v3),
                project: project_name.clone(),
                project_path: Some(normalize_path(wf_root)),
                active_run_ids: all_active_run_ids,
                active_run_id: session_json
                    .as_ref()
                    .and_then(|value| compatible_active_run_id(value, &runs)),
                latest_completed_run_id: session_json
                    .as_ref()
                    .and_then(|value| str_field(value, "latest_completed_run_id"))
                    .or_else(|| latest_completed_run_id(&runs)),
                orchestration_revision: session_json.as_ref().and_then(|value| {
                    value
                        .get("orchestration_revision")
                        .and_then(|revision| revision.as_i64())
                }),
                activity_revision: session_json.as_ref().and_then(|value| {
                    value
                        .get("activity_revision")
                        .and_then(|revision| revision.as_i64())
                }),
                created_at: session_json
                    .as_ref()
                    .and_then(|value| str_field(value, "created_at")),
                updated_at: session_json
                    .as_ref()
                    .and_then(|value| str_field(value, "updated_at")),
                run_count,
                latest_run,
            }
        })
        .collect();

    // Active execution first, then canonical Session activity timestamp.
    sessions.sort_by(|a, b| {
        let rank = |session: &SessionSummary| {
            if session.active_run_ids.is_empty() {
                status_rank(&session.status)
            } else {
                0
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| session_sort_timestamp(b).cmp(&session_sort_timestamp(a)))
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    sessions.truncate(40);
    sessions
}

/// Derive a display status without overriding canonical session/3.0 authority.
/// Legacy running/active states retain their compatibility reconciliation.
fn effective_status(
    raw: &str,
    latest: &Option<RunSummary>,
    dir: &Path,
    is_v3_session: bool,
) -> String {
    let s = raw.to_ascii_lowercase();
    if is_v3_session {
        return match s.as_str() {
            // Read tolerance for retired pre-simplification documents.
            "paused" => "open".into(),
            "open" | "completed" | "archived" | "failed" => s,
            _ => raw.to_string(),
        };
    }
    if s != "running" && s != "active" && s != "executing" {
        return raw.to_string();
    }
    match latest {
        Some(run) => match run.status.to_ascii_lowercase().as_str() {
            // run.json 的 running 也会陈旧（会话中断后未 seal）：started 超过 2 小时无
            // 新活动即视为陈旧 → 已封存
            "running" | "executing" | "active" => {
                let stale = run
                    .started_at
                    .as_deref()
                    .and_then(|iso| chrono::DateTime::parse_from_rfc3339(iso).ok())
                    .map(|t| {
                        t.signed_duration_since(chrono::Utc::now())
                            .num_minutes()
                            .unsigned_abs()
                            > 120
                    })
                    .unwrap_or(false);
                if stale {
                    "sealed".into()
                } else {
                    "running".into()
                }
            }
            "sealed" | "completed" | "done" => "sealed".into(),
            "failed" | "blocked" => "blocked".into(),
            "paused" => "paused".into(),
            "pending" => "pending".into(),
            "cancelled" => "cancelled".into(),
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
        "open" | "paused" => 1,
        "blocked" | "failed" => 2,
        _ => 3, // archived / sealed / completed / unknown
    }
}

/// 读取某会话的完整 run 列表（供前端展开）。
pub fn scan_runs(wf_root: &Path, session_id: &str) -> Vec<RunSummary> {
    let session_dir = wf_root.join("sessions").join(session_id);
    load_runs(&session_dir).0
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
            out.outputs.push(RunArtifactFile {
                name,
                size,
                preview,
            });
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
    fn parse_run_handles_run_v3_document() {
        let raw: serde_json::Value = serde_json::from_str(
            r#"{
              "schema_version": "run/3.0",
              "run_id": "20260812-001-v3",
              "session_id": "s-v3",
              "step_id": "step-1",
              "parent_run_id": null,
              "retry_of_run_id": null,
              "attempt": 1,
              "command": "maestro",
              "args": [],
              "goal": null,
              "status": "sealed",
              "revision": 3,
              "actor_id": "claude",
              "input_refs": [],
              "output_refs": ["art-1"],
              "primary_artifact_id": "art-1",
              "verdict": "done",
              "summary": "v3 run ok",
              "created_at": "2026-08-12T08:00:00Z",
              "started_at": "2026-08-12T08:01:00Z",
              "ended_at": "2026-08-12T08:05:00Z",
              "sealed_at": null
            }"#,
        )
        .unwrap();
        let run = parse_run(&raw);
        assert_eq!(run.run_id, "20260812-001-v3");
        assert_eq!(run.status, "sealed");
        assert_eq!(run.verdict.as_deref(), Some("done"));
        // run/3.0 的 command 是字符串（非对象）
        assert_eq!(run.command.as_deref(), Some("maestro"));
        // actor_id is identity, not a legacy execution platform.
        assert_eq!(run.actor_id.as_deref(), Some("claude"));
        assert_eq!(run.platform, None);
        assert_eq!(run.handoff_summary.as_deref(), Some("v3 run ok"));
        // 结束时间取 ended_at
        assert_eq!(run.completed_at.as_deref(), Some("2026-08-12T08:05:00Z"));
        assert_eq!(run.duration_secs, Some(240));
        assert_eq!(run.sequence, None);
        assert_eq!(run.revision, Some(3));
        assert_eq!(run.attempt, Some(1));
        assert_eq!(run.retry_of_run_id, None);
        assert!(run.concerns.is_empty() && run.decisions.is_empty() && run.gate_ids.is_empty());
    }

    #[test]
    fn parse_run_v3_running_run_has_no_duration() {
        let raw: serde_json::Value = serde_json::from_str(
            r#"{
              "schema_version": "run/3.0",
              "run_id": "20260812-002-v3",
              "session_id": "s-v3",
              "step_id": "step-2",
              "parent_run_id": null,
              "retry_of_run_id": null,
              "attempt": 1,
              "command": "verify",
              "args": [],
              "goal": null,
              "status": "running",
              "revision": 1,
              "actor_id": "pi",
              "input_refs": [],
              "output_refs": [],
              "primary_artifact_id": null,
              "verdict": null,
              "summary": null,
              "created_at": "2026-08-12T09:00:00Z",
              "started_at": "2026-08-12T09:00:00Z",
              "ended_at": null,
              "sealed_at": null
            }"#,
        )
        .unwrap();
        let run = parse_run(&raw);
        assert_eq!(run.status, "running");
        assert_eq!(run.verdict, None);
        assert_eq!(run.completed_at, None);
        assert_eq!(run.duration_secs, None);
        assert_eq!(run.command.as_deref(), Some("verify"));
    }

    #[test]
    fn scan_sessions_reads_v3_session_and_maps_fields() {
        let root = tmp_dir("v3-scan");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s-v3/runs/r-002")).unwrap();
        fs::write(
            wf.join("sessions/s-v3/session.json"),
            r#"{
              "schema_version": "session/3.0",
              "session_id": "s-v3",
              "objective": "v3 目标",
              "definition_of_done": "全部完成",
              "status": "open",
              "orchestration_revision": 1,
              "activity_revision": 5,
              "chain": [
                {"step_id":"step-1","command":"maestro","args":[],"status":"completed","run_ids":["r-001"],"goal_ref":null,"decision_ref":null,"decision_refs":[],"stage":null},
                {"step_id":"step-2","command":"verify","args":[],"status":"running","run_ids":["r-002"],"goal_ref":null,"decision_ref":null,"decision_refs":[],"stage":null}
              ],
              "decisions": [],
              "active_run_ids": ["r-002"],
              "artifacts_ref": "artifacts.json",
              "evidence_ref": "evidence.json",
              "created_at": "2026-08-12T08:00:00Z",
              "updated_at": "2026-08-12T09:00:00Z",
              "completed_at": null,
              "archived_at": null
            }"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s-v3/runs/r-002/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"r-002","status":"running","command":"verify","actor_id":"pi"}"#,
        )
        .unwrap();

        let sessions = scan_sessions(&wf);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.session_id, "s-v3");
        // objective → intent
        assert_eq!(s.intent.as_deref(), Some("v3 目标"));
        // Canonical lifecycle status remains distinct from execution activity.
        assert_eq!(s.status, "open");
        // active_run_ids[0] → active_run_id
        assert_eq!(s.active_run_id.as_deref(), Some("r-002"));
        assert_eq!(
            s.latest_run.as_ref().and_then(|r| r.command.as_deref()),
            Some("verify")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_session_detail_normalizes_v3_document() {
        let root = tmp_dir("v3-detail");
        let wf = root.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s-v3/runs/r-001")).unwrap();
        fs::write(
            wf.join("sessions/s-v3/session.json"),
            r#"{
              "schema_version": "session/3.0",
              "session_id": "s-v3",
              "objective": "v3 目标",
              "definition_of_done": "全部完成",
              "status": "completed",
              "orchestration_revision": 1,
              "activity_revision": 2,
              "chain": [
                {"step_id":"step-1","command":"maestro","args":[],"status":"completed","run_ids":["r-001"],"goal_ref":null,"decision_ref":null,"decision_refs":[],"stage":null}
              ],
              "decisions": [],
              "active_run_ids": [],
              "artifacts_ref": "artifacts.json",
              "evidence_ref": "evidence.json",
              "created_at": "2026-08-12T08:00:00Z",
              "updated_at": "2026-08-12T10:00:00Z",
              "completed_at": "2026-08-12T10:00:00Z",
              "archived_at": null
            }"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s-v3/runs/r-001/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"r-001","status":"sealed","command":"maestro","actor_id":"claude","verdict":"done","ended_at":"2026-08-12T10:00:00Z"}"#,
        )
        .unwrap();

        let detail = scan_session_detail(&wf, "s-v3").unwrap();
        assert_eq!(detail.session.intent.as_deref(), Some("v3 目标"));
        // completed → sealed（展示为已封存）
        assert_eq!(detail.session.status, "completed");
        assert_eq!(detail.session.active_run_id, None);
        // 编排链：保留全量 run_ids，兼容 run_id 指向最新追加的 retry。
        let orchestration = detail.orchestration.unwrap();
        assert_eq!(orchestration["engine"], "chain-v3");
        assert_eq!(orchestration["chain"][0]["run_id"], "r-001");
        assert_eq!(orchestration["chain"][0]["command"], "maestro");
        // 边界契约：objective → In Scope，DoD 独立字段
        let boundary = detail.boundary_contract.unwrap();
        assert_eq!(boundary["definition_of_done"], "全部完成");
        assert_eq!(boundary["in_scope"][0], "v3 目标");
        // lifecycle：completed_at → sealed_at（收据卡展示封存时间）
        let lifecycle = detail.lifecycle.unwrap();
        assert_eq!(lifecycle["sealed_at"], "2026-08-12T10:00:00Z");
        // run/3.0 解析进时间线
        assert_eq!(detail.runs.len(), 1);
        assert_eq!(detail.runs[0].verdict.as_deref(), Some("done"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_v3_preserves_concurrency_retries_decisions_and_statuses() {
        let root = tmp_dir("v3-current-state");
        let wf = root.join(".workflow");
        let session_dir = wf.join("sessions/hash-session");
        for run_id in [
            "z-started-running",
            "y-ended-completed",
            "a-created-pending",
            "b-created-cancelled",
        ] {
            fs::create_dir_all(session_dir.join("runs").join(run_id)).unwrap();
        }
        fs::write(
            session_dir.join("session.json"),
            r#"{
              "schema_version":"session/3.0",
              "session_id":"hash-session",
              "objective":"read canonical state",
              "definition_of_done":"state is lossless",
              "status":"open",
              "orchestration_revision":7,
              "activity_revision":11,
              "chain":[{
                "step_id":"retry-step","command":"verify","args":[],"status":"running",
                "run_ids":["a-created-pending","z-started-running"],
                "goal_ref":null,"decision_ref":"decision-gate","decision_refs":["decision-note"],"stage":"verify"
              }],
              "decisions":[{
                "decision_id":"decision-gate","after_step_id":"retry-step",
                "status":"open","evidence_refs":["EVD-1"]
              }],
              "active_run_ids":["a-created-pending","z-started-running"],
              "artifacts_ref":"artifacts.json","evidence_ref":"evidence.json",
              "created_at":"2026-08-12T08:00:00Z","updated_at":"2026-08-12T13:01:00Z",
              "completed_at":null,"archived_at":null
            }"#,
        )
        .unwrap();
        fs::write(
            session_dir.join("runs/z-started-running/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"z-started-running","status":"running","command":"verify","actor_id":"actor-old","revision":1,"attempt":1,"retry_of_run_id":null,"started_at":"2020-01-01T09:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            session_dir.join("runs/y-ended-completed/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"y-ended-completed","status":"completed","command":"verify","actor_id":"actor-done","ended_at":"2026-08-12T11:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            session_dir.join("runs/a-created-pending/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"a-created-pending","status":"pending","command":"verify","actor_id":"actor-next","revision":2,"attempt":2,"retry_of_run_id":"z-started-running","created_at":"2026-08-12T12:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            session_dir.join("runs/b-created-cancelled/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"b-created-cancelled","status":"cancelled","command":"verify","actor_id":"actor-cancel","created_at":"2026-08-12T13:00:00Z","ended_at":"2026-08-12T13:01:00Z"}"#,
        )
        .unwrap();

        let detail = scan_session_detail(&wf, "hash-session").unwrap();
        assert_eq!(
            detail
                .runs
                .iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "z-started-running",
                "y-ended-completed",
                "a-created-pending",
                "b-created-cancelled"
            ]
        );
        assert_eq!(detail.runs[0].status, "running");
        assert_eq!(detail.runs[2].status, "pending");
        assert_eq!(detail.runs[3].status, "cancelled");
        assert_eq!(detail.runs[2].actor_id.as_deref(), Some("actor-next"));
        assert_eq!(detail.runs[2].attempt, Some(2));
        assert_eq!(
            detail.runs[2].retry_of_run_id.as_deref(),
            Some("z-started-running")
        );
        assert_eq!(detail.runs[2].platform, None);
        assert_eq!(detail.session.status, "open");
        assert_eq!(
            detail.session.active_run_ids,
            vec!["a-created-pending", "z-started-running"]
        );
        assert_eq!(
            detail.session.active_run_id.as_deref(),
            Some("a-created-pending")
        );
        assert_eq!(
            detail.session.latest_completed_run_id.as_deref(),
            Some("y-ended-completed")
        );
        assert_eq!(
            detail.session.latest_run.as_ref().unwrap().status,
            "cancelled"
        );
        assert_eq!(detail.session.orchestration_revision, Some(7));
        assert_eq!(detail.session.activity_revision, Some(11));
        assert_eq!(detail.decisions.len(), 1);
        assert_eq!(detail.decisions[0]["decision_id"], "decision-gate");
        let orchestration = detail.orchestration.unwrap();
        assert_eq!(orchestration["orchestration_revision"], 7);
        assert_eq!(orchestration["activity_revision"], 11);
        assert_eq!(
            orchestration["chain"][0]["run_ids"],
            serde_json::json!(["a-created-pending", "z-started-running"])
        );
        assert_eq!(orchestration["chain"][0]["run_id"], "a-created-pending");
        assert_eq!(orchestration["chain"][0]["decision_ref"], "decision-gate");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_runs_uses_timestamps_with_deterministic_id_fallback() {
        let root = tmp_dir("v3-run-sort");
        let wf = root.join(".workflow");
        let runs_dir = wf.join("sessions/s1/runs");
        for run_id in ["z-no-time", "a-no-time", "z-older", "a-newer"] {
            fs::create_dir_all(runs_dir.join(run_id)).unwrap();
        }
        fs::write(
            runs_dir.join("z-no-time/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"z-no-time","status":"pending"}"#,
        )
        .unwrap();
        fs::write(
            runs_dir.join("a-no-time/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"a-no-time","status":"pending"}"#,
        )
        .unwrap();
        fs::write(
            runs_dir.join("z-older/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"z-older","status":"sealed","created_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            runs_dir.join("a-newer/run.json"),
            r#"{"schema_version":"run/3.0","run_id":"a-newer","status":"sealed","created_at":"2026-02-01T00:00:00Z"}"#,
        )
        .unwrap();

        let runs = scan_runs(&wf, "s1");
        assert_eq!(
            runs.iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-no-time", "z-no-time", "z-older", "a-newer"]
        );
        let (latest, count) = load_latest_run(&wf.join("sessions/s1"));
        assert_eq!(count, 4);
        assert_eq!(latest.unwrap().run_id, "a-newer");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_sessions_orders_hash_ids_by_latest_run_timestamp() {
        let root = tmp_dir("v3-session-sort");
        let wf = root.join(".workflow");
        for (session_id, run_id, created_at) in [
            ("zzz-older-session", "a-hash", "2026-01-01T00:00:00Z"),
            ("aaa-newer-session", "z-hash", "2026-02-01T00:00:00Z"),
        ] {
            let session_dir = wf.join("sessions").join(session_id);
            fs::create_dir_all(session_dir.join("runs").join(run_id)).unwrap();
            fs::write(
                session_dir.join("session.json"),
                format!(
                    r#"{{"schema_version":"session/3.0","session_id":"{session_id}","objective":"sort","status":"completed","active_run_ids":[]}}"#
                ),
            )
            .unwrap();
            fs::write(
                session_dir.join("runs").join(run_id).join("run.json"),
                format!(
                    r#"{{"schema_version":"run/3.0","run_id":"{run_id}","status":"sealed","created_at":"{created_at}"}}"#
                ),
            )
            .unwrap();
        }

        let no_run_dir = wf.join("sessions/000-recent-no-run");
        fs::create_dir_all(&no_run_dir).unwrap();
        fs::write(
            no_run_dir.join("session.json"),
            r#"{"schema_version":"session/3.0","session_id":"000-recent-no-run","objective":"recent decision","status":"completed","active_run_ids":[],"created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T00:00:00Z"}"#,
        )
        .unwrap();

        let sessions = scan_sessions(&wf);
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0].session_id, "000-recent-no-run");
        assert_eq!(sessions[1].session_id, "aaa-newer-session");
        assert_eq!(sessions[2].session_id, "zzz-older-session");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_run_preserves_every_canonical_v3_status() {
        for status in [
            "pending",
            "running",
            "blocked",
            "completed",
            "failed",
            "cancelled",
            "sealed",
        ] {
            let run = parse_run(&serde_json::json!({
                "schema_version": "run/3.0",
                "run_id": format!("run-{status}"),
                "status": status,
                "actor_id": "actor-v3"
            }));
            assert_eq!(run.status, status);
            assert_eq!(run.actor_id.as_deref(), Some("actor-v3"));
            assert_eq!(run.platform, None);
        }
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
        assert_eq!(run.actor_id, None);
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
        assert_eq!(detail.session.project_path, Some(normalize_path(&wf)));
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
        fs::write(
            wf.join("sessions/s1/runs/r1/outputs/findings.json"),
            "{\"a\":1}",
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s1/runs/r1/outputs/note.txt"),
            "hello preview",
        )
        .unwrap();
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
        assert_eq!(
            read_run_output(&wf, "s1", "r1", "ok.json").as_deref(),
            Some("fine")
        );
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
