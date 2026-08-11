// Agent 调用扫描：~/.maestro/cli-history/*.meta.json
//
// 每条记录是一次 CLI 代理调用（claude-code / codex / gemini / qwen / opencode），
// 元数据含 tool、model、mode、prompt、startedAt、exitCode 等。
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCall {
    pub exec_id: String,
    pub tool: String,
    pub model: Option<String>,
    pub mode: String,
    pub prompt: String,
    pub work_dir: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub exit_code: Option<i64>,
    pub async_delegate: bool,
    pub delegate_status: Option<String>,
}

/// 扫描 cli-history 目录，返回最近 N 条调用（按 mtime 新→旧）。
/// 性能：先 stat 排序（目录项元数据），只解析前若干候选文件，避免全量 JSON 解析。
pub fn scan_calls(dir: &Path, limit: usize) -> Vec<AgentCall> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    // 阶段 1：只收集 (mtime, path)，不读内容
    let mut candidates: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.ends_with(".meta.json") {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) else {
            continue;
        };
        candidates.push((since_epoch.as_millis() as u64, path));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    // 阶段 2：只解析最新的候选（limit × 3，过滤空壳后足够）
    let mut metas: Vec<(u64, AgentCall)> = Vec::new();
    for (mtime, path) in candidates.into_iter().take(limit * 3) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut call) = serde_json::from_str::<AgentCall>(&raw) else {
            continue;
        };
        // 空壳 meta（写入中断/占位文件：关键字段全空）不展示
        if call.started_at.is_empty()
            && call.completed_at.is_none()
            && call.prompt.is_empty()
            && call.model.as_deref().unwrap_or("").is_empty()
        {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        call.exec_id = name.trim_end_matches(".meta.json").to_owned();
        // 大 prompt 截断保护（前端展示摘要）
        if call.prompt.chars().count() > 400 {
            call.prompt = call.prompt.chars().take(400).collect();
        }
        metas.push((mtime, call));
        if metas.len() >= limit {
            break;
        }
    }
    metas.into_iter().map(|(_, c)| c).collect()
}

// ---------------------------------------------------------------------------
// 调用详情：meta + 对话条目
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CallEntry {
    pub id: Option<String>,
    pub r#type: Option<String>,
    pub content: Option<String>,
    pub timestamp: Option<String>,
    pub partial: Option<bool>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CallDetail {
    pub call: AgentCall,
    pub entries: Vec<CallEntry>,
}

/// 读取单条调用的 meta + JSONL 对话条目。
pub fn read_call_detail(dir: &Path, exec_id: &str) -> Option<CallDetail> {
    let meta_raw = fs::read_to_string(dir.join(format!("{exec_id}.meta.json"))).ok()?;
    let mut call: AgentCall = serde_json::from_str(&meta_raw).ok()?;
    call.exec_id = exec_id.to_owned();
    // 完整 prompt 不做截断（详情视图展示全文）

    let mut entries: Vec<CallEntry> = Vec::new();
    if let Ok(jsonl) = fs::read_to_string(dir.join(format!("{exec_id}.jsonl"))) {
        for line in jsonl.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<CallEntry>(line) {
                entries.push(entry);
            }
        }
    }
    Some(CallDetail { call, entries })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "maestro-sidebar-act-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_calls_empty_dir() {
        let dir = tmp_dir("empty");
        assert!(scan_calls(&dir, 10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_calls_parses_meta_and_truncates_prompt() {
        let dir = tmp_dir("parse");
        let long_prompt = "x".repeat(1000);
        fs::write(
            dir.join("abc-123.meta.json"),
            format!(
                r#"{{"execId":"abc-123","tool":"claude-code","model":"claude-sonnet","mode":"analysis","prompt":"{long_prompt}","workDir":"/w","startedAt":"2026-07-23T08:00:00Z","exitCode":0}}"#
            ),
        )
        .unwrap();
        fs::write(dir.join("not-meta.txt"), "{}").unwrap();
        fs::write(dir.join("broken.meta.json"), "{invalid").unwrap();

        let calls = scan_calls(&dir, 10);
        assert_eq!(calls.len(), 1);
        let c = &calls[0];
        assert_eq!(c.exec_id, "abc-123");
        assert_eq!(c.tool, "claude-code");
        assert_eq!(c.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(c.exit_code, Some(0));
        assert!(c.prompt.chars().count() <= 400);
        let _ = fs::remove_dir_all(&dir);
    }
}
