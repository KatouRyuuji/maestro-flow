// Agent 调用扫描：~/.maestro/cli-history/*.meta.json
//
// 每条记录是一次 CLI 代理调用（claude-code / codex / gemini / qwen / opencode），
// 元数据含 tool、model、mode、prompt、startedAt、exitCode 等。
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
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
    pub stream_bytes: u64,
    pub last_activity_ms: Option<u64>,
    pub last_entry_type: Option<String>,
    pub last_output_preview: Option<String>,
    /// token_usage 条目累计（视窗内：快照用 64KB 尾部，详情用全量/1MB）。
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Default)]
struct StreamSummary {
    bytes: u64,
    modified_ms: Option<u64>,
    last_entry_type: Option<String>,
    output_preview: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
}

const STREAM_TAIL_BYTES: u64 = 64 * 1024;
const LIVE_DETAIL_TAIL_BYTES: u64 = 1024 * 1024;
const OUTPUT_PREVIEW_CHARS: usize = 220;

fn tail_chars(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    let start = chars.len().saturating_sub(limit);
    chars[start..].iter().collect::<String>().trim().to_owned()
}

/// Read only the tail of the JSONL stream (or the full stream when `tail` is
/// None). Size/mtime make stream progress part of the snapshot fingerprint
/// while the preview gives the UI useful live text; token_usage rows are
/// accumulated into the token totals.
fn read_stream_summary(path: &Path, tail: Option<u64>) -> StreamSummary {
    let Ok(mut file) = fs::File::open(path) else {
        return StreamSummary::default();
    };
    let Ok(meta) = file.metadata() else {
        return StreamSummary::default();
    };
    let bytes = meta.len();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64);
    let start = match tail {
        Some(limit) => bytes.saturating_sub(limit),
        None => 0,
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return StreamSummary {
            bytes,
            modified_ms,
            ..Default::default()
        };
    }

    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return StreamSummary {
            bytes,
            modified_ms,
            ..Default::default()
        };
    }
    let mut raw = String::from_utf8_lossy(&buffer).into_owned();
    if start > 0 {
        if let Some(first_newline) = raw.find('\n') {
            raw = raw[first_newline + 1..].to_owned();
        }
    }

    let mut assistant_output = String::new();
    let mut last_entry_type = None;
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let entry_type = value.get("type").and_then(|item| item.as_str());
        if let Some(entry_type) = entry_type {
            last_entry_type = Some(entry_type.to_owned());
        }
        match entry_type {
            Some("assistant_message") => {
                if let Some(content) = value.get("content").and_then(|item| item.as_str()) {
                    assistant_output.push_str(content);
                }
            }
            Some("token_usage") => {
                input_tokens += value
                    .get("inputTokens")
                    .and_then(|item| item.as_u64())
                    .unwrap_or(0);
                output_tokens += value
                    .get("outputTokens")
                    .and_then(|item| item.as_u64())
                    .unwrap_or(0);
            }
            _ => {}
        }
    }

    let output_preview = tail_chars(&assistant_output, OUTPUT_PREVIEW_CHARS);
    StreamSummary {
        bytes,
        modified_ms,
        last_entry_type,
        output_preview: (!output_preview.is_empty()).then_some(output_preview),
        input_tokens,
        output_tokens,
    }
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
        let stream = read_stream_summary(&dir.join(format!("{}.jsonl", call.exec_id)), Some(STREAM_TAIL_BYTES));
        call.stream_bytes = stream.bytes;
        call.last_activity_ms = stream.modified_ms;
        call.last_entry_type = stream.last_entry_type;
        call.last_output_preview = stream.output_preview;
        call.input_tokens = stream.input_tokens;
        call.output_tokens = stream.output_tokens;
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
    pub name: Option<String>,
    pub status: Option<String>,
    pub result: Option<String>,
    pub message: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CallDetail {
    pub call: AgentCall,
    pub entries: Vec<CallEntry>,
}

fn read_jsonl_entries(path: &Path, tail_bytes: Option<u64>) -> Vec<CallEntry> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let start = tail_bytes
        .map(|limit| bytes.saturating_sub(limit))
        .unwrap_or(0);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return Vec::new();
    }
    let mut jsonl = String::from_utf8_lossy(&buffer).into_owned();
    if start > 0 {
        if let Some(first_newline) = jsonl.find('\n') {
            jsonl = jsonl[first_newline + 1..].to_owned();
        } else {
            return Vec::new();
        }
    }
    jsonl
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            (!line.is_empty())
                .then(|| serde_json::from_str::<CallEntry>(line).ok())
                .flatten()
        })
        .collect()
}

