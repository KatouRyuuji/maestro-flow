// 运行时快照聚合：跨所有工程合并 Session/Run 状态、Agent 调用、知识统计，
// 并生成「语义指纹」用于判断前端可见状态是否变化（避免无谓重渲染）。
use serde::Serialize;

use crate::activity::{self, AgentCall};
use crate::auto;
use crate::config::AppConfig;
use crate::knowledge::{self, KnowledgeStats};
use crate::workflow::{self, ProjectInfo, SessionSummary};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuntimeSnapshot {
    pub workspace: Option<String>,
    pub active_session_id: Option<String>,
    pub generated_at: i64,
    pub sessions: Vec<SessionSummary>,
    pub calls: Vec<AgentCall>,
    pub knowledge: KnowledgeStats,
}

/// 构建快照：扫描所有工程并聚合。所有扫描失败都降级为空数据而非报错。
/// 工程来源 = 用户配置 roots ∪ 自动发现（cli-history workDir 含 .workflow）。
pub fn build_snapshot(cfg: &AppConfig) -> RuntimeSnapshot {
    let mut projects = workflow::discover_projects(&cfg.roots);
    // 自动识别：Agent 调用过且含 .workflow 的项目无需手动配置
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    let mut sessions: Vec<SessionSummary> = Vec::new();
    let mut knowledge = KnowledgeStats::default();
    let mut workspace: Option<String> = None;
    let mut active_session_id: Option<String> = None;

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
    }
    // 跨工程合并后排序：运行中 > 暂停 > 失败/阻塞 > 已封存，组内 session_id 倒序（新在前）
    sessions.sort_by(|a, b| {
        workflow::status_rank(&a.status)
            .cmp(&workflow::status_rank(&b.status))
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    sessions.truncate(40);
    knowledge.total = knowledge.specs
        + knowledge.memory
        + knowledge.knowhow
        + knowledge.learning_rows
        + knowledge.issue_rows;

    let calls = activity::scan_calls(&crate::config::cli_history_dir(), 20);

    RuntimeSnapshot {
        workspace,
        active_session_id,
        generated_at: now_seconds(),
        sessions,
        calls,
        knowledge,
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
        "{}|{}|{}|{}|{}",
        snapshot.workspace.as_deref().unwrap_or(""),
        snapshot.active_session_id.as_deref().unwrap_or(""),
        sessions,
        calls,
        knowledge
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
    }
}
