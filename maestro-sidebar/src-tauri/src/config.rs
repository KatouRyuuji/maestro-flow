// 应用配置：扫描根目录 + 窗口置顶 + 壁纸偏好，持久化于
// dirs::config_dir()/maestro-sidebar/config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 需要观察的工程根目录（其下应有 .workflow/）
    pub roots: Vec<String>,
    pub initialized: bool,
    pub always_on_top: bool,
    /// 自定义壁纸图片路径（None = 未启用）
    pub wallpaper: Option<String>,
    /// 壁纸图层不透明度 0.1–0.9（默认 0.45）
    pub wallpaper_opacity: Option<f64>,
    /// 当前激活的工作空间（.workflow 目录的归一化路径；None = 自动选第一个）
    pub active_root: Option<String>,
    /// 全局模式：扫描全部可用工程（默认 false = 单工程模式）
    pub global_mode: bool,
}

impl AppConfig {
    /// 壁纸不透明度取值，越界回退默认。
    pub fn wallpaper_opacity_value(&self) -> f64 {
        self.wallpaper_opacity
            .map(|v| v.clamp(0.1, 0.9))
            .unwrap_or(0.45)
    }
}

pub fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("maestro-sidebar")
}

pub fn config_path() -> PathBuf {
    app_config_dir().join("config.json")
}

pub fn load() -> AppConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃截断 config.json。
pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 展开 `~` 开头的路径（兼容 Windows 的 `~\proj` 与 Unix 的 `~/proj`）。
pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            let rest = rest
                .trim_start_matches('/')
                .trim_start_matches('\\')
                .replace('\\', "/");
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// 去掉 Windows 长路径前缀 `\\?\`，统一分隔符为 `/`（展示用）。
pub fn normalize_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// cli-history 目录：$MAESTRO_HOME/cli-history 或 ~/.maestro/cli-history
pub fn cli_history_dir() -> PathBuf {
    if let Ok(home) = std::env::var("MAESTRO_HOME") {
        let base = expand_home(&home);
        return base.join("cli-history");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".maestro")
        .join("cli-history")
}
