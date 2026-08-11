// 知识积累统计与条目列表：.workflow/ 下各类知识产物的计数 + 可浏览条目
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct KnowledgeStats {
    pub specs: u64,
    pub memory: u64,
    pub knowhow: u64,
    pub learning_rows: u64,
    pub issue_rows: u64,
    pub total: u64,
}

/// 知识条目（详情页列表行）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    pub kind: String, // specs | memory | knowhow | learning | issues
    pub id: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub status: String,
    pub updated: Option<String>,
    pub priority: Option<String>,
}

const KIND_ORDER: [&str; 5] = ["specs", "memory", "knowhow", "learning", "issues"];
const MAX_PER_KIND: usize = 50;

fn count_files(dir: &Path, ext: &str) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.path().is_file()
                && e.file_name()
                    .to_str()
                    .map(|n| n.ends_with(ext))
                    .unwrap_or(false)
        })
        .count() as u64
}

fn count_jsonl_rows(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut rows = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_jsonl = entry
            .file_name()
            .to_str()
            .map(|n| n.ends_with(".jsonl"))
            .unwrap_or(false);
        if !path.is_file() || !is_jsonl {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            rows += raw.lines().filter(|l| !l.trim().is_empty()).count() as u64;
        }
    }
    rows
}

pub fn scan_knowledge(wf_root: &Path) -> KnowledgeStats {
    let specs = count_files(&wf_root.join("specs"), ".md");
    let memory = count_files(&wf_root.join("memory"), ".md");
    let knowhow = count_files(&wf_root.join("knowhow"), ".md");
    let learning_rows = count_jsonl_rows(&wf_root.join("learning"));
    let issue_rows = count_jsonl_rows(&wf_root.join("issues"));
    KnowledgeStats {
        specs,
        memory,
        knowhow,
        learning_rows,
        issue_rows,
        total: specs + memory + knowhow + learning_rows + issue_rows,
    }
}

/// 单条知识条目全文（md 或 jsonl 行）
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItemContent {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub status: String,
    pub updated: Option<String>,
    pub priority: Option<String>,
    pub tags: Vec<String>,
    pub content: String,
}

