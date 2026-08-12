# Maestro Sidebar — 功能与设计参考资料

> 用途：供 UI 规划与单独设计使用。本文档描述产品定位、功能清单、数据契约、
> 设计参考与交互规格，不包含任何实现代码。
> 配套参考：`ui-prototype.html`（qwen 主页面原型）、`ui-subpages.html`（qwen 子页面原型，如有）。

---

## 1. 产品定位

**一句话**：常驻桌面的 Maestro 工作区观察者——只读，不改动任何项目文件，让你一眼看清
「Agent 正在调用什么、Session/Run 走到了哪、知识沉淀了多少」。

- 形态：跨平台桌面小部件（Tauri 2，macOS / Windows / Linux），无边框、可拖动、可缩放、托盘常驻
- 数据源：直接读取本机文件系统（`.workflow/` 与 `~/.maestro/cli-history/`），**不依赖 dashboard 服务**，离线可用
- 信息优先级：Agent 调用（正在发生什么）> Session·Run 状态（进行到哪）> 知识积累（沉淀了多少）
- 交互深度：三层——概览（三区块列表）→ 详情（点击进入子页面）→ 原文（完整 prompt / run 元数据）

## 2. 核心功能清单

### 2.1 Agent 调用查看（第一优先级）
| 能力 | 说明 |
|---|---|
| 实时列表 | 最近 20 条 CLI 代理调用（claude-code / codex / gemini / qwen / opencode），按时间倒序 |
| 状态感知 | 运行中（脉冲）/ 完成 / 失败 / 排队 / 取消（委托状态合并） |
| 关键信息 | 工具色点、模型徽章、prompt 单行摘要、相对时间 |
| 点击详情 | 完整 prompt、执行目录、起止时间、退出码、委托状态、对话条目（user/assistant/tool 气泡流） |

### 2.2 Session·Run 架构状态（第二优先级）
| 能力 | 说明 |
|---|---|
| 会话列表 | `.workflow/state.json` 注册表 + 磁盘 `sessions/` 合并，新→旧最多 40 个 |
| 状态徽章 | running（绿脉冲）/ sealed（蓝）/ paused（黄）/ failed·blocked（红）/ unknown |
| Active 标识 | `active_session_id` 高亮 + ACTIVE 标签 |
| Run 概览 | 每会话 run 计数 + 最新 run（verdict / command / platform / run_id） |
| 时间线 | 会话内全部 runs 按 sequence 垂直时间线：节点圆点按 verdict 着色、连接线、起止时间、时长 |
| Run 详情 | handoff_summary、concerns、decisions、gate_ids、编排链（engine/quality_mode/chain 步骤） |
| 自动识别 | 从 cli-history 的 workDir 自动发现含 `.workflow` 的项目，无需手动配置 |

### 2.3 知识积累（第三优先级）
| 能力 | 说明 |
|---|---|
| 五类 KPI | specs 规范 / memory 记忆 / knowhow 诀窍 / learning 学习（jsonl 行数）/ issues 问题（jsonl 行数） |
| 占比条 | 五类分段堆叠进度条 + legend 百分比，KPI 数值颜色与分段同色联动 |
| 条目列表 | 按类型分组的知识条目（id / title / summary / tags / status / created / updated） |

### 2.4 窗口行为（桌面小部件必备）
| 能力 | 说明 |
|---|---|
| 移动 | 顶栏/拖动区整条可拖（`data-tauri-drag-region`） |
| 缩放 | `resizable: true`，系统边缘拖拽；内容自适应窗口高度 |
| 关闭 | 工具栏 × = 退出应用；窗口关闭事件 = 隐藏到托盘 |
| 隐藏 | 工具栏眼睛按钮 = 隐藏到托盘；托盘菜单可唤回 |
| 置顶 | 菜单开关，持久化 |
| 双形态 | 卡片（380×680 完整三区块）↔ 胶囊（380×96 极简状态条：当前会话 + 会话/知识计数） |
| 托盘 | 常驻图标 + 菜单（显示 / 退出） |

### 2.5 主题系统
- 目前 4 套：specimen（深紫，默认）/ glass（明亮玻璃）/ synthwave（霓虹）/ blueprint（蓝图蓝）
- 变量契约见 §7；计划扩展至 6-8 套（建议：ocean 海洋、sunset 日落）

## 3. 数据契约（后端已实现，UI 的输入）

> 全部字段 snake_case；时间 ISO 字符串；null 表示缺失。以下即 Tauri invoke 返回的真实结构。

### 3.1 快照 `get_snapshot()` → 三区块一次拉取
```jsonc
{
  "workspace": "maestro2",            // 工作区显示名（首个工程 project_name）
  "active_session_id": "20260811-xxx",// 当前活动会话
  "generated_at": 1754700000,         // epoch 秒
  "sessions": [ /* 见 3.2 */ ],
  "calls": [ /* 见 3.3 */ ],
  "knowledge": {
    "specs": 12, "memory": 7, "knowhow": 4,
    "learning_rows": 2, "issue_rows": 1, "total": 26
  }
}
```

