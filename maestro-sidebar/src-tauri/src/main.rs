// 入口：全部逻辑在 lib.rs（Tauri 移动端约定）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    maestro_sidebar_lib::run()
}
