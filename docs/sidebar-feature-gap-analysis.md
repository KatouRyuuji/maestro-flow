# Maestro-Sidebar 功能差距分析 v2 —— Session·Run / 知识沉淀 / Agent 调用

> 版本：v2（扩充分数、字段级差距、实现要点与落地路线）
> 实施状态（2026-08）：**P0 全部 + P1 全部（A1/A2/A3/B2/D5/E4/F3/F4）+ P2 精选（D2/E7/C1/G1）已完成**（见 §0 实施记录）；P2 剩余（D1/D3/D4 wiki·domain·规划、C3/C5/C6 evidence·Execution·Resume、B4 历史分页、E2 趋势、E5 ⌘K、E6 深链、B6 团队流、G4 i18n）待做。

## 0. 实施记录（已落地）

| 项 | 状态 | 落地内容 |
|---|---|---|
| F2 会话详情 project 回填 | ✅ | `workflow.rs` 从 state.json 回填；单测 `scan_session_detail_backfills_project` |
| F1 Markdown 预览 | ✅ | 新建共享 `src/md.js`（esc/inline/renderMd），editor.js 复用；app.js「预览 Markdown」改为详情页内渲染 modal（原 `open_md_preview` 未注册的坏按钮已移除） |
| B1 Token 统计 | ✅ | `activity.rs` 解析 token_usage（详情已完成调用全量统计）；`AgentCall.inputTokens/outputTokens`；调用详情 meta 行 + 全部调用页聚合卡（总计/按工具，k 格式化） |
| C2 gates 状态 | ✅ | `workflow.rs` GateInfo + scan_gates；`SessionDetail.gates`；会话详情「门禁状态」区 + run 门禁列表状态徽章（通过/失败/跳过/豁免/必过/阻塞） |
| E1 系统通知 | ✅ | `tauri-plugin-notification@2` + `notify` 命令；前端状态迁移检测（call running→done/error、session →blocked/failed），只通知一次 |
| A3 沉淀收据 | ✅ | `SessionDetail.lifecycle` 透传；会话详情「知识沉淀 · Receipt」卡（promoted ids 可点击跳转、封存摘要/时间、派生来源） |
| A1+A2 待处置候选 | ✅ | `knowledge.rs` scan_pending_candidates（run 级 knowledge-delta.json 聚合）；快照 `pending_candidates` 纳入指纹；知识区块「待处置 N 条候选」chip + 详情视图（搜索/复制 promote 命令/打开所属会话） |
| B2 筛选 chips | ✅ | 调用区块状态（6 项）+ 动态工具 chips，与搜索组合过滤 |
| D5 Issues 分组 | ✅ | 知识详情 issues 组按状态子分组（open/registered/completed/…+其他） |
| 技术债清理 | ✅ | clippy 0 警告（存量 3 个顺手修复）；cargo test 34 通过 |
| F3 learning 稳定 id | ✅ | 合成 id 改 `{command}-{fnv1a64 前 8 hex}`，不随 frequency 变化；旧格式不再匹配；稳定性回归测试 |
| F4 知识缓存联动 | ✅ | 快照 knowledge 统计变化 → kbItemsPromise 自动失效（learning 已有 digest 机制） |
| E4 多工程全局模式 | ✅ | config.global_mode + set_global_mode；快照全局模式扫描全部工程（会话上限 80/40）；状态栏 ◎ 按钮切换，wsChip 显示「全局 · N 工程」 |
| E7 开机自启 | ✅ | tauri-plugin-autostart@2.5.1；菜单「开机自启」开关（i-power icon）；启动时查询状态 |
| D2 语义搜索 | ✅ | `semantic_search` 命令桥接 `maestro search --json --workflow-root`（激活工程）；知识详情页「语义」toggle：wiki + 代码图谱混合检索，结果行来源徽章/得分/复制引用，CLI 缺失降级本地搜索；2 个解析单测 |
| C1 run 产出物 | ✅ | `get_run_artifacts`/`get_run_artifact_content`（report.md 截断、outputs 列表+预览、evidence/artifacts 计数、防路径逃逸）；run 详情「产出物」懒加载折叠块 + 全文 modal；2 个单测 |
| G1 键盘导航 | ✅ | 主列表 j/k 移动焦点、Enter 聚焦、r 刷新（不与 /、Esc、输入框冲突） |

