// 知识积累统计：.workflow/ 下各类知识产物的文件/行数计数
use serde::Serialize;
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
        total: specs + memory + knowhow + learning_rows,
    }
}