/// 按 kind+id 读取条目全文；md 返回 markdown 全文，jsonl 返回格式化 JSON。
pub fn read_knowledge_item_content(
    wf_root: &Path,
    kind: &str,
    id: &str,
) -> Option<KnowledgeItemContent> {
    match kind {
        "specs" | "memory" | "knowhow" => {
            let path = wf_root.join(kind).join(format!("{id}.md"));
            let raw = fs::read_to_string(&path).ok()?;
            let (_, title, _, tags, status, updated) = read_md_entry(&path);
            Some(KnowledgeItemContent {
                kind: kind.to_string(),
                id: id.to_string(),
                title,
                status,
                updated,
                priority: None,
                tags,
                content: raw,
            })
        }
        "learning" | "issues" => {
            let dir = wf_root.join(kind);
            let Ok(entries) = fs::read_dir(&dir) else {
                return None;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                let is_jsonl = entry
                    .file_name()
                    .to_str()
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false);
                if !p.is_file() || !is_jsonl {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(&p) {
                    for line in raw.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                            continue;
                        };
                        let row_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                        if row_id == id {
                            let entry = if kind == "issues" {
                                jsonl_issue_entry(&v, kind)
                            } else {
                                jsonl_learning_entry(&v, kind)
                            };
                            let pretty = serde_json::to_string_pretty(&v)
                                .unwrap_or_else(|_| line.to_string());
                            return Some(KnowledgeItemContent {
                                kind: kind.to_string(),
                                id: id.to_string(),
                                title: entry.title,
                                status: entry.status,
                                updated: entry.updated,
                                priority: entry.priority,
                                tags: entry.tags,
                                content: pretty,
                            });
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// 扫描一个工程的知识条目（按五类分组，每类最多 MAX_PER_KIND，按文件名/行序）。
pub fn scan_knowledge_items(wf_root: &Path) -> Vec<KnowledgeEntry> {
    let mut out: Vec<KnowledgeEntry> = Vec::new();
    for kind in KIND_ORDER {
        match kind {
            "specs" | "memory" | "knowhow" => {
                let dir = wf_root.join(kind);
                let Ok(entries) = fs::read_dir(&dir) else {
                    continue;
                };
                let mut files: Vec<_> = entries
                    .flatten()
                    .filter(|e| {
                        e.path().is_file()
                            && e.file_name()
                                .to_str()
                                .map(|n| n.ends_with(".md"))
                                .unwrap_or(false)
                    })
                    .collect();
                files.sort_by_key(|e| e.file_name());
                for entry in files.into_iter().take(MAX_PER_KIND) {
                    let (id, title, summary, tags, status, updated) =
                        read_md_entry(&entry.path());
                    out.push(KnowledgeEntry {
                        kind: kind.to_string(),
                        id,
                        title,
                        summary,
                        tags,
                        status,
                        updated,
                        priority: None,
                    });
                }
            }
            "learning" => out.extend(read_jsonl_entries(
                &wf_root.join("learning"),
                "learning",
                jsonl_learning_entry,
            )),
            "issues" => out.extend(read_jsonl_entries(
                &wf_root.join("issues"),
                "issues",
                jsonl_issue_entry,
            )),
            _ => {}
        }
    }
    out
}

fn read_jsonl_entries<F>(dir: &Path, kind: &str, mapper: F) -> Vec<KnowledgeEntry>
where
    F: Fn(&serde_json::Value, &str) -> KnowledgeEntry,
{
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| {
            e.path().is_file()
                && e.file_name()
                    .to_str()
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false)
        })
        .collect();
    files.sort_by_key(|e| e.file_name());
    for file in files {
        let Ok(raw) = fs::read_to_string(file.path()) else {
            continue;
        };
        for line in raw.lines().take(MAX_PER_KIND) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                out.push(mapper(&value, kind));
                if out.len() >= MAX_PER_KIND {
                    return out;
                }
            }
        }
    }
    out
}

/// issues 行 → 条目（id/title/status/priority/tags/updated）
fn jsonl_issue_entry(v: &serde_json::Value, kind: &str) -> KnowledgeEntry {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let tags: Vec<String> = v
        .get("tags")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(|t| t.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let priority = s("priority");
    KnowledgeEntry {
        kind: kind.to_string(),
        id: s("id"),
        title: s("title"),
        summary: s("context"),
        tags,
        status: s("status"),
        updated: nonempty(s("updated_at")).or_else(|| nonempty(s("created_at"))),
        priority: nonempty(priority),
    }
}

/// learning 行（CLI 使用统计）→ 条目
fn jsonl_learning_entry(v: &serde_json::Value, kind: &str) -> KnowledgeEntry {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let freq = num("frequency") as u64;
    let rate = num("successRate");
    let avg = num("avgDuration");
    let mut summary = format!("使用 {freq} 次 · 成功率 {:.0}%", rate * 100.0);
    if avg > 0.0 {
        summary.push_str(&format!(" · 平均 {:.0}s", avg / 1000.0));
    }
    let tags: Vec<String> = v
        .get("contexts")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(|t| t.to_string()))
                .collect()
        })
        .unwrap_or_default();
    KnowledgeEntry {
        kind: kind.to_string(),
        id: format!("{}-{}", s("command"), freq),
        title: s("command"),
        summary,
        tags,
        status: "active".to_string(),
        updated: nonempty(s("lastUsed")),
        priority: None,
    }
}

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// md 条目：frontmatter title/keywords + 首行 # 标题 + 正文摘录；updated 取 mtime
fn read_md_entry(path: &Path) -> (String, String, String, Vec<String>, String, Option<String>) {
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let Ok(raw) = fs::read_to_string(path) else {
        return (id.clone(), id, String::new(), Vec::new(), "active".to_string(), None);
    };
    let mut title = String::new();
    let mut tags = Vec::new();
    let mut status = "active".to_string();
    let mut body_start = 0usize;
    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        if let Some(end) = raw[4..].find("\n---") {
            let fm_end = 4 + end;
            let fm = &raw[..fm_end];
            body_start = fm_end + 4;
            for line in fm.lines().skip(1) {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("title:") {
                    title = v.trim().trim_matches('"').trim().to_string();
                } else if let Some(v) = line.strip_prefix("keywords:") {
                    // 后续缩进行均为列表项
                    tags = v.trim().trim_start_matches('-').trim().to_string().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                } else if let Some(v) = line.strip_prefix("status:") {
                    status = v.trim().trim_matches('"').to_string();
                } else if let Some(v) = line.strip_prefix("readMode:") {
                    let m = v.trim().trim_matches('"').to_string();
                    if m == "required" || m == "optional" {
                        status = m;
                    }
                }
            }
        }
    }
    let body = &raw[body_start.min(raw.len())..];
    if title.is_empty() {
        for line in body.lines() {
            let t = line.trim();
            if let Some(h) = t.strip_prefix("# ") {
                title = h.trim().to_string();
                break;
            }
        }
    }
    if title.is_empty() {
        title = id.clone();
    }
    // 摘录：去代码块、压缩空白，前 180 字符
    let mut summary = String::new();
    let mut in_code = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') {
            continue;
        }
        summary.push_str(t);
        summary.push(' ');
        if summary.len() > 180 {
            break;
        }
    }
    let summary = summary.trim().to_string();
    let updated = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let secs = t
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // 与前端 fmtAgo 兼容的 ISO 字符串
            let dt = chrono::DateTime::from_timestamp(secs, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default();
            dt
        });
    (id, title, summary, tags, status, updated)
}