---

> 分析方法：`maestro-sidebar/` 全量源码走读（Rust 后端 8 文件 + 前端 app.js 3119 行 / index.html / editor.js）+ `maestro` CLI 全命令面核对 + `.workflow/` 与 `~/.maestro/cli-history/` 磁盘真实样本核验。
> 结论先行：实时观察层完成度很高；**知识沉淀全链路（候选→处置→收据）、平台知识面（wiki/kg/domain/roadmap）、Run 深度数据、通知与趋势**是四大空白；另有一个必然失败的坏按钮（`open_md_preview` 未注册）。

---

## 1. 平台能力 × Sidebar 覆盖矩阵

> ✅ 已覆盖 ｜ ◐ 部分覆盖 ｜ ❌ 未覆盖（下同）

| 平台命令面 / 数据源 | Sidebar 状态 | 说明 |
|---|---|---|
| `run next / create / complete / edit / decide / check` | ❌ | 只读观察；无命令复制、无执行 |
| `run brief`（Resume Packet） | ❌ | 运行中 run 的 goals/gate 状态不展示 |
| `session status / show / graph / evidence` | ◐ | 详情页覆盖大半；evidence 注册表、resume 包缺失 |
| `session resolve / resume / recover` | ❌ | 恢复动作无入口（只读底线：复制命令） |
| `session archive / unarchive` | ❌ | 归档会话不可见、不可操作 |
| `execution`（session/2.0 generations） | ❌ | `.workflow/execution/journal.jsonl` 完全不读 |
| `knowledge stage / promote / review / reconcile / audit` | ❌ | KDC 候选、处置、收据全链路缺失（见 A 组） |
| `search / kg / load`（语义检索） | ❌ | 仅有字符串匹配 |
| `wiki` | ❌ | wiki 条目完全缺席 |
| `domain`（词汇表） | ❌ | glossary.json 不读 |
| `issue`（生命周期） | ◐ | 只平铺 jsonl 行；无状态分组/优先级/关联 |
| `knowhow / spec` | ◐ | 文件可浏览编辑；spec readMode/必读清单无视图 |
| `plan / roadmap / phases / milestones` | ❌ | 规划类知识不展示 |
| `delegate / cli / explore / moa` | ❌ | 无发起入口（复制命令级也没有） |
| `agent-msg` / `collab` / `timeline` | ❌ | 团队消息、活动流、git+session 时间线不展示 |
| `workspace`（跨工作空间知识共享） | ◐ | 本地多工程可切换；链接/共享知识不可见 |
| cli-history `token_usage` 流 | ❌ | 读取后丢弃（B1） |
| `gates.json` / `artifacts.json` / `evidence.json` | ◐ | 只有 gate_id 裸引用；状态/产出物不展示 |
| run 目录 `report.md` / `outputs/` / `work/` / `diagnostics.ndjson` | ❌ | 产出物不可见 |
| `spec-analytics.jsonl` | ❌ | 趋势数据存在未用 |
| 系统通知（tauri-plugin-notification） | ❌ | 无任何通知 |

---

## 2. 字段级差距（数据结构里已有、Sidebar 未解析的字段）

### 2.1 `run.json`（workflow.rs::parse_run 只取 14 个字段）

