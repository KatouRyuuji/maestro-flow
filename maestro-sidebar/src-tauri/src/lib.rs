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
use snapshot::{RuntimeSnapshot, snapshot_fingerprint};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct RuntimeStore {
    last_snapshot: Option<RuntimeSnapshot>,
    last_emitted_fingerprint: Option<String>,
}

/// 独立 markdown 预览窗口的待渲染文档
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDoc {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub content: String,
}

struct AppState {
    config: Mutex<AppConfig>,
    runtime: Mutex<RuntimeStore>,
    preview: Mutex<Option<PreviewDoc>>,
}

impl Default for RuntimeStore {
    fn default() -> Self {
        RuntimeStore {
            last_snapshot: None,
            last_emitted_fingerprint: None,
        }
    }
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
}

fn config_out(cfg: &AppConfig) -> ConfigOut {
    ConfigOut {
        configured: cfg.initialized || !cfg.roots.is_empty(),
        roots: cfg.roots.clone(),
        always_on_top: cfg.always_on_top,
        wallpaper: cfg.wallpaper.clone(),
        wallpaper_opacity: cfg.wallpaper_opacity_value(),
    }
}

fn save_state(state: &AppState) -> Result<(), String> {
    let cfg = state.config.lock().unwrap().clone();
    config::save(&cfg)
}

#[tauri::command]
fn get_snapshot(state: tauri::State<AppState>) -> RuntimeSnapshot {
    // 返回最近一次 flush 的缓存快照；无缓存时立即构建一次。
    let cached = state.runtime.lock().unwrap().last_snapshot.clone();
    match cached {
        Some(snapshot) => snapshot,
        None => {
            let cfg = state.config.lock().unwrap().clone();
            let snapshot = snapshot::build_snapshot(&cfg);
            let fp = snapshot_fingerprint(&snapshot);
            let mut runtime = state.runtime.lock().unwrap();
            runtime.last_snapshot = Some(snapshot.clone());
            runtime.last_emitted_fingerprint = Some(fp);
            snapshot
        }
    }
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
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
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
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    for wf in projects {
        if let Some(detail) = workflow::scan_session_detail(&wf, &session_id) {
            return Some(detail);
        }
    }
    None
}

/// 打开独立 markdown 预览窗口（重复打开同一窗口：聚焦 + 刷新内容）
#[tauri::command]
fn open_md_preview(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    if !["specs", "memory", "knowhow"].contains(&kind.as_str()) || !is_safe_id(&id) {
        return Err("不支持的条目类型".into());
    }
    let cfg = state.config.lock().unwrap().clone();
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    let mut doc = None;
    for wf in projects {
        if let Some(c) = knowledge::read_knowledge_item_content(&wf, &kind, &id) {
            doc = Some(PreviewDoc {
                kind: kind.clone(),
                id: id.clone(),
                title: c.title,
                content: c.content,
            });
            break;
        }
    }
    let Some(doc) = doc else {
        return Err("条目不存在或不可读".into());
    };
    *state.preview.lock().unwrap() = Some(doc.clone());
    let title = format!("MD 预览 · {}", doc.title);
    if let Some(window) = app.get_webview_window("md-preview") {
        let _ = window.set_title(&title);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("window.location.reload()");
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "md-preview", WebviewUrl::App("preview.html".into()))
        .title(title)
        .inner_size(720.0, 560.0)
        .min_inner_size(420.0, 300.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// preview.html 拉取当前预览文档
#[tauri::command]
fn get_md_preview(state: tauri::State<AppState>) -> Option<PreviewDoc> {
    state.preview.lock().unwrap().clone()
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
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
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
    let mut projects = workflow::discover_projects(&cfg.roots);
    for auto_root in auto::auto_discover_roots() {
        if let Some(wf) = workflow::find_workflow_root(&auto_root) {
            projects.push(wf);
        }
    }
    projects.sort();
    projects.dedup();
    for wf in projects {
        if let Some(content) = knowledge::read_knowledge_item_content(&wf, &kind, &id) {
            return Some(content);
        }
    }
    None
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

#[tauri::command]
fn set_window_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let position = window.outer_position().ok();
    let (w, h, min_h) = if mode == "capsule" {
        (380.0, 96.0, 96.0)
    } else {
        (380.0, 680.0, 320.0)
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
    let mut h = height.clamp(320.0, 1200.0);
    if let Ok(Some(monitor)) = window.current_monitor() {
        let max_h = monitor.size().height as f64 / scale - 40.0;
        h = h.min(max_h);
    }
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
fn hide_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = config::load();
            app.manage(AppState {
                config: Mutex::new(cfg.clone()),
                runtime: Mutex::new(RuntimeStore::default()),
                preview: Mutex::new(None),
            });

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
                    let _ = w.hide();
                }
            });

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
            get_call_detail,
            get_knowledge_items,
            get_knowledge_item_content,
            open_md_preview,
            get_md_preview,
            get_config,
            complete_setup,
            add_root,
            remove_root,
            list_projects,
            set_always_on_top,
            set_wallpaper,
            clear_wallpaper,
            set_wallpaper_opacity,
            set_window_mode,
            fit_window_height,
            hide_window,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
