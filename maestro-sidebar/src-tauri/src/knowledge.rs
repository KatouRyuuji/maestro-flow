// 知识积累统计与条目列表：.workflow/ 下各类知识产物的计数 + 可浏览条目
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
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
    /// learning 行使用频次（CLI 统计）；其他类型为 None。
    pub frequency: Option<u64>,
}

const KIND_ORDER: [&str; 5] = ["specs", "memory", "knowhow", "learning", "issues"];
const MAX_PER_KIND: usize = 50;
/// 高频统计扫描上限：learning 行是使用统计，行数可能远超展示上限，不能截断。
const LEARNING_SCAN_LIMIT: usize = 100_000;

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
                        // learning 行无自有 id：支持合成 id `{command}-{稳定 hash}` 匹配
                        // （hash 由 command 派生，不随 frequency 变化；旧 `{command}-{freq}` 格式不再匹配）
                        let matches = if kind == "learning" {
                            let synth = row_id.is_empty()
                                && id
                                    .rsplit_once('-')
                                    .map(|(cmd, suffix)| {
                                        v.get("command").and_then(|x| x.as_str()) == Some(cmd)
                                            && learning_synth_id(cmd).ends_with(suffix)
                                    })
                                    .unwrap_or(false);
                            row_id == id || synth
                        } else {
                            row_id == id
                        };
                        if matches {
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
                        frequency: None,
                    });
                }
            }
            "learning" => out.extend(read_jsonl_entries(
                &wf_root.join("learning"),
                "learning",
                jsonl_learning_entry,
                MAX_PER_KIND,
            )),
            "issues" => out.extend(read_jsonl_entries(
                &wf_root.join("issues"),
                "issues",
                jsonl_issue_entry,
                MAX_PER_KIND,
            )),
            _ => {}
        }
    }
    out
}

fn read_jsonl_entries<F>(dir: &Path, kind: &str, mapper: F, limit: usize) -> Vec<KnowledgeEntry>
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
        for line in raw.lines().take(limit) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                out.push(mapper(&value, kind));
                if out.len() >= limit {
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
        frequency: None,
    }
}

/// learning 合成 id：`{command}-{fnv1a64(command) 前 8 hex}`。
/// 稳定于 command（不随 frequency 变化），避免频次更新后详情/编辑 id 失效。
fn learning_synth_id(command: &str) -> String {
    format!("{command}-{}", &fnv1a64_hex(command.as_bytes())[..8])
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
        id: learning_synth_id(&s("command")),
        title: s("command"),
        summary,
        tags,
        status: "active".to_string(),
        updated: nonempty(s("lastUsed")),
        priority: None,
        frequency: Some(freq),
    }
}

/// 高频知识沉淀：learning 行按使用频次倒序取前 N 条（跨工程合并由调用方完成）。
/// 读取不设 50 行展示上限：频率统计必须覆盖全部行，否则高频行被截断会失真。
pub fn scan_top_learning(wf_root: &Path, limit: usize) -> Vec<KnowledgeEntry> {
    let mut items = read_jsonl_entries(
        &wf_root.join("learning"),
        "learning",
        jsonl_learning_entry,
        LEARNING_SCAN_LIMIT,
    );
    items.sort_by(|a, b| {
        b.frequency
            .unwrap_or(0)
            .cmp(&a.frequency.unwrap_or(0))
            .then_with(|| a.title.cmp(&b.title))
    });
    items.truncate(limit);
    items
}

/// 高频知识摘要：全部 learning 行 (command, frequency, lastUsed) 的稳定哈希。
/// 供 snapshot 指纹使用 —— 行数不变但频次/时间变化时也能触发 snapshot-changed，
/// 使前端高频知识面板及时刷新（不再依赖行数变化）。
pub fn learning_top_digest(wf_root: &Path) -> String {
    let mut items = scan_top_learning(wf_root, LEARNING_SCAN_LIMIT);
    // 显式排序保证确定性：frequency 倒序、title 升序（与面板排序一致）
    items.sort_by(|a, b| {
        b.frequency
            .unwrap_or(0)
            .cmp(&a.frequency.unwrap_or(0))
            .then_with(|| a.title.cmp(&b.title))
    });
    let mut s = String::new();
    for item in items.iter() {
        s.push_str(item.title.as_str());
        s.push(':');
        s.push_str(&item.frequency.unwrap_or(0).to_string());
        s.push(':');
        s.push_str(item.updated.as_deref().unwrap_or(""));
        s.push(',');
    }
    fnv1a64_hex(s.as_bytes())
}

