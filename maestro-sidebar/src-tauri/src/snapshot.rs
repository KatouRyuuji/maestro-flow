// 运行时快照聚合：只聚合当前激活工作空间的 Session/Run 状态、Agent 调用、知识统计，
// 并生成「语义指纹」用于判断前端可见状态是否变化（避免无谓重渲染）。
use serde::{Deserialize, Serialize};

use crate::activity::{self, AgentCall};
use crate::auto;
use crate::config;
use crate::config::AppConfig;
use crate::knowledge::{self, KnowledgeStats};
use crate::workflow::{self, ProjectInfo, SessionSummary};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeSnapshot {
    pub workspace: Option<String>,
    pub active_session_id: Option<String>,
    pub generated_at: i64,
    pub sessions: Vec<SessionSummary>,
    pub calls: Vec<AgentCall>,
    pub knowledge: KnowledgeStats,
    /// 高频知识摘要（learning 行 command/frequency/lastUsed 的哈希）。
    /// 纳入指纹后，行内频率更新也能触发 snapshot-changed，前端据此失效高频知识缓存。
    /// 旧版缓存文件无此字段 → serde(default) 兼容反序列化。
    #[serde(default)]
    pub learning_top_digest: String,
    /// 待沉淀候选（run 级 knowledge-delta.json 聚合）。旧缓存无此字段 → default 兼容。
    #[serde(default)]
    pub pending_candidates: knowledge::PendingCandidates,
}

/// 全部可用工程（.workflow 目录）：用户配置 roots ∪ 自动发现。
pub fn all_projects(cfg: &AppConfig) -> Vec<std::path::PathBuf> {
    let mut projects = workflow::discover_projects(&cfg.roots);
    // 自动识别：Agent 调用过且含 .workflow 的项目无需手动配置
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    projects
}

/// 解析当前激活工程：cfg.active_root 精确匹配；无/失效时回退 roots[0] 或第一个可用工程。
pub fn resolve_active<'a>(
    cfg: &AppConfig,
    projects: &'a [std::path::PathBuf],
) -> Option<&'a std::path::PathBuf> {
    if projects.is_empty() {
        return None;
    }
    if let Some(ar) = &cfg.active_root {
        let arn = config::normalize_path(&std::path::PathBuf::from(ar));
        if let Some(p) = projects.iter().find(|p| config::normalize_path(p) == arn) {
            return Some(p);
        }
    }
    if let Some(first_root) = cfg.roots.first() {
        let expanded = config::expand_home(first_root);
        let wf = expanded.join(".workflow");
        if let Some(p) = projects
            .iter()
            .find(|p| config::normalize_path(p) == config::normalize_path(&wf))
        {
            return Some(p);
        }
    }
    projects.first()
}