| 未解析字段 | 含义 | 建议去向 |
|---|---|---|
| `parent_run_id` | 父子/重试链 | 时间线连线、重试标记（C8） |
| `input` | 运行输入（consumes/args） | run 详情折叠块（C9） |
| `contract_snapshot` / `guidance_snapshot` | 边界契约与指导快照 | run 详情折叠块（C9） |
| `checkpoint` / `checkpoint_expectation` | 断点与期望 | 卡点可视化（C1） |
| `retry_fence` | 重试围栏（次数/时间窗） | blocked run 的"何时可重试"提示（C1） |
| `goal_binding` | 目标绑定 | run 详情（C9） |
| `creation_decision` / `creation_provenance` / `transition` | 创建决策与转移记录 | 生命周期折叠块（C4） |
| `chain_step_id` | 链步骤绑定 | 编排链↔run 双向定位（C9） |
| `output.produces` / `output.consumes` | 产出/消费声明 | 依赖图（C9，P2） |
| `knowledge-delta.json`（同目录） | 本 run 沉淀的知识增量 | "此 run 产出"（A5） |
| `knowledge-reconciliation.json`（run 级） | 候选核对结果 | A1 |

### 2.2 `session.json`（workflow.rs::scan_session_detail 只取 6 个字段 + orchestration/boundary）

| 未解析字段 | 含义 | 建议去向 |
|---|---|---|
| `lifecycle.sealed_at / seal_summary` | 封存信息 | 会话 meta（A3/C4） |
| `lifecycle.promoted_spec_ids / promoted_knowhow_ids` | 沉淀收据 | 会话详情"已沉淀"卡（A3） |
| `lifecycle.forked_from` + `provenance`（source/imported_from/created_by） | 派生来源 | 生命周期折叠块（C4） |
| `refs`（gates/artifacts/evidence 路径） | 注册表引用 | C2/C3 |
| `requests[]`（transition 历史） | 状态机转移记录 | 生命周期折叠块（C4） |
| `intent_identity`（workspace_id/command/normalized_hash） | 意图指纹 | meta 区（C4） |
| `topic_identity` / `identity_revision` / `activity_revision` | 身份/活动修订 | 技术 meta（C4） |
| `orchestration.decision_points` | 决策点定义 | 决策点视图（C9） |

### 2.3 cli-history 流（activity.rs::read_stream_summary 只取 assistant_message）

| 未解析条目类型 | 含义 | 建议去向 |
|---|---|---|
| `token_usage`（inputTokens/outputTokens） | token 消耗 | 调用详情 + 聚合（B1） |
| `tool_use` 的 `result` / `status` | 工具结果 | 已解析但详情页折叠为事件（可加"仅工具"过滤） |
| `error` 的 `message` | 错误信息 | 失败聚合视图（B6） |

---

## 3. 需求点清单

> 评分：价值 V 1–5（感知强度×发生频率）；成本 S/M/L；风险（数据敏感性/兼容性）。

### A 组 —— 知识沉淀闭环（最高价值缺口）

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **A1** | **待沉淀候选（KDC）区块** | 5 | M | 数据源：各 session `knowledge-reconciliation.json`（candidate_snapshot_hash/counts: unique/duplicates/related/conflicts/review_required）+ `session.json` run notes 中的 KDC-xxx 引用。实现：`knowledge.rs` 新增 `scan_pending_candidates(wf)`（合并 session 级 + run 级 reconciliation 文件，统计 pending 数），快照增加 `pending_candidates` 字段并纳入指纹；前端知识区块顶部新增"待处置 N 条"chip + 详情视图列出候选（会话、类型、归类）。会话详情页顶部同步展示该会话 pending 数。 |
| **A2** | **候选处置：复制命令 → 一键 promote** | 5 | S→M | 保持只读定位的渐进路线：① 每条候选"复制处置命令"（`maestro knowledge promote <sid> --candidate <id> [--as <resolution> --target <kid> --reason ...]`，含 `--resolve` 判定建议）；② 后端封装 `execute_knowledge_command`（spawn CLI，流式回显状态栏），确认后执行。验收：候选可处置后 knowledge-updated 事件自动刷新统计。 |
| **A3** | **沉淀收据展示** | 4 | S | 会话详情新增"知识沉淀"卡：`promoted_spec_ids`/`promoted_knowhow_ids` 点击跳转对应条目、`seal_summary`、`sealed_at`。实现：SessionDetail 增加 `lifecycle` 字段透传（workflow.rs 已读 session.json，只差解析）。 |
| **A4** | **learning 健康信号** | 4 | M | 数据源：learning jsonl 的 frequency/successRate/avgDuration/lastUsed/contexts。增量：① 高频 top5 行加成功率色标（successRate<0.8 橙）；② "成功率下滑"信号（与 spec-analytics 历史对比）；③ 按 tool 聚合统计。 |
| **A5** | **run → 知识产出关联** | 4 | M | 每个 run 详情的 `knowledge-delta.json` 解析出"本 run 沉淀/更新了哪些知识"，展示为链接列表；与 A3 形成"run→候选→promote→收据"完整闭环。 |
| **A6** | **知识健康审计入口** | 3 | M | 桥接 `maestro knowledge audit`（软清理建议）；Sidebar 展示"孤儿/过期/重复"计数，处置动作复用 A2 模式。 |

