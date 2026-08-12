// Maestro Sidebar — 常驻桌面的 Maestro 观察者
//
// 架构（对齐 trellis-card）：
//   - RuntimeCoordinator：250ms trailing debounce + 串行快照重建 + 指纹对比，
//     仅在可见状态变化时向前端 emit snapshot-changed。
//   - watcher + 10s reconcile：文件变化 / 定时触发 rebuild。
//   - 托盘常驻：关闭窗口 = 隐藏；卡片 ↔ 胶囊双形态。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod activity;
pub mod auto;
pub mod config;
pub mod knowledge;
mod snapshot;
pub mod workflow;
mod watch;

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};

use config::AppConfig;
use snapshot::{RuntimeSnapshot, snapshot_fingerprint, all_projects, resolve_active};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RuntimeStore {
    last_snapshot: Option<RuntimeSnapshot>,
    last_emitted_fingerprint: Option<String>,
}

/// 独立编辑器窗口的文档 tab
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorTab {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub content: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub tabs: Vec<EditorTab>,
    pub active: i64,
}

fn open_or_refresh_editor_tab(editor: &mut EditorState, incoming: EditorTab) {
    if let Some(index) = editor
        .tabs
        .iter()
        .position(|tab| tab.kind == incoming.kind && tab.id == incoming.id)
    {
        editor.active = index as i64;
        if editor.tabs[index].dirty {
            // A disk refresh may update the label, but never replace a draft.
            editor.tabs[index].title = incoming.title;
        } else {
            editor.tabs[index] = incoming;
        }
        return;
    }

    editor.tabs.push(incoming);
    editor.active = (editor.tabs.len() - 1) as i64;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_search_output_extracts_results() {
        let raw = r#"{"query":"agent","wikiCount":1,"codeCount":1,"count":2,"results":[
          {"source":"wiki","kind":"note","name":"A","detail":"d1","rank":0.5,"score":1,"snippet":"s1","summary":"sum1"},
          {"source":"code","kind":"class","name":"B","detail":"d2","rank":0.4,"score":0.8,"snippet":"","summary":""}
        ]}"#;
        let out = parse_search_output(raw);
        assert_eq!(out.count, 2);
        assert_eq!(out.wiki_count, 1);
        assert_eq!(out.results.len(), 2);
        assert_eq!(out.results[0].source, "wiki");
        assert_eq!(out.results[0].kind, "note");
        assert_eq!(out.results[0].rank, 0.5);
        assert_eq!(out.results[1].name, "B");
        assert!(out.error.is_none());
    }

    #[test]
    fn parse_search_output_handles_invalid_json() {
        let out = parse_search_output("not json");
        assert!(out.error.is_some());
        assert!(out.results.is_empty());
    }
}

#[cfg(test)]
mod editor_state_tests {
    use super::*;

    fn tab(content: &str, dirty: bool) -> EditorTab {
        EditorTab {
            kind: "specs".into(),
            id: "coding".into(),
            title: "Coding".into(),
            content: content.into(),
            dirty,
        }
    }

    #[test]
    fn refresh_preserves_dirty_editor_content() {
        let mut state = EditorState {
            tabs: vec![tab("draft", true)],
            active: 0,
        };
        open_or_refresh_editor_tab(&mut state, tab("disk", false));
        assert_eq!(state.tabs[0].content, "draft");
        assert!(state.tabs[0].dirty);
    }

    #[test]
    fn refresh_reloads_clean_editor_content() {
        let mut state = EditorState {
            tabs: vec![tab("old", false)],
            active: 0,
        };
        open_or_refresh_editor_tab(&mut state, tab("disk", false));
        assert_eq!(state.tabs[0].content, "disk");
        assert!(!state.tabs[0].dirty);
    }
}

#[derive(Debug, Clone, Copy)]
struct DockState {
    edge: DockEdge,
    visible_x: i32,
    visible_y: i32,
    hidden_x: i32,
    hidden_y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DockEdge {
    Left,
    Right,
    Top,
    Bottom,
}

impl DockEdge {
    fn label(self) -> &'static str {
        match self {
            DockEdge::Left => "left",
            DockEdge::Right => "right",
            DockEdge::Top => "top",
            DockEdge::Bottom => "bottom",
        }
    }
}