### 3.2 SessionSummary（列表行 + 胶囊）
```jsonc
{
  "session_id": "20260811-fix-ui",
  "intent": "修复侧边栏玻璃拟态主题切换时的闪烁问题",
  "status": "running",               // running | sealed | paused | failed | blocked | unknown
  "active_run_id": "20260811-003-build",
  "latest_completed_run_id": "20260811-002-test",
  "run_count": 3,
  "latest_run": { /* 见 3.4 RunSummary */ }
}
```

### 3.3 AgentCall（调用行）
```jsonc
{
  "exec_id": "cld-121815-4bf6",
  "tool": "claude-code",             // claude-code | codex | gemini | qwen | opencode
  "model": "claude-opus-4-6",
  "mode": "analysis",                // analysis | write | ...
  "prompt": "（单行摘要，400 字符截断）",
  "work_dir": "D:/maestro2",
  "started_at": "2026-08-07T04:18:51.626Z",
  "completed_at": null,
  "exit_code": null,                 // 0 = 成功
  "async_delegate": false,
  "delegate_status": null            // queued | running | cancelling | null
}
```

### 3.4 RunSummary（时间线节点）
```jsonc
{
  "run_id": "20260811-003-build",
  "sequence": 3,
  "status": "sealed",                // sealed | running | failed | ...
  "verdict": "ready",                // ready | blocked | needs-retry | done_with_concerns | done
  "command": "build",                // 命令名（execute/verify/test/plan/...）
  "platform": "claude",              // claude | codex | gemini | ...
  "started_at": "2026-08-11T09:00:00+08:00",
  "completed_at": "2026-08-11T09:02:10+08:00",
  "duration_secs": 130,
  "handoff_summary": "构建通过，产物已就绪",
  "concerns": ["Codex brief 被平台 fence 拒绝"],
  "decisions": [],
  "gate_ids": ["gate-build-01"]
}
```

### 3.5 SessionDetail（子页面：时间线 + 编排链）
```jsonc
{
  "session": { /* 同 3.2 */ },
  "runs": [ /* RunSummary[]，按 sequence 升序 */ ],
  "orchestration": {
    "engine": "manual",              // manual | ralph | ...
    "quality_mode": "standard",
    "chain": [
      { "step_id": "step-000-status", "command": "status", "status": "failed", "run_id": "20260723-001-status" }
    ],
    "position": null
  },
  "boundary_contract": {
    "in_scope": [], "out_of_scope": [], "constraints": [],
    "definition_of_done": ""
  }
}
```

### 3.6 CallDetail（子页面：完整 prompt + 对话）
```jsonc
{
  "call": { /* 同 3.3，prompt 完整未截断 */ },
  "entries": [
    {
      "type": "user_message",        // user_message | assistant_message | tool_use | tool_result | system_message
      "content": "…",
      "timestamp": "2026-08-07T04:18:51.626Z",
      "partial": false,
      "id": null
    }
  ]
}
```

### 3.7 窗口命令
`set_window_mode(mode: "card"|"capsule")` · `fit_window_height(height)` · `set_always_on_top(flag)` · `hide_window()` · `quit_app()` · `get_config()` / `add_root(path)` / `remove_root(path)`

## 4. 设计参考

### 4.1 trellis-card（形态参考，本项目的灵感来源）
- 无边框透明窗口 + 圆角卡片悬浮于桌面；卡片 ↔ 胶囊双形态切换
- 关闭窗口 = 隐藏托盘，托盘唤回；置顶开关
- 生命周期四态压缩为可感知颜色（规划/运行/等待授权/完成）
- 只读观察者定位：不修改任务，只展示
- 20 款主题（specimen / synthwave / blueprint / glassmorphism / neo-brutalism / bento…）
- 翻面查看任务详情（卡片背面文档阅读）

### 4.2 qwen 主页面原型要点（ui-prototype.html）
- **三级表面**：L1 窗口卡片（玻璃渐变 + 紫描边 + 环境光）→ L2 区块面板（半透明 + 圆角 12px + 头部 chevron/图标/计数 pill）→ L3 列表行（hover 提亮）
- **色彩语义**：紫 = 当前/强调，绿 = 运行/完成/ready，蓝 = sealed/Codex/排队，黄 = paused/needs-retry，红 = 失败/blocked，青 = learning
- **徽章配方**：13% 软底 + 25-35% 描边 + 纯色文字，保证深底对比度
- **排版**：8px 栅格；字号 8.5-15px 七级递进；ID/模型/run_id 等宽字体与中文正文形成节奏对比
- **交互**：顶栏整体拖动、运行中脉冲、会话展开时间线、KPI hover 微浮起、focus 焦点环

## 5. 交互规格（页面结构）