/// Read one call's metadata and entries. Completed calls retain their full
/// history; active calls use a bounded tail because this path refreshes often.
pub fn read_call_detail(dir: &Path, exec_id: &str) -> Option<CallDetail> {
    let meta_raw = fs::read_to_string(dir.join(format!("{exec_id}.meta.json"))).ok()?;
    let mut call: AgentCall = serde_json::from_str(&meta_raw).ok()?;
    call.exec_id = exec_id.to_owned();
    let jsonl_path = dir.join(format!("{exec_id}.jsonl"));
    let is_active = call.completed_at.is_none() && call.exit_code.is_none();
    // 已完成调用：全量统计 token（尾部视窗可能截掉早期 token_usage 行）；
    // 活跃调用：1MB 视窗（与对话条目一致）。
    let stream = read_stream_summary(&jsonl_path, if is_active { Some(LIVE_DETAIL_TAIL_BYTES) } else { None });
    call.stream_bytes = stream.bytes;
    call.last_activity_ms = stream.modified_ms;
    call.last_entry_type = stream.last_entry_type;
    call.last_output_preview = stream.output_preview;
    call.input_tokens = stream.input_tokens;
    call.output_tokens = stream.output_tokens;
    // Full prompt remains available in the detail view.

    let tail_bytes = is_active.then_some(LIVE_DETAIL_TAIL_BYTES);
    let entries = read_jsonl_entries(&jsonl_path, tail_bytes);
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
    fn scan_calls_includes_live_stream_summary() {
        let dir = tmp_dir("stream");
        fs::write(
            dir.join("pi-123.meta.json"),
            r#"{"execId":"pi-123","tool":"pi","mode":"analysis","prompt":"test","startedAt":"2026-08-11T08:00:00Z"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("pi-123.jsonl"),
            concat!(
                "{\"type\":\"assistant_message\",\"content\":\"Hello\",\"partial\":true}\n",
                "{\"type\":\"assistant_message\",\"content\":\" world\",\"partial\":true}\n",
                "{\"type\":\"token_usage\",\"inputTokens\":1,\"outputTokens\":2}\n"
            ),
        )
        .unwrap();

        let calls = scan_calls(&dir, 10);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].stream_bytes > 0);
        assert!(calls[0].last_activity_ms.is_some());
        assert_eq!(calls[0].last_entry_type.as_deref(), Some("token_usage"));
        assert_eq!(calls[0].last_output_preview.as_deref(), Some("Hello world"));
        assert_eq!(calls[0].input_tokens, 1);
        assert_eq!(calls[0].output_tokens, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_call_detail_full_scan_accumulates_all_token_rows() {
        let dir = tmp_dir("tokens-full");
        fs::write(
            dir.join("pi-tok.meta.json"),
            r#"{"execId":"pi-tok","tool":"pi","mode":"analysis","prompt":"test","startedAt":"2026-08-11T08:00:00Z","completedAt":"2026-08-11T08:01:00Z","exitCode":0}"#,
        )
        .unwrap();
        // token_usage 行位于流首部：全量统计必须能跨过尾部视窗读到。
        let rows = concat!(
            "{\"type\":\"token_usage\",\"inputTokens\":100,\"outputTokens\":50}\n",
            "{\"type\":\"assistant_message\",\"content\":\"middle\"}\n",
            "{\"type\":\"token_usage\",\"inputTokens\":7,\"outputTokens\":3}\n",
            "{\"type\":\"assistant_message\",\"content\":\"tail\"}\n"
        );
        fs::write(dir.join("pi-tok.jsonl"), rows).unwrap();

        let detail = read_call_detail(&dir, "pi-tok").unwrap();
        assert_eq!(detail.call.input_tokens, 107);
        assert_eq!(detail.call.output_tokens, 53);
        let _ = fs::remove_dir_all(&dir);
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

    #[test]
    fn read_jsonl_entries_uses_complete_lines_from_tail() {
        let dir = tmp_dir("detail-tail");
        let path = dir.join("live.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant_message\",\"content\":\"old\"}\n",
                "{\"type\":\"assistant_message\",\"content\":\"middle\"}\n",
                "{\"type\":\"assistant_message\",\"content\":\"latest\"}\n"
            ),
        )
        .unwrap();

        let entries = read_jsonl_entries(&path, Some(90));
        assert!(!entries.is_empty());
        assert_eq!(
            entries.last().and_then(|entry| entry.content.as_deref()),
            Some("latest")
        );
        assert!(entries
            .iter()
            .all(|entry| entry.content.as_deref() != Some("old")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_call_detail_bounds_only_active_history() {
        let dir = tmp_dir("active-detail");
        fs::write(
            dir.join("pi-live.meta.json"),
            r#"{"execId":"pi-live","tool":"pi","mode":"analysis","prompt":"test","startedAt":"2026-08-11T08:00:00Z"}"#,
        )
        .unwrap();
        let old = format!(
            "{{\"type\":\"assistant_message\",\"content\":\"{}\"}}\n",
            "x".repeat(LIVE_DETAIL_TAIL_BYTES as usize)
        );
        fs::write(
            dir.join("pi-live.jsonl"),
            format!("{old}{{\"type\":\"assistant_message\",\"content\":\"latest\"}}\n"),
        )
        .unwrap();

        let detail = read_call_detail(&dir, "pi-live").unwrap();
        assert_eq!(detail.entries.len(), 1);
        assert_eq!(detail.entries[0].content.as_deref(), Some("latest"));
        let _ = fs::remove_dir_all(&dir);
    }
}