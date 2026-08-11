// 应用配置：扫描根目录 + 窗口置顶偏好，持久化于
// dirs::config_dir()/maestro-sidebar/config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 需要观察的工程根目录（其下应有 .workflow/）
    pub roots: Vec<String>,
    pub initialized: bool,
    pub always_on_top: bool,
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

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let dir = app_config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(config_path(), data).map_err(|e| e.to_string())
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