```
┌──────────────────────────────┐
│ 顶栏(46px,可拖动)            │
│  [◆ Maestro Sidebar] [chip] [↻] │ [≡][👁][×]  ← 菜单/隐藏/关闭
├──────────────────────────────┤
│ 内容区(独立滚动)             │
│  ┌ 列表视图 ──────────────┐  │
│  │ ▸ Agent 调用  [20]     │  │  ← 折叠面板
│  │   ● Claude [opus] 摘要 │  │  ← 点击行 → 调用详情
│  │   ...                  │  │
│  │ ▸ Session·Run  [40]    │  │
│  │   [ACTIVE] 会话ID      │  │  ← 点击头 → 展开时间线
│  │   ├─● 时间线节点       │  │  ← 详情按钮 → 会话详情
│  │   └─ 查看详情 ›        │  │
│  │ ▸ 知识积累  [26]       │  │
│  │   [12][7][4][2][1]     │  │  ← KPI 五列 + 占比条
│  └────────────────────────┘  │
│  ┌ 详情视图(点击进入)─────┐  │
│  │ [← 返回] 标题  [类型]   │  │
│  │ meta 卡 → 主体滚动      │  │
│  │  A. 会话: 时间线+编排链  │  │
│  │  B. 调用: prompt+对话流  │  │
│  │  C. 知识: 分组条目列表   │  │
│  └────────────────────────┘  │
├──────────────────────────────┤
│ 状态栏(32px)  ● 12:31:20 关闭=隐藏托盘 │
└──────────────────────────────┘
```

胶囊形态（380×96）：`[◆] 当前会话意图 | 状态·runs  [40 会话] [26 知识] [⋯]`

### 5.1 Agent 实时对话详情

- 详情采用“运行摘要 → 执行信息/提示词 disclosure → 对话工作区”的纵向结构；执行信息与提示词默认收起，失败调用自动展开执行信息。
- 对话拥有独立滚动容器。运行中且距底部不超过 48px 时自动跟随；用户上滚后暂停跟随，新内容通过“新动态”按钮提示，点击后恢复贴底。
- 搜索期间暂停自动跟随，命中的折叠项临时展开；清除搜索后恢复搜索前的滚动位置、跟随状态和折叠偏好。
- thinking、tool、system、status 默认折叠为紧凑事件行；user、assistant、error 默认展开。超过 1,200 字符或 14 行的主消息显示预览并允许展开全文。
- 每条消息、完整提示词和当前可见对话均可复制；复制使用未截断原文，成功显示 check 状态，失败通过底部实时状态提示。
- 所有 disclosure 和图标操作均提供 tooltip、`aria-label`、`aria-expanded`/`aria-controls` 与可见键盘焦点。

## 6. 视觉设计原则（规划 UI 时参考）

1. **信息密度适中**：380px 窄栏内不拥挤，左主右辅，单行省略
2. **状态即颜色**：任何状态变化必须通过颜色/动画可区分，不依赖文字
3. **动效克制**：过渡 150ms；脉冲/呼吸只用于"运行中/监听中"等实时语义
4. **深色优先**：桌面常驻工具以深色为默认，浅色为主题可选
5. **可读性**：等宽字体用于机器标识（ID/时间/命令），中文正文用系统字体
6. **一致性**：所有徽章同一配方（软底+描边+纯色文字），所有圆角同一梯度（6/8/10/12/14px）

## 7. 主题变量契约（themes.css）

每套主题必须定义（`[data-theme="name"]` 作用域）：
```css
--bg / --bg-hi        /* 窗口背景（实色，用户明确不要透明边框） */
--panel / --panel-soft/* 面板与列表行表面 */
--popover             /* 菜单浮层 */
--border / --border-soft
--text / --text-strong / --text-dim
--accent / --accent-2 / --accent-glow
--chip-bg / --hover / --active-soft / --scrollbar
--ok / --ok-soft / --warn / --warn-soft / --info / --info-soft / --danger / --danger-soft
--cyan                /* learning 知识类 */
```

## 8. 待决策清单（设计时确认）

1. **信息架构**：三区块平铺 vs 顶部分区页签（Agent / Session / 知识）？平铺适合一眼看全，页签适合深挖
2. **详情呈现**：同页切换（返回按钮）vs 卡片翻面动画 vs 侧滑抽屉？
3. **会话时间线**：runs 顺序（sequence 升序=演进方向）？节点是否显示 run 失败原因摘要？
4. **调用详情对话**：是否分页/虚拟滚动（长对话 500 条）？
5. **知识子页面**：分组列表 vs 知识图谱（wiki 链接）？当前只有计数数据，条目列表需扩展后端
6. **主题数量与默认值**：4 套起步够吗？默认 specimen？
7. **胶囊形态信息量**：仅会话+计数，还是加最新调用摘要？
8. **自动识别项目**：多个工程时如何区分展示（当前合并计数，无项目维度）？

---

*文档版本 v1 · 2026-08-11 · 与实现代码同步维护（数据契约以 Rust 后端为准）*
