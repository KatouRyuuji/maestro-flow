// 一次性验证程序：直接读取真实数据源，确认知识/会话/Agent 调用数据连通。
// 运行：cargo run --example check -- "D:/maestro2" "C:/Users/dyw/.maestro"
use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let project_root = args.next().unwrap_or_else(|| "D:/maestro2".to_string());
    let maestro_home = args.next().unwrap_or_else(|| {
        std::env::var("MAESTRO_HOME")
            .unwrap_or_else(|_| format!("{}/.maestro", std::env::var("USERPROFILE").unwrap_or_default()))
    });

    let wf = Path::new(&project_root).join(".workflow");
    println!("== workflow root: {}", wf.display());

    // 知识统计
    let k = maestro_sidebar_lib::knowledge::scan_knowledge(&wf);
    println!("知识统计: specs={} memory={} knowhow={} learning_rows={} issue_rows={} total={}",
        k.specs, k.memory, k.knowhow, k.learning_rows, k.issue_rows, k.total);

    // 会话
    let sessions = maestro_sidebar_lib::workflow::scan_sessions(&wf);
    println!("会话数: {} (展示前 5)", sessions.len());
    for s in sessions.iter().take(5) {
        println!("  [{}] {} intent={:?} runs={} latest={:?} {:?}",
            s.status, s.session_id, s.intent.as_deref().unwrap_or(""),
            s.run_count,
            s.latest_run.as_ref().map(|r| r.run_id.as_str()),
            s.latest_run.as_ref().and_then(|r| r.verdict.as_deref()));
    }

    // Agent 调用
    let history = Path::new(&maestro_home).join("cli-history");
    let calls = maestro_sidebar_lib::activity::scan_calls(&history, 5);
    println!("Agent 调用 (最近 5 条，目录 {}):", history.display());
    for c in calls {
        println!("  [{}] {} model={:?} mode={} started={} exit={:?}",
            c.tool, c.exec_id, c.model.as_deref().unwrap_or(""), c.mode, c.started_at, c.exit_code);
    }
}