### B 组 —— Agent 调用增强

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **B1** | **Token/成本统计** | 5 | S | `activity.rs::read_stream_summary` 已读流尾部，补解析 `token_usage`（input/output tokens 求和）；`AgentCall` 增加 `input_tokens/output_tokens`；调用详情 meta 区显示；"全部调用"详情页底部聚合（按 tool/model 汇总，估算成本）。数据已在本地，零外部依赖。 |
| **B2** | **状态/工具筛选 chips** | 4 | S | 调用区块头部加筛选行：运行中/失败/完成/排队 + 工具（claude/codex/gemini/qwen/pi）。复用 `matchCall`，纯前端。 |
| **B3** | **失败聚合视图** | 4 | M | "最近失败"卡片：exitCode≠0 的调用按 (tool, model, prompt 关键词) 聚类，显示失败率；点击进详情。与 A4 的 successRate 呼应。 |
| **B4** | **历史分页** | 3 | S | 现状：`snapshot.rs:113` 硬编码 `scan_calls(…, 20)`，前端"全部调用"视图同样只有 20 条，**无法浏览更早记录**。实现：`get_calls_page(offset, limit)` 新命令直扫 cli-history（已有 stat 排序逻辑），详情页"加载更早"。 |
| **B5** | **发起调用入口（复制命令起步）** | 3 | S | 观察者定位下最小版本：调用区块底部"委托 Agent"输入框 → 生成 `maestro delegate "<prompt>" --to <tool>` 命令复制到剪贴板；胶囊右键也可。P2 再评估直接执行。 |
| **B6** | **Agent 团队/时间线流** | 3 | L | `agent-msg` 消息总线 + `maestro timeline`（git commits + sessions）。重，放 P2。 |

### C 组 —— Session·Run 深度

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **C1** | **run 产出物浏览** | 5 | M | run 目录 `report.md`（摘要+全文）、`outputs/` 文件列表（点击读内容）、`checkpoint/retry_fence` 状态。实现：新命令 `get_run_artifacts(session_id, run_id)`（安全校验 is_safe_id ×2），前端 run 详情折叠块。 |
| **C2** | **gates.json 状态** | 4 | S | 会话级 `gates.json` 解析 gate 通过/阻塞/待审；run 的 gate_ids 渲染为状态 chip（绿色✓/红色✗），时间线上"卡在哪个 gate"一目了然。 |
| **C3** | **Artifacts/Evidence 注册表** | 4 | M | `artifacts.json`/`evidence.json` 解析为 run 详情"产出物与证据"区；与 `maestro session evidence` 对齐。 |
| **C4** | **生命周期元数据折叠块** | 3 | S | lifecycle/provenance/requests/intent_identity 一次性透传（同 A3 的实现路径，字段已在 session.json）。 |
| **C5** | **Execution（session/2.0）只读支持** | 4 | M | `.workflow/execution/journal.jsonl` 解析 generations 列表；列表合并进会话区块（标 EXEC 徽章）。需确认 journal 行 schema。 |
| **C6** | **Resume Packet** | 4 | M | 运行中 run 详情显示"当前目标/剩余 gates"（`run brief --json` 桥接，或本地解析）。 |
| **C7** | **恢复动作入口** | 4 | M | blocked/paused 会话详情"复制恢复命令"（`session resolve/resume/recover`、`run recover`）；P2 评估直接执行（与 A2 共用执行封装）。 |
| **C8** | **run 父子/重试链** | 3 | S | `parse_run` 补 `parent_run_id`；时间线中重试 run 显示"↻ 重试 #N"。 |
| **C9** | **input/快照/决策点展示** | 3 | M | run 详情折叠块：input、contract_snapshot、guidance_snapshot、goal_binding、chain_step_id；会话编排链增加 decision_points。 |
| **C10** | **归档会话视图** | 2 | S | `session archive/unarchive` 状态标记（列表灰显 + 过滤）。 |