fn calculate_dock_state(
    window_pos: (i32, i32),
    window_size: (i32, i32),
    monitor_pos: (i32, i32),
    monitor_size: (i32, i32),
    threshold: i32,
    reveal_strip: i32,
) -> Option<DockState> {
    let (x, y) = window_pos;
    let (width, height) = window_size;
    let (monitor_x, monitor_y) = monitor_pos;
    let (monitor_width, monitor_height) = monitor_size;
    let monitor_right = monitor_x + monitor_width;
    let monitor_bottom = monitor_y + monitor_height;
    let distances = [
        (DockEdge::Left, (x - monitor_x).abs()),
        (DockEdge::Right, (x + width - monitor_right).abs()),
        (DockEdge::Top, (y - monitor_y).abs()),
        (DockEdge::Bottom, (y + height - monitor_bottom).abs()),
    ];
    let (edge, distance) = distances.into_iter().min_by_key(|(_, distance)| *distance)?;
    if distance > threshold {
        return None;
    }

    let max_x = (monitor_right - width).max(monitor_x);
    let max_y = (monitor_bottom - height).max(monitor_y);
    let clamped_x = x.clamp(monitor_x, max_x);
    let clamped_y = y.clamp(monitor_y, max_y);
    let (visible_x, visible_y, hidden_x, hidden_y) = match edge {
        DockEdge::Left => (
            monitor_x,
            clamped_y,
            monitor_x - width + reveal_strip,
            clamped_y,
        ),
        DockEdge::Right => (
            monitor_right - width,
            clamped_y,
            monitor_right - reveal_strip,
            clamped_y,
        ),
        DockEdge::Top => (
            clamped_x,
            monitor_y,
            clamped_x,
            monitor_y - height + reveal_strip,
        ),
        DockEdge::Bottom => (
            clamped_x,
            monitor_bottom - height,
            clamped_x,
            monitor_bottom - reveal_strip,
        ),
    };
    Some(DockState {
        edge,
        visible_x,
        visible_y,
        hidden_x,
        hidden_y,
    })
}

#[cfg(test)]
mod dock_state_tests {
    use super::*;

    const WINDOW: (i32, i32) = (380, 100);
    const MONITOR: (i32, i32) = (1920, 1080);

    fn dock(position: (i32, i32)) -> Option<DockState> {
        calculate_dock_state(position, WINDOW, (0, 0), MONITOR, 20, 8)
    }

    #[test]
    fn calculates_left_and_right_hidden_strips() {
        let left = dock((5, 200)).unwrap();
        assert_eq!(left.edge, DockEdge::Left);
        assert_eq!((left.visible_x, left.visible_y), (0, 200));
        assert_eq!((left.hidden_x, left.hidden_y), (-372, 200));

        let right = dock((1535, 300)).unwrap();
        assert_eq!(right.edge, DockEdge::Right);
        assert_eq!((right.visible_x, right.visible_y), (1540, 300));
        assert_eq!((right.hidden_x, right.hidden_y), (1912, 300));
    }

    #[test]
    fn calculates_top_and_bottom_hidden_strips() {
        let top = dock((500, 3)).unwrap();
        assert_eq!(top.edge, DockEdge::Top);
        assert_eq!((top.visible_x, top.visible_y), (500, 0));
        assert_eq!((top.hidden_x, top.hidden_y), (500, -92));

        let bottom = dock((500, 975)).unwrap();
        assert_eq!(bottom.edge, DockEdge::Bottom);
        assert_eq!((bottom.visible_x, bottom.visible_y), (500, 980));
        assert_eq!((bottom.hidden_x, bottom.hidden_y), (500, 1072));
    }

    #[test]
    fn ignores_positions_outside_the_dock_threshold() {
        assert!(dock((500, 400)).is_none());
    }
}

struct AppState {
    config: Mutex<AppConfig>,
    runtime: Mutex<RuntimeStore>,
    editor: Mutex<EditorState>,
    dock: Mutex<Option<DockState>>,
}

// ---------------------------------------------------------------------------
// RuntimeCoordinator — 串行 flush + trailing debounce
// ---------------------------------------------------------------------------

struct RuntimeCoordinator {
    tx: mpsc::Sender<()>,
}

const RUNTIME_DEBOUNCE_MS: u64 = 250;