/// 构建快照：单工程模式扫描激活工程；全局模式扫描全部工程。
/// 所有扫描失败都降级为空数据而非报错。
pub fn build_snapshot(cfg: &AppConfig) -> RuntimeSnapshot {
    let mut projects = all_projects(cfg);
    if !cfg.global_mode {
        let active = resolve_active(cfg, &projects);
        if let Some(a) = active {
            projects = vec![a.clone()];
        } else {
            projects = Vec::new();
        }
    }
    let mut sessions: Vec<SessionSummary> = Vec::new();
    let mut knowledge = KnowledgeStats::default();
    let mut workspace: Option<String> = None;
    let mut active_session_id: Option<String> = None;
    let mut learning_top_digest = String::new();
    let mut pending_candidates = knowledge::PendingCandidates::default();

    for wf in projects {
        let info: ProjectInfo = workflow::project_info(&wf);
        if workspace.is_none() {
            workspace = Some(info.name.clone());
            active_session_id = info.active_session_id.clone();
        }
        let s = workflow::scan_sessions_with_project(&wf, Some(info.name.as_str()));
        sessions.extend(s);
        let k = knowledge::scan_knowledge(&wf);
        knowledge.specs += k.specs;
        knowledge.memory += k.memory;
        knowledge.knowhow += k.knowhow;
        knowledge.learning_rows += k.learning_rows;
        knowledge.issue_rows += k.issue_rows;
        // 与 get_top_knowledge 同源（激活工程 learning 统计）
        learning_top_digest = knowledge::learning_top_digest(&wf);
        // 待沉淀候选（仅激活工程；跨工程聚合由调用方扩展）
        let cand = knowledge::scan_pending_candidates(&wf);
        pending_candidates.total += cand.total;
        for c in cand.items {
            pending_candidates.items.push(c);
        }
    }
    // 跨工程合并后排序：运行中 > 暂停 > 失败/阻塞 > 已封存，组内 session_id 倒序（新在前）
    sessions.sort_by(|a, b| {
        workflow::status_rank(&a.status)
            .cmp(&workflow::status_rank(&b.status))
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    // 全局模式容纳更多会话（多工程合并且未截断前）；单工程维持 40 上限
    let session_cap = if cfg.global_mode { 80 } else { 40 };
    sessions.truncate(session_cap);
    knowledge.total = knowledge.specs
        + knowledge.memory
        + knowledge.knowhow
        + knowledge.learning_rows
        + knowledge.issue_rows;

    let calls = activity::scan_calls(&crate::config::cli_history_dir(), 20);

    // 候选跨工程合并后统一截断（保序：先到的工程优先）
    if pending_candidates.items.len() > 50 {
        pending_candidates.items.truncate(50);
    }

    RuntimeSnapshot {
        workspace,
        active_session_id,
        generated_at: now_seconds(),
        sessions,
        calls,
        knowledge,
        learning_top_digest,
        pending_candidates,
    }
}

pub fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// 语义指纹：快照可见字段的稳定序列化。缺字段会导致该字段变化时前端不重渲染。
pub fn snapshot_fingerprint(snapshot: &RuntimeSnapshot) -> String {
    // 用 serde_json 序列化再哈希 —— 结构字段齐全时等价于逐字段指纹
    let sessions = serde_json::to_string(&snapshot.sessions).unwrap_or_default();
    let calls: Vec<&AgentCall> = snapshot.calls.iter().collect();
    let calls = serde_json::to_string(&calls).unwrap_or_default();
    let knowledge = serde_json::to_string(&snapshot.knowledge).unwrap_or_default();
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        snapshot.workspace.as_deref().unwrap_or(""),
        snapshot.active_session_id.as_deref().unwrap_or(""),
        sessions,
        calls,
        knowledge,
        snapshot.learning_top_digest,
        serde_json::to_string(&snapshot.pending_candidates).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RuntimeSnapshot {
        RuntimeSnapshot {
            workspace: Some("demo".into()),
            active_session_id: Some("s1".into()),
            generated_at: 100,
            sessions: vec![],
            calls: vec![],
            knowledge: KnowledgeStats {
                specs: 3,
                ..Default::default()
            },
            learning_top_digest: String::new(),
            pending_candidates: Default::default(),
        }
    }

    #[test]
    fn fingerprint_stable_for_unchanged() {
        let a = sample();
        assert_eq!(snapshot_fingerprint(&a), snapshot_fingerprint(&a));
    }

    #[test]
    fn fingerprint_changes_on_knowledge_or_state_change() {
        let a = sample();
        let mut b = sample();
        b.knowledge.specs = 4;
        assert_ne!(snapshot_fingerprint(&a), snapshot_fingerprint(&b));

        let mut c = sample();
        c.active_session_id = Some("s2".into());
        assert_ne!(snapshot_fingerprint(&a), snapshot_fingerprint(&c));

        // 高频知识摘要变化（行内频率更新）必须改变指纹 → 触发 snapshot-changed
        let mut d = sample();
        d.learning_top_digest = "deadbeef".into();
        assert_ne!(snapshot_fingerprint(&a), snapshot_fingerprint(&d));
    }

    #[test]
    fn old_cache_without_digest_field_still_deserializes() {
        // 旧版 snapshot-cache.json 无 learning_top_digest 字段 → serde(default) 兼容
        let raw = r#"{"workspace":"demo","active_session_id":null,"generated_at":100,"sessions":[],"calls":[],"knowledge":{"specs":1,"memory":0,"knowhow":0,"learning_rows":0,"issue_rows":0,"total":1}}"#;
        let parsed: RuntimeSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.learning_top_digest, "");
    }
}