### D 组 —— 平台知识面

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **D1** | **Wiki 条目浏览** | 4 | M | `wiki-index.json` 或 `maestro wiki --json` 桥接；知识区块增加"Wiki"分组（复用 knowledge 条目模式：列表/详情/搜索）。 |
| **D2** | **语义搜索** | 5 | M | 知识详情页搜索框旁"语义搜索"开关 → `maestro search "<q>" --json --limit 10` 桥接（后台 spawn，解析 stdout）；无 daemon 时自动降级 BM25。渐进：先桥接、后本地 embedding。 |
| **D3** | **Domain 词汇表** | 3 | S | `domain/glossary.json` 解析为只读术语表视图（术语/定义/别名），搜索可达。 |
| **D4** | **规划类知识入口** | 3 | S | roadmap.md 摘要 + phases 列表 + PLAN-*.md 列表，顶栏下拉或知识区块"规划"分组。 |
| **D5** | **Issues 生命周期视图** | 4 | M | 状态分组（open/draft/completed/blocked，取 jsonl status 字段）+ 优先级排序 + ISS-id 与 run notes 互链（grep run 详情中的 ISS-xxx）。 |
| **D6** | **Spec 必读清单** | 3 | S | `readMode: required/optional` 已解析为 status；新增"必读规范"视图（required 集合），作为会话详情上下文卡。 |
| **D7** | **跨工作空间共享知识** | 2 | M | `maestro workspace` 链接状态 + 共享条目标记（P2）。 |

### E 组 —— 观察者体验

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **E1** | **完成/失败系统通知** | 5 | S | tauri-plugin-notification；状态迁移检测（calls: running→done/error；sessions: →blocked/failed；run sealed）→ 通知（工具色点 + 标题 + prompt 摘要）。**需去抖**（一次 run 完成只通知一次，复用 fingerprint 对比记忆上次状态）。 |
| **E2** | **知识增长趋势** | 3 | M | `spec-analytics.jsonl` 解析 7 天序列；KPI 卡点击展开迷你折线。 |
| **E3** | **导出** | 3 | M | 会话全部 run 交接 → markdown；知识库清单 → markdown。复用 `formatCallConversation` 模式。 |
| **E4** | **多工程全局视图** | 4 | M | 现 `build_snapshot` 经 `resolve_active` 收敛为单工程（snapshot.rs:38-44）。新增"全局模式"开关：扫描全部 projects，session/call 行带工程标注（列表已支持 project 字段），异常聚合。 |
| **E5** | **全局搜索（⌘K）** | 4 | M | 跨区块（调用/会话/知识）统一搜索面板；结果分组 + 高亮。 |
| **E6** | **深链协议** | 3 | S | 注册 `maestro-sidebar://session/<id>` / `/call/<exec>`；终端 `maestro` 输出可点击定位。 |
| **E7** | **开机自启** | 3 | S | tauri-plugin-autostart，菜单开关。 |
| **E8** | **通知偏好** | 3 | S | 静音时段/仅失败/仅完成 选项；E1 的配套。 |