impl RuntimeCoordinator {
    fn spawn(app: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<()>();
        let coord = RuntimeCoordinator { tx };
        std::thread::spawn(move || {
            loop {
                if rx.recv().is_err() {
                    return;
                }
                // trailing debounce
                loop {
                    match rx.recv_timeout(Duration::from_millis(RUNTIME_DEBOUNCE_MS)) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                flush_snapshot(&app);
            }
        });
        coord
    }

    fn request(&self) {
        let _ = self.tx.send(());
    }

    /// 供 watcher 模块发送重建信号。
    pub fn signal(&self) -> mpsc::Sender<()> {
        self.tx.clone()
    }
}

/// 单一 flush 路径：重建快照 → 指纹对比 → 有变化才 emit。
fn flush_snapshot(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let snapshot = snapshot::build_snapshot(&cfg);
    let fp = snapshot_fingerprint(&snapshot);

    let unchanged = {
        let mut runtime = state.runtime.lock().unwrap();
        runtime.last_snapshot = Some(snapshot.clone());
        runtime.last_emitted_fingerprint.as_deref() == Some(fp.as_str())
    };
    save_snapshot_cache(&snapshot);
    if unchanged {
        return;
    }
    state.runtime.lock().unwrap().last_emitted_fingerprint = Some(fp);
    let _ = app.emit("snapshot-changed", &snapshot);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigOut {
    configured: bool,
    roots: Vec<String>,
    always_on_top: bool,
    wallpaper: Option<String>,
    wallpaper_opacity: f64,
    active_root: Option<String>,
    global_mode: bool,
}

fn config_out(cfg: &AppConfig) -> ConfigOut {
    ConfigOut {
        configured: cfg.initialized || !cfg.roots.is_empty(),
        roots: cfg.roots.clone(),
        always_on_top: cfg.always_on_top,
        wallpaper: cfg.wallpaper.clone(),
        wallpaper_opacity: cfg.wallpaper_opacity_value(),
        active_root: cfg.active_root.clone(),
        global_mode: cfg.global_mode,
    }
}

fn save_state(state: &AppState) -> Result<(), String> {
    let cfg = state.config.lock().unwrap().clone();
    config::save(&cfg)
}

// ---------------------------------------------------------------------------
// 快照磁盘缓存：冷启动秒开（15s TTL 内直接返回缓存，后台 reconcile 持续刷新）
// ---------------------------------------------------------------------------

const SNAPSHOT_CACHE_TTL_SECS: i64 = 15;

fn snapshot_cache_path() -> std::path::PathBuf {
    config::app_config_dir().join("snapshot-cache.json")
}

fn load_snapshot_cache() -> Option<(i64, RuntimeSnapshot)> {
    let raw = std::fs::read_to_string(snapshot_cache_path()).ok()?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        generated_at: i64,
        snapshot: RuntimeSnapshot,
    }
    let env: Envelope = serde_json::from_str(&raw).ok()?;
    Some((env.generated_at, env.snapshot))
}

fn save_snapshot_cache(snapshot: &RuntimeSnapshot) {
    let data = serde_json::json!({
        "generated_at": snapshot.generated_at,
        "snapshot": snapshot,
    });
    if let Ok(text) = serde_json::to_string(&data) {
        let _ = std::fs::create_dir_all(config::app_config_dir());
        let _ = std::fs::write(snapshot_cache_path(), text);
    }
}

/// 当前激活工程（单工程模式：所有数据命令只作用于它）。
fn active_projects(cfg: &AppConfig) -> Vec<std::path::PathBuf> {
    let projects = all_projects(cfg);
    match resolve_active(cfg, &projects) {
        Some(p) => vec![p.clone()],
        None => Vec::new(),
    }
}

/// 可用工作空间列表（切换菜单用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    path: String,
    name: String,
    active: bool,
    source: String, // root | auto
}

#[tauri::command]
fn list_workspaces(state: tauri::State<AppState>) -> Vec<WorkspaceInfo> {
    let cfg = state.config.lock().unwrap().clone();
    let projects = all_projects(&cfg);
    let active = resolve_active(&cfg, &projects);
    let roots: Vec<String> = cfg.roots.iter().map(|r| config::normalize_path(&config::expand_home(r))).collect();
    projects
        .iter()
        .map(|p| {
            let path = config::normalize_path(p);
            let info = workflow::project_info(p);
            let name = if info.name.is_empty() {
                p.parent()
                    .and_then(|d| d.file_name())
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                info.name
            };
            WorkspaceInfo {
                path: path.clone(),
                name,
                active: active == Some(p),
                source: if roots.contains(&path) { "root".into() } else { "auto".into() },
            }
        })
        .collect()
}

/// 切换激活工作空间（path 必须是可用工程之一）
#[tauri::command]
fn set_active_root(app: tauri::AppHandle, state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let cfg = state.config.lock().unwrap().clone();
    let projects = all_projects(&cfg);
    let target = config::normalize_path(&std::path::PathBuf::from(path));
    let matched = projects.iter().any(|p| config::normalize_path(p) == target);
    if !matched {
        return Err("工作空间不在可用列表中".into());
    }
    state.config.lock().unwrap().active_root = Some(target);
    save_state(&state)?;
    // 立即重建快照并推送
    flush_snapshot(&app);
    Ok(())
}