/// FNV-1a 64 位哈希（确定性、无外部依赖），hex 编码。
fn fnv1a64_hex(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
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
                    tags = v.trim().trim_start_matches('-').trim().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
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
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default()
        });
    (id, title, summary, tags, status, updated)
}

/// 写入知识条目内容（md 全文覆盖 / jsonl 行替换），返回错误信息。
pub fn write_knowledge_item(wf_root: &Path, kind: &str, id: &str, content: &str) -> Result<(), String> {
    match kind {
        "specs" | "memory" | "knowhow" => {
            let path = wf_root.join(kind).join(format!("{id}.md"));
            fs::write(&path, content).map_err(|e| e.to_string())
        }
        "learning" | "issues" => {
            // 校验 content 是单行 JSON
            let value: serde_json::Value = serde_json::from_str(content)
                .map_err(|e| format!("内容不是合法 JSON：{e}"))?;
            let line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
            let dir = wf_root.join(kind);
            let Ok(entries) = fs::read_dir(&dir) else {
                return Err("目录不存在".into());
            };
            let mut files: Vec<_> = entries.flatten().collect();
            files.sort_by_key(|e| e.file_name());
            for entry in files {
                let p = entry.path();
                let is_jsonl = entry
                    .file_name()
                    .to_str()
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false);
                if !p.is_file() || !is_jsonl {
                    continue;
                }
                let Ok(raw) = fs::read_to_string(&p) else { continue };
                let mut replaced = false;
                let mut out = String::new();
                for l in raw.lines() {
                    let t = l.trim();
                    if t.is_empty() {
                        out.push_str(l);
                        out.push('\n');
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
                        out.push_str(l);
                        out.push('\n');
                        continue;
                    };
                    let row_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                    if row_id == id {
                        out.push_str(&line);
                        out.push('\n');
                        replaced = true;
                    } else {
                        out.push_str(l);
                        out.push('\n');
                    }
                }
                if replaced {
                    return fs::write(&p, out).map_err(|e| e.to_string());
                }
            }
            Err("未找到匹配条目".into())
        }
        _ => Err("不支持的条目类型".into()),
    }
}

/// 删除知识条目（md 文件 / jsonl 行）。
pub fn delete_knowledge_item(wf_root: &Path, kind: &str, id: &str) -> Result<(), String> {
    match kind {
        "specs" | "memory" | "knowhow" => {
            let path = wf_root.join(kind).join(format!("{id}.md"));
            if !path.exists() {
                return Err("条目不存在".into());
            }
            fs::remove_file(&path).map_err(|e| e.to_string())
        }
        "learning" | "issues" => {
            let dir = wf_root.join(kind);
            let Ok(entries) = fs::read_dir(&dir) else {
                return Err("目录不存在".into());
            };
            let mut files: Vec<_> = entries.flatten().collect();
            files.sort_by_key(|e| e.file_name());
            for entry in files {
                let p = entry.path();
                let is_jsonl = entry
                    .file_name()
                    .to_str()
                    .map(|n| n.ends_with(".jsonl"))
                    .unwrap_or(false);
                if !p.is_file() || !is_jsonl {
                    continue;
                }
                let Ok(raw) = fs::read_to_string(&p) else { continue };
                let mut removed = false;
                let mut out = String::new();
                for l in raw.lines() {
                    let t = l.trim();
                    if t.is_empty() {
                        out.push_str(l);
                        out.push('\n');
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
                        out.push_str(l);
                        out.push('\n');
                        continue;
                    };
                    let row_id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                    if row_id == id {
                        removed = true; // 跳过该行
                    } else {
                        out.push_str(l);
                        out.push('\n');
                    }
                }
                if removed {
                    return fs::write(&p, out).map_err(|e| e.to_string());
                }
            }
            Err("未找到匹配条目".into())
        }
        _ => Err("不支持的条目类型".into()),
    }
}