### F 组 —— 缺陷与技术债

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| **F1** | "预览 Markdown"按钮必然失败 | `app.js:1911` 调 `open_md_preview`，`lib.rs` invoke_handler 36 个命令中无此命令 | P0：实现（新建隐藏 webview 渲染 md，或复用 editor-win 只读 tab）或移除按钮 |
| **F2** | 会话详情 project 恒为 None | `workflow.rs::scan_session_detail` 构造时 `project: None` | P0：从 session.json `project_name`/state.json 回填（列表行已有标注） |
| **F3** | learning 合成 id 依赖 frequency | `{command}-{frequency}`：频次变化后原 id 失效，编辑/删除落空（knowledge.rs `read_knowledge_item_content` synth 匹配） | P1：改 hash(command) 稳定 id 或 CLI 侧为行写真 id |
| **F4** | 知识全量扫描无 TTL | `kbItemsPromise` 一次拉取长期缓存；大工程 specs/knowhow 全量读 | P1：与 snapshot digest 联动失效（learning 已做，md 类未做） |
| **F5** | 快照重建全量读 learning（上限 10 万行） | `learning_top_digest` 每次 flush 全量扫描；10s reconcile + watcher 事件均触发 | P2：增量 digest（记录文件 mtime+行数变化）或降采样 |
| **F6** | 前端零测试 | 仅 Rust 有单测；app.js 3119 行无测试 | P2：渲染函数抽纯函数 + vitest（工作区已有 vitest 配置） |

### G 组 —— 交互与可访问性

| # | 需求 | V | 成本 | 要点 |
|---|---|---|---|---|
| **G1** | 键盘导航 | 3 | S | j/k 上下移动、Enter 进入、r 刷新；已有 `/` 与 Esc 基础。 |
| **G2** | 长列表虚拟化 | 3 | M | run 时间线 50 条截断、会话 40 条截断为保性能；虚拟滚动后可去上限。 |
| **G3** | 胶囊点击展开 | 3 | S | 胶囊面板点击 → 直接打开对应会话/调用详情（当前胶囊零交互）。 |
| **G4** | i18n | 2 | L | 中文硬编码遍布 app.js/editor.js；P2 评估（目标用户是否全中文）。 |

---

## 4. 评分总表与路线

### P0 —— 修缺陷 + 低垂果实（先做，合计约 2–3 人日）
| 项 | 理由 |
|---|---|
| F1 修复/移除 open_md_preview | 现网可见坏按钮 |
| F2 会话详情 project 回填 | 一行级修复 |
| B1 Token/成本统计 | 数据已读只差解析（S 成本，V5） |
| E1 系统通知（含去抖） | 观察者杀手级价值（S 成本，V5） |
| C2 gates 状态 | 复用已读文件（S 成本，V4） |

### P1 —— 知识沉淀闭环 + 观察者进阶（核心迭代，约 1–2 周）
A1 待沉淀候选区块 → A2 处置（复制命令 → 一键 promote）→ A3 收据展示（与 C4 同路径）→ A5 run 知识产出关联；B2 筛选；E4 全局视图；D5 issues 分组；F3/F4 技术债。

### P2 —— 平台知识面与深度（渐进，按需）
D2 语义搜索 → D1 wiki → D3 domain → D4 规划 → C1/C3 产出物与证据 → C5 Execution → B4 历史分页 → E2 趋势 → E5 ⌘K → B6/C10/E6/G 组。

---

## 5. 落地验收标准（P0+P1 摘要）

1. `cargo test`（sidebar）全绿；新增字段（pending_candidates/tokens/lifecycle）有单测。
2. 快照指纹覆盖新字段（学习 digest 模式复用）—— 新增数据变化时面板自动刷新。
3. 通知：一次 run 完成只弹一次；失败/blocked 必弹；静音时段可用。
4. 候选处置全链路：会话详情见 pending 数 → 复制 promote 命令 → 执行后 knowledge 统计即时刷新。
5. 无新增安全面：所有新命令沿用 `is_safe_id` 防路径逃逸；CLI 桥接（promote/search）用参数数组 spawn，不经 shell。