#[tauri::command]
fn get_snapshot(state: tauri::State<AppState>) -> RuntimeSnapshot {
    // 1) 内存缓存（最近一次 flush/构建）
    if let Some(snapshot) = state.runtime.lock().unwrap().last_snapshot.clone() {
        return snapshot;
    }
    // 2) 磁盘缓存（15s 内新鲜 → 冷启动秒开）
    if let Some((generated_at, snapshot)) = load_snapshot_cache() {
        let now = snapshot::now_seconds();
        if now - generated_at < SNAPSHOT_CACHE_TTL_SECS {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.last_snapshot = Some(snapshot.clone());
            runtime.last_emitted_fingerprint = Some(snapshot_fingerprint(&snapshot));
            return snapshot;
        }
    }
    // 3) 全量构建 + 写缓存
    let cfg = state.config.lock().unwrap().clone();
    let snapshot = snapshot::build_snapshot(&cfg);
    let fp = snapshot_fingerprint(&snapshot);
    save_snapshot_cache(&snapshot);
    let mut runtime = state.runtime.lock().unwrap();
    runtime.last_snapshot = Some(snapshot.clone());
    runtime.last_emitted_fingerprint = Some(fp);
    snapshot
}

/// 防路径逃逸：session_id / exec_id 必须是不含路径分隔符的普通 ID。
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && !id.contains(['/', '\\'])
        && !id.contains('\0')
}