/// 新建 md 知识条目（specs/memory/knowhow），返回生成的 id。
pub fn create_knowledge_md(
    wf_root: &Path,
    kind: &str,
    title: &str,
    content: &str,
) -> Result<String, String> {
    if !["specs", "memory", "knowhow"].contains(&kind) {
        return Err("仅支持 specs / memory / knowhow".into());
    }
    let dir = wf_root.join(kind);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // id：kind-YYYYMMDD-HHMMSS-短slug
    let now = chrono::Local::now();
    let ts = now.format("%Y%m%d-%H%M%S").to_string();
    let slug = title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect::<String>()
        .to_ascii_lowercase();
    let id = format!("{kind}-{ts}-{slug}");
    let body = format!("---\ntitle: \"{}\"\n---\n\n{}\n", title.replace('"', "\\\""), content.trim());
    fs::write(dir.join(format!("{id}.md")), body).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 待沉淀候选（run 级 knowledge-delta.json 的 KDC 行）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingCandidate {
    pub session_id: String,
    pub run_id: String,
    pub candidate_id: String,
    pub target: String, // spec | knowhow
    pub action: String, // propose | ...
    pub title: String,
    pub summary: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingCandidates {
    pub total: usize,
    pub items: Vec<PendingCandidate>,
}

const PENDING_CANDIDATE_LIMIT: usize = 50;
const PENDING_SUMMARY_CHARS: usize = 220;

/// 扫描全部 run 级 knowledge-delta.json 的候选（KDC-*），按 updated_at 倒序。
/// 处置状态（已 promote）由会话详情 lifecycle 收据判断；此处聚合待展示候选。
pub fn scan_pending_candidates(wf_root: &Path) -> PendingCandidates {
    let sessions_dir = wf_root.join("sessions");
    let Ok(sessions) = fs::read_dir(&sessions_dir) else {
        return PendingCandidates::default();
    };
    let mut all: Vec<PendingCandidate> = Vec::new();
    for s in sessions.flatten() {
        let session_path = s.path();
        if !session_path.is_dir() {
            continue;
        }
        let Some(session_id) = s.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let runs_dir = session_path.join("runs");
        let Ok(runs) = fs::read_dir(&runs_dir) else {
            continue;
        };
        for r in runs.flatten() {
            let delta_path = r.path().join("knowledge-delta.json");
            let Ok(raw) = fs::read_to_string(&delta_path) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(cands) = v.get("candidates").and_then(|c| c.as_array()) else {
                continue;
            };
            let run_id = v
                .get("run_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let updated_at = v
                .get("updated_at")
                .and_then(|x| x.as_str())
                .map(str::to_owned);
            for c in cands {
                let cid = c
                    .get("candidate_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if cid.is_empty() {
                    continue;
                }
                let content = c
                    .get("content")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let summary = content
                    .chars()
                    .take(PENDING_SUMMARY_CHARS)
                    .collect::<String>()
                    .replace(['\n', '\r'], " ");
                all.push(PendingCandidate {
                    session_id: session_id.clone(),
                    run_id: run_id.clone(),
                    candidate_id: cid,
                    target: c
                        .get("target")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    action: c
                        .get("action")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    title: c
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    summary,
                    updated_at: updated_at.clone(),
                });
            }
        }
    }
    // 确定性排序：updated_at 倒序 → session_id 倒序 → candidate_id
    all.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.session_id.cmp(&a.session_id))
            .then_with(|| a.candidate_id.cmp(&b.candidate_id))
    });
    let total = all.len();
    all.truncate(PENDING_CANDIDATE_LIMIT);
    PendingCandidates { total, items: all }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("maestro-sidebar-kb-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_learning(dir: &Path, rows: &[(&str, u64)]) {
        fs::create_dir_all(dir.join("learning")).unwrap();
        let mut out = String::new();
        for (cmd, freq) in rows {
            out.push_str(&format!(
                r#"{{"command":"{cmd}","frequency":{freq},"successRate":1,"avgDuration":1000,"lastUsed":"2026-07-01T00:00:00Z"}}"#,
            ));
            out.push('\n');
        }
        fs::write(dir.join("learning/patterns.jsonl"), out).unwrap();
    }

    #[test]
    fn scan_pending_candidates_aggregates_deltas() {
        let dir = tmp_dir("pending");
        let wf = dir.join(".workflow");
        fs::create_dir_all(wf.join("sessions/s1/runs/r1")).unwrap();
        fs::create_dir_all(wf.join("sessions/s2/runs/r1")).unwrap();
        fs::write(
            wf.join("sessions/s1/runs/r1/knowledge-delta.json"),
            r#"{"schema_version":"run-knowledge-delta/1.0","session_id":"s1","run_id":"r1","updated_at":"2026-08-01T00:00:00Z","candidates":[{"candidate_id":"KDC-a","target":"spec","action":"propose","title":"Pattern A","content":"body A"}]}"#,
        )
        .unwrap();
        fs::write(
            wf.join("sessions/s2/runs/r1/knowledge-delta.json"),
            r#"{"schema_version":"run-knowledge-delta/1.0","session_id":"s2","run_id":"r1","updated_at":"2026-08-02T00:00:00Z","candidates":[{"candidate_id":"KDC-b","target":"knowhow","action":"propose","title":"Pattern B","content":"body B"},{"candidate_id":"KDC-c","target":"spec","action":"propose","title":"Pattern C"}]}"#,
        )
        .unwrap();

        let result = scan_pending_candidates(&wf);
        assert_eq!(result.total, 3);
        assert_eq!(result.items.len(), 3);
        // updated_at 倒序：s2 在前
        assert_eq!(result.items[0].candidate_id, "KDC-b");
        assert_eq!(result.items[0].target, "knowhow");
        assert_eq!(result.items[0].session_id, "s2");
        assert_eq!(result.items[2].candidate_id, "KDC-a");
        assert_eq!(result.items[2].summary, "body A");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_top_learning_sorts_by_frequency() {
        let dir = tmp_dir("top");
        write_learning(&dir, &[("gemini", 3), ("claude-code", 9), ("codex", 5)]);
        let top = scan_top_learning(&dir, 2);
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].title, "claude-code");
        assert_eq!(top[0].frequency, Some(9));
        assert_eq!(top[1].title, "codex");
        // 截断
        let all = scan_top_learning(&dir, 10);
        assert_eq!(all.len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_top_learning_reads_beyond_50_rows() {
        // 回归：展示上限 MAX_PER_KIND=50 曾截断高频统计，第 51+ 行的最高频命令会丢失。
        let dir = tmp_dir("beyond50");
        let mut rows: Vec<(&str, u64)> = (0..60)
            .map(|i| {
                let cmd: &'static str = Box::leak(format!("cmd-{i:02}").into_boxed_str());
                (cmd, (i % 7) as u64 + 1)
            })
            .collect();
        rows[59] = ("top-cmd", 999);
        write_learning(&dir, &rows);
        let top = scan_top_learning(&dir, 3);
        assert_eq!(top[0].title, "top-cmd");
        assert_eq!(top[0].frequency, Some(999));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn learning_top_digest_tracks_frequency_and_usage_time() {
        let dir = tmp_dir("digest");
        write_learning(&dir, &[("claude-code", 9), ("codex", 5)]);
        let d1 = learning_top_digest(&dir);
        assert_eq!(d1, learning_top_digest(&dir), "digest 必须确定");
        // 行数不变、仅 frequency 变化 → digest 变化
        write_learning(&dir, &[("claude-code", 10), ("codex", 5)]);
        let d2 = learning_top_digest(&dir);
        assert_ne!(d1, d2, "frequency 变化必须改变 digest");
        // 行数变化 → digest 变化
        write_learning(&dir, &[("claude-code", 10), ("codex", 5), ("gemini", 3)]);
        let d3 = learning_top_digest(&dir);
        assert_ne!(d2, d3, "新增行必须改变 digest");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_learning_content_by_synthetic_id() {
        let dir = tmp_dir("synth");
        write_learning(&dir, &[("gemini", 3), ("claude-code", 9)]);
        let item = read_knowledge_item_content(&dir, "learning", &learning_synth_id("claude-code"));
        assert!(item.is_some());
        let item = item.unwrap();
        assert_eq!(item.id, learning_synth_id("claude-code"));
        assert_eq!(item.title, "claude-code");
        assert!(item.content.contains("claude-code"));
        // 不存在的合成 id → None
        assert!(read_knowledge_item_content(&dir, "learning", &learning_synth_id("claude-codeX")).is_none());
        // 旧 `{command}-{frequency}` 格式不再匹配
        assert!(read_knowledge_item_content(&dir, "learning", "claude-code-9").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn learning_synth_id_is_stable_across_frequency_changes() {
        // frequency 变化后合成 id 不变：详情/编辑引用不会失效（原 {command}-{freq} 缺陷回归）
        assert_eq!(learning_synth_id("claude-code"), learning_synth_id("claude-code"));
        let dir = tmp_dir("stable");
        fs::create_dir_all(dir.join("learning")).unwrap();
        let row = |freq: u64| {
            format!(
                r#"{{"command":"gemini","frequency":{freq},"successRate":1,"avgDuration":1000,"lastUsed":"2026-07-01T00:00:00Z"}}"#
            )
        };
        fs::write(dir.join("learning/patterns.jsonl"), format!("{}\n{}\n", row(3), row(9))).unwrap();
        // 同一 command 两行共享同一合成 id，任一频率下都能读到（取最先匹配行）
        let item = read_knowledge_item_content(&dir, "learning", &learning_synth_id("gemini"));
        assert!(item.is_some());
        assert_eq!(item.unwrap().title, "gemini");
        let _ = fs::remove_dir_all(&dir);
    }
}