#[tauri::command]
fn get_session_runs(state: tauri::State<AppState>, session_id: String) -> Vec<workflow::RunSummary> {
    if !is_safe_id(&session_id) {
        return Vec::new();
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    for wf in projects {
        let runs = workflow::scan_runs(&wf, &session_id);
        if !runs.is_empty() {
            return runs;
        }
    }
    Vec::new()
}

#[tauri::command]
fn get_session_detail(
    state: tauri::State<AppState>,
    session_id: String,
) -> Option<workflow::SessionDetail> {
    if !is_safe_id(&session_id) {
        return None;
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    for wf in projects {
        if let Some(detail) = workflow::scan_session_detail(&wf, &session_id) {
            return Some(detail);
        }
    }
    None
}

/// run 产出物（report.md / outputs / 注册表计数）
#[tauri::command]
fn get_run_artifacts(
    state: tauri::State<AppState>,
    session_id: String,
    run_id: String,
) -> Option<workflow::RunArtifacts> {
    if !is_safe_id(&session_id) || !is_safe_id(&run_id) {
        return None;
    }
    let cfg = state.config.lock().unwrap().clone();
    for wf in active_projects(&cfg) {
        if let Some(a) = workflow::scan_run_artifacts(&wf, &session_id, &run_id) {
            return Some(a);
        }
    }
    None
}

/// 读取单个 output 文件全文（防路径逃逸）
#[tauri::command]
fn get_run_artifact_content(
    state: tauri::State<AppState>,
    session_id: String,
    run_id: String,
    name: String,
) -> Option<String> {
    if !is_safe_id(&session_id) || !is_safe_id(&run_id) {
        return None;
    }
    let cfg = state.config.lock().unwrap().clone();
    for wf in active_projects(&cfg) {
        if let Some(c) = workflow::read_run_output(&wf, &session_id, &run_id, &name) {
            return Some(c);
        }
    }
    None
}

/// 打开/激活编辑器 tab：读取内容 → 存入 state → 显示编辑器窗口 → 推送刷新事件。
#[tauri::command]
fn open_editor_tab(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    if !["specs", "memory", "knowhow", "learning", "issues"].contains(&kind.as_str())
        || !is_safe_id(&id)
    {
        return Err("无效的条目标识".into());
    }
    // 读取内容
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let wf = projects.first().ok_or("无激活工作空间")?;
    let item =
        knowledge::read_knowledge_item_content(wf, &kind, &id).ok_or("条目不存在或不可读")?;
    let mut editor = state.editor.lock().unwrap();
    open_or_refresh_editor_tab(
        &mut editor,
        EditorTab {
            kind: kind.clone(),
            id: id.clone(),
            title: item.title,
            content: item.content,
            dirty: false,
        },
    );
    drop(editor);
    // 显示窗口（预创建于 setup，仅 show/focus + 刷新事件）
    match app.get_webview_window("editor-win") {
        Some(win) => {
            eprintln!("[editor] show editor-win ({} tabs)", {
                let e = state.editor.lock().unwrap();
                e.tabs.len()
            });
            let _ = win.show();
            let _ = win.set_focus();
            // 兜底刷新（窗口页若错过 emit 则此处拉取；非 reload，避免历史卡死根因）
            let _ = win.eval("window.__refreshEditor && window.__refreshEditor()");
        }
        None => {
            eprintln!("[editor] editor-win 不存在！尝试运行时创建");
            match WebviewWindowBuilder::new(
                &app,
                "editor-win",
                WebviewUrl::App("editor.html".into()),
            )
            .title("Maestro Sidebar · 编辑器")
            .inner_size(820.0, 640.0)
            .min_inner_size(480.0, 320.0)
            .build()
            {
                Ok(_) => eprintln!("[editor] 运行时创建成功"),
                Err(e) => eprintln!("[editor] 运行时创建失败: {e}"),
            }
        }
    }
    let _ = app.emit("editor-updated", ());
    Ok(())
}

/// 编辑器窗口拉取全部 tab 状态
#[tauri::command]
fn get_editor_state(state: tauri::State<AppState>) -> EditorState {
    state.editor.lock().unwrap().clone()
}

/// 关闭编辑器 tab（窗口内）
#[tauri::command]
fn close_editor_tab(state: tauri::State<AppState>, index: i64) -> Result<(), String> {
    let mut editor = state.editor.lock().unwrap();
    if index < 0 || index >= editor.tabs.len() as i64 {
        return Err("索引越界".into());
    }
    editor.tabs.remove(index as usize);
    if editor.tabs.is_empty() {
        editor.active = -1;
    } else if editor.active >= editor.tabs.len() as i64 {
        editor.active = (editor.tabs.len() - 1) as i64;
    }
    Ok(())
}

/// 切换编辑器激活 tab（窗口内）
#[tauri::command]
fn set_editor_active(state: tauri::State<AppState>, index: i64) -> Result<(), String> {
    let mut editor = state.editor.lock().unwrap();
    if index < 0 || index >= editor.tabs.len() as i64 {
        return Err("索引越界".into());
    }
    editor.active = index;
    Ok(())
}

/// 编辑器窗口保存后同步内容回 state
#[tauri::command]
fn editor_synced(
    state: tauri::State<AppState>,
    kind: String,
    id: String,
    content: String,
) -> Result<(), String> {
    let mut editor = state.editor.lock().unwrap();
    if let Some(tab) = editor
        .tabs
        .iter_mut()
        .find(|t| t.kind == kind && t.id == id)
    {
        tab.content = content;
        tab.dirty = false;
    }
    Ok(())
}

/// Keep the authoritative in-memory draft current between window refreshes.
#[tauri::command]
fn editor_changed(
    state: tauri::State<AppState>,
    kind: String,
    id: String,
    content: String,
) -> Result<(), String> {
    let mut editor = state.editor.lock().unwrap();
    let tab = editor
        .tabs
        .iter_mut()
        .find(|tab| tab.kind == kind && tab.id == id)
        .ok_or("编辑器标签不存在")?;
    tab.content = content;
    tab.dirty = true;
    Ok(())
}

/// 更新知识条目内容（md 覆盖 / jsonl 行替换）
#[tauri::command]
fn update_knowledge_item(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    kind: String,
    id: String,
    content: String,
) -> Result<(), String> {
    if !["specs", "memory", "knowhow", "learning", "issues"].contains(&kind.as_str())
        || !is_safe_id(&id)
    {
        return Err("无效的条目标识".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let wf = projects.first().ok_or("无激活工作空间")?;
    knowledge::write_knowledge_item(wf, &kind, &id, &content)?;
    let _ = app.emit(
        "knowledge-updated",
        serde_json::json!({ "kind": kind, "id": id }),
    );
    Ok(())
}

/// 删除知识条目
#[tauri::command]
fn delete_knowledge_item(
    state: tauri::State<AppState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    if !["specs", "memory", "knowhow", "learning", "issues"].contains(&kind.as_str())
        || !is_safe_id(&id)
    {
        return Err("无效的条目标识".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let wf = projects.first().ok_or("无激活工作空间")?;
    knowledge::delete_knowledge_item(wf, &kind, &id)
}

/// 新建 md 知识条目，返回生成的 id
#[tauri::command]
fn create_knowledge_item(
    state: tauri::State<AppState>,
    kind: String,
    title: String,
    content: String,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("标题不能为空".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let wf = projects.first().ok_or("无激活工作空间")?;
    knowledge::create_knowledge_md(wf, &kind, &title, &content)
}

#[tauri::command]
fn get_call_detail(exec_id: String) -> Option<activity::CallDetail> {
    if !is_safe_id(&exec_id) {
        return None;
    }
    activity::read_call_detail(&config::cli_history_dir(), &exec_id)
}

/// 知识条目列表（五类分组，跨工程合并，每类上限 50）
#[tauri::command]
fn get_knowledge_items(state: tauri::State<AppState>) -> Vec<knowledge::KnowledgeEntry> {
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for wf in projects {
        for entry in knowledge::scan_knowledge_items(&wf) {
            if seen.insert(format!("{}:{}", entry.kind, entry.id)) {
                items.push(entry);
            }
        }
    }
    items
}

/// 高频知识沉淀：learning 行按使用频次倒序，跨工程合并去重后取前 N 条。
#[tauri::command]
fn get_top_knowledge(state: tauri::State<AppState>, limit: Option<u64>) -> Vec<knowledge::KnowledgeEntry> {
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for wf in projects {
        for entry in knowledge::scan_top_learning(&wf, 64) {
            if seen.insert(format!("{}:{}", entry.kind, entry.id)) {
                items.push(entry);
            }
        }
    }
    items.sort_by(|a, b| {
        b.frequency
            .unwrap_or(0)
            .cmp(&a.frequency.unwrap_or(0))
            .then_with(|| a.title.cmp(&b.title))
    });
    items.truncate(limit.unwrap_or(5) as usize);
    items
}

/// 单条知识条目全文（kind + id）
#[tauri::command]
fn get_knowledge_item_content(
    state: tauri::State<AppState>,
    kind: String,
    id: String,
) -> Option<knowledge::KnowledgeItemContent> {
    if !["specs", "memory", "knowhow", "learning", "issues"].contains(&kind.as_str())
        || !is_safe_id(&id)
    {
        return None;
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    for wf in projects {
        if let Some(content) = knowledge::read_knowledge_item_content(&wf, &kind, &id) {
            return Some(content);
        }
    }
    None
}

/// 系统通知（前端检测到状态迁移后调用；不依赖前端 JS API）
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// 切换全局模式（全部工程 vs 激活单工程）
#[tauri::command]
fn set_global_mode(app: tauri::AppHandle, state: tauri::State<AppState>, flag: bool) -> Result<bool, String> {
    state.config.lock().unwrap().global_mode = flag;
    save_state(&state)?;
    flush_snapshot(&app);
    Ok(flag)
}

/// 开机自启开关（tauri-plugin-autostart）
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, flag: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if flag {
        autostart.enable().map_err(|e| format!("自启启用失败：{e}"))?;
    } else {
        autostart.disable().map_err(|e| format!("自启关闭失败：{e}"))?;
    }
    Ok(flag)
}

/// 查询开机自启状态
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 语义搜索桥接：spawn `maestro search --json`（激活工程作用域）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticSearchResult {
    pub source: String, // wiki | code
    pub kind: String,   // note | class | function | ...
    pub name: String,
    pub detail: String,
    pub rank: f64,
    pub score: f64,
    pub snippet: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SemanticSearchOut {
    pub query: String,
    pub wiki_count: u64,
    pub code_count: u64,
    pub count: u64,
    pub results: Vec<SemanticSearchResult>,
    pub error: Option<String>,
}

fn parse_search_output(stdout: &str) -> SemanticSearchOut {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return SemanticSearchOut {
            error: Some("搜索输出不是合法 JSON".into()),
            ..Default::default()
        };
    };
    let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let mut out = SemanticSearchOut {
        query: v.get("query").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        wiki_count: num("wikiCount"),
        code_count: num("codeCount"),
        count: num("count"),
        ..Default::default()
    };
    if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
        out.results = results
            .iter()
            .filter_map(|r| {
                let s = |k: &str| r.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let f = |k: &str| r.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                if s("name").is_empty() {
                    return None;
                }
                Some(SemanticSearchResult {
                    source: s("source"),
                    kind: s("kind"),
                    name: s("name"),
                    detail: s("detail"),
                    rank: f("rank"),
                    score: f("score"),
                    snippet: s("snippet"),
                    summary: s("summary"),
                })
            })
            .collect();
    }
    out
}

/// 语义搜索（激活工程）：`maestro search <q> --json --limit N --workflow-root <wf>`。
/// CLI 缺失/失败时返回 error 字段，前端降级为本地字符串搜索。
#[tauri::command]
fn semantic_search(
    state: tauri::State<AppState>,
    query: String,
    limit: Option<u64>,
) -> SemanticSearchOut {
    let q = query.trim().to_string();
    if q.is_empty() {
        return SemanticSearchOut { query: q, ..Default::default() };
    }
    let cfg = state.config.lock().unwrap().clone();
    let projects = active_projects(&cfg);
    let Some(wf) = projects.first() else {
        return SemanticSearchOut { query: q, error: Some("无激活工作空间".into()), ..Default::default() };
    };
    let limit = limit.unwrap_or(8).clamp(1, 20).to_string();
    let wf_str = config::normalize_path(wf);
    let result = std::process::Command::new("maestro")
        .args(["search", &q, "--json", "--limit", &limit, "--workflow-root", &wf_str])
        .output();
    match result {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut parsed = parse_search_output(&stdout);
            parsed.query = q;
            parsed
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let msg = if stderr.trim().is_empty() {
                "搜索命令退出码非零".to_string()
            } else {
                stderr.trim().chars().take(300).collect()
            };
            SemanticSearchOut { query: q, error: Some(msg), ..Default::default() }
        }
        Err(e) => SemanticSearchOut {
            query: q,
            error: Some(format!("maestro CLI 不可用：{e}")),
            ..Default::default()
        },
    }
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> ConfigOut {
    config_out(&state.config.lock().unwrap())
}

#[tauri::command]
fn complete_setup(state: tauri::State<AppState>) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.initialized = true;
    drop(cfg);
    save_state(&state)
}

#[tauri::command]
fn add_root(state: tauri::State<AppState>, path: String) -> Result<ConfigOut, String> {
    let dir = config::expand_home(&path);
    if !dir.is_dir() {
        return Err("目录不存在或不可读".into());
    }
    let canonical = config::normalize_path(&dir);
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.initialized = true;
        if !cfg.roots.contains(&canonical) {
            cfg.roots.push(canonical.clone());
        }
    }
    save_state(&state)?;
    Ok(config_out(&state.config.lock().unwrap()))
}

#[tauri::command]
fn remove_root(state: tauri::State<AppState>, path: String) -> Result<ConfigOut, String> {
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.roots.retain(|r| r != &path);
    }
    save_state(&state)?;
    Ok(config_out(&state.config.lock().unwrap()))
}

#[tauri::command]
fn set_wallpaper(state: tauri::State<AppState>, path: String) -> Result<ConfigOut, String> {
    let expanded = config::expand_home(&path);
    if !expanded.is_file() {
        return Err("壁纸文件不存在或不可读".into());
    }
    let normalized = config::normalize_path(&expanded);
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.wallpaper = Some(normalized);
    }
    save_state(&state)?;
    Ok(config_out(&state.config.lock().unwrap()))
}

#[tauri::command]
fn clear_wallpaper(state: tauri::State<AppState>) -> Result<ConfigOut, String> {
    state.config.lock().unwrap().wallpaper = None;
    save_state(&state)?;
    Ok(config_out(&state.config.lock().unwrap()))
}

#[tauri::command]
fn set_wallpaper_opacity(
    state: tauri::State<AppState>,
    opacity: f64,
) -> Result<ConfigOut, String> {
    state.config.lock().unwrap().wallpaper_opacity = Some(opacity.clamp(0.1, 0.9));
    save_state(&state)?;
    Ok(config_out(&state.config.lock().unwrap()))
}

#[tauri::command]
fn list_projects(state: tauri::State<AppState>) -> Vec<workflow::ProjectInfo> {
    let cfg = state.config.lock().unwrap().clone();
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    projects.iter().map(|p| workflow::project_info(p)).collect()
}

#[tauri::command]
fn set_always_on_top(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    flag: bool,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(flag).map_err(|e| e.to_string())?;
    }
    state.config.lock().unwrap().always_on_top = flag;
    save_state(&state)?;
    Ok(flag)
}

fn set_dock_position(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> Result<(), String> {
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn reveal_and_clear_dock(window: &tauri::WebviewWindow, state: &AppState) {
    if let Some(dock) = state.dock.lock().unwrap().take() {
        let _ = set_dock_position(window, dock.visible_x, dock.visible_y);
    }
}

#[tauri::command]
fn dock_window_if_near_edge(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到当前显示器")?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let threshold = (20.0 * scale).round() as i32;
    let reveal_strip = (8.0 * scale).round().max(4.0) as i32;
    let work_area = monitor.work_area();
    let dock = calculate_dock_state(
        (position.x, position.y),
        (size.width as i32, size.height as i32),
        (work_area.position.x, work_area.position.y),
        (work_area.size.width as i32, work_area.size.height as i32),
        threshold,
        reveal_strip,
    );
    let Some(dock) = dock else {
        state.dock.lock().unwrap().take();
        return Ok(None);
    };
    let edge = dock.edge.label().to_owned();
    *state.dock.lock().unwrap() = Some(dock);
    set_dock_position(&window, dock.hidden_x, dock.hidden_y)?;
    Ok(Some(edge))
}

#[tauri::command]
fn reveal_docked_window(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let dock = *state.dock.lock().unwrap();
    if let Some(dock) = dock {
        set_dock_position(&window, dock.visible_x, dock.visible_y)?;
        return Ok(Some(dock.edge.label().to_owned()));
    }
    Ok(None)
}

#[tauri::command]
fn hide_docked_window(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let dock = *state.dock.lock().unwrap();
    if let Some(dock) = dock {
        set_dock_position(&window, dock.hidden_x, dock.hidden_y)?;
        return Ok(Some(dock.edge.label().to_owned()));
    }
    Ok(None)
}

#[tauri::command]
fn undock_window(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    reveal_and_clear_dock(&window, &state);
    Ok(())
}

#[tauri::command]
fn set_window_mode(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    mode: String,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    reveal_and_clear_dock(&window, &state);
    let position = window.outer_position().ok();
    let (w, h, min_h) = if mode == "capsule" {
        (380.0, 100.0, 100.0)
    } else if mode == "editor" {
        // 编辑器模式：侧边栏 380 + 编辑器 380 并排
        (760.0, 615.0, 320.0)
    } else {
        // 主窗口在原 615px 基线上增加约 10%，仍保持明显低于全屏高度。
        (380.0, 677.0, 320.0)
    };
    window
        .set_min_size(Some(tauri::LogicalSize::new(300.0, min_h)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if let Some(position) = position {
        window.set_position(position).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 内容自适应：前端在渲染稳定后一次性调用（防抖在前端）。
#[tauri::command]
fn fit_window_height(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let position = window.outer_position().ok();
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = size.width as f64 / scale;
    let mut max_h = (w * 1.78).clamp(560.0, 720.0);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let monitor_h = monitor.size().height as f64 / scale;
        max_h = max_h.min(monitor_h * 0.82);
    }
    let h = height.clamp(320.0, max_h.max(320.0));
    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if let Some(position) = position {
        let _ = window.set_position(position);
    }
    Ok(())
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle, state: tauri::State<AppState>) {
    if let Some(window) = app.get_webview_window("main") {
        reveal_and_clear_dock(&window, &state);
        let _ = window.hide();
    }
}

/// 真正退出应用（窗口的 X 按钮触发；区别于关闭窗口=隐藏托盘）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = config::load();
            app.manage(AppState {
                config: Mutex::new(cfg.clone()),
                runtime: Mutex::new(RuntimeStore::default()),
                editor: Mutex::new(EditorState {
                    tabs: Vec::new(),
                    active: -1,
                }),
                dock: Mutex::new(None),
            });
            // 预创建独立编辑器窗口（隐藏，按需 show）：避免运行时同步建窗阻塞主线程
            {
                match WebviewWindowBuilder::new(
                    app.handle(),
                    "editor-win",
                    WebviewUrl::App("editor.html".into()),
                )
                .title("Maestro Sidebar · 编辑器")
                .inner_size(820.0, 640.0)
                .min_inner_size(480.0, 320.0)
                .visible(false)
                .build()
                {
                    Ok(w) => {
                        let _ = w;
                    }
                    Err(e) => {
                        eprintln!("[editor-win] 预创建失败: {e}");
                    }
                }
            }

            // 协调器 + watcher + 10s reconcile
            let handle = app.handle().clone();
            let coord = RuntimeCoordinator::spawn(handle.clone());
            watch::spawn_watcher(coord.signal());
            {
                let coord = coord;
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(10));
                    coord.request();
                });
            }

            let window = app.get_webview_window("main").expect("main window");
            let _ = window.set_always_on_top(cfg.always_on_top);

            // 关闭窗口 = 隐藏到托盘，不退出
            let w = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let state = w.app_handle().state::<AppState>();
                    reveal_and_clear_dock(&w, &state);
                    let _ = w.hide();
                }
            });

            // 编辑器窗口：X = 隐藏（复用，避免运行时重建）
            if let Some(ewin) = app.get_webview_window("editor-win") {
                let ew = ewin.clone();
                ewin.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = ew.hide();
                    }
                });
            }

            // 托盘：显示 / 退出
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;
            let show = MenuItemBuilder::with_id("show", "显示 Maestro Sidebar").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Maestro Sidebar")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let state = app.state::<AppState>();
                            reveal_and_clear_dock(&w, &state);
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_session_runs,
            get_session_detail,
            get_run_artifacts,
            get_run_artifact_content,
            get_call_detail,
            get_knowledge_items,
            get_top_knowledge,
            get_knowledge_item_content,
            update_knowledge_item,
            delete_knowledge_item,
            create_knowledge_item,
            open_editor_tab,
            get_editor_state,
            close_editor_tab,
            set_editor_active,
            editor_synced,
            editor_changed,
            get_config,
            semantic_search,
            set_global_mode,
            set_autostart,
            get_autostart,
            notify,
            list_workspaces,
            set_active_root,
            complete_setup,
            add_root,
            remove_root,
            list_projects,
            set_always_on_top,
            set_wallpaper,
            clear_wallpaper,
            set_wallpaper_opacity,
            dock_window_if_near_edge,
            reveal_docked_window,
            hide_docked_window,
            undock_window,
            set_window_mode,
            fit_window_height,
            hide_window,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
