# 提示词层 legacy → session/2.0 迁移方案（批次三）

> 状态：提案（暂不实施）。来源：多 agent 审查（2026-08-12）发现 maestro / maestro-next /
> maestro-session-seal / maestro-companion 四个入口的关键步骤仍按 `session/1.x` 心智模型
> 书写，与它们自己 required_reading 的共享协议（run-mode.md、orchestrator-run-loop.md
> 已迁移至 session/2.0）直接矛盾。ralph 侧已迁移干净，形成不对称。

## 1. 问题定义

session/2.0 的规范模型（orchestrator-run-loop.md §1–§6，已核实）：

- Session 是**持久身份**（identity-only，无 running/paused/sealed 生命周期）；
- Execution 拥有 chain、gates、decisions、revision、pause/resume/seal 与 core lease；
- 创建流：`session create`（仅身份）→ `execution start`（带 fence/lease 的有界 generation）
  → 链通过协商的 Execution bootstrap surface 注入，surface 不可用则 fail closed；
- 推进流：fenced `run next` → dispatch → `run check` → fenced `run complete --verdict`；
- 决策：fenced `run decide`；封存：`execution seal`；
- `session create --chain-file`、`session start/next/done/decide/resolve/resume/seal`
  及其 `maestro run ...` 别名全部属于 legacy `session/1.x` 兼容分支（run-loop §Legacy、
  run-mode.md L173），"不是 canonical authority，不得用于恢复丢失的 core claim"。

但四个入口提示词仍把 legacy 命令写成规范路径，执行者读完 required_reading 会得出
与命令正文相反的结论。

## 2. 差异清单（审查发现 M1/M2/M3/S1/N2/C1）

| # | 文件与位置 | 当前 legacy 写法 | canonical 目标写法 |
|---|---|---|---|
| M1 | `.claude/commands/maestro.md` invariant 2、`prepare/maestro.md` §4 | `session create "{intent}" --chain-file {path}` 一步建身份+链 | `session create`（仅身份）→ `execution start`（fenced）→ 链经协商 bootstrap surface 注入；surface 不可用 fail closed |
| M2 | `maestro.md` invariant 6、`prepare/maestro.md` invariant 5 | `session done --verdict` / `session decide` 推进 | fenced `maestro run complete --verdict` / `maestro run decide`（run-loop §3/§4 完整选项集） |
| M3 | `maestro.md` A_AMEND | `session meta update --session ... --decomposition-file -` 提交分解 | Execution-owned typed proposal + `run complete --apply-proposal`（ralph-amend-goal.md §4；run-loop §5 明确 meta update 是 1.x 兼容） |
| S1 | `.claude/commands/maestro-session-seal.md` Step 1/2、E002、success_criteria | 校验 Session status ∈ {running, paused}；验收 `session.json.lifecycle.sealed_at` 写入、`state.json.sessions[].status == sealed` | seal 的对象是 **Execution**（`execution seal` + `execution-seal-receipt/1.0`）；Session 身份保持可复用、statusless；验收改为核对 seal receipt 字段 |
| N2 | `.claude/commands/maestro-next.md` A_EXECUTE_STEP、`prepare/execute.md` L83 | `maestro run start` / `maestro run done`（`session start/done` 别名） | 标准通道改走 run-mode.md self-start 流（capabilities 协商 → execution-aware `run create` → `run complete`），或显式声明该路径为 lite/legacy 并加边界说明 |
| C1 | `.claude/commands/maestro-companion.md` E001 | 错误码指向流程中不存在的 `session start` | E001 拆分对齐实际三步（`session create` / `execution start` / `run create` 各自失败语义） |
| 附 | `.claude/commands/maestro-next.md` L264、`prepare/execute.md` L79 | 降级路由建议不存在的 `/odyssey-planex` | `/maestro-odyssey "<...>" --mode planex` |

各条目需同步 `.codex`/`.agy`/`.agents` 三个镜像（共 4 份/文件）。

## 3. 前置核查（迁移前必须确认）

1. **Execution bootstrap surface 现状**：run-loop §1.3 要求"链通过协商的 bootstrap
   surface 注入"，需确认当前 CLI 是否已提供该 surface（候选：`execution start` 的
   chain 参数、`session chain insert`、或 `run edit`）。若尚未提供，M1 迁移会把
   /maestro 建链直接打断（fail closed）——此时应先落地 CLI 能力再改提示词，
   或在提示词中显式声明 legacy 分支为过渡路径（带 run-loop §Legacy 的可见标注）。
2. **capabilities 协商返回位**：确认 `maestro capabilities --json` 是否暴露
   `session/2.0 + execution/1.0 + core_execution_lease + run-response/1.1` 支持位，
   供提示词做分支判定。
3. **回归基线**：`scripts/check-session-run-contract-parity.mjs`、
   `scripts/lint-session-run-prompts.mjs`、`scripts/lint-session-run-mirrors.mjs`、
   `scripts/check-session-run-release-machine.mjs` 全绿作为迁移起点。

## 4. 迁移步骤（建议顺序）

| 阶段 | 内容 | 范围 | 风险 |
|---|---|---|---|
| P0 | 前置核查 §3；若 bootstrap surface 缺失，先立 CLI 任务 | src/ | — |
| P1 | 低风险文本修复：C1（E001 对齐）、附（`/odyssey-planex` 路由）、S1 中的验收文案（改核对 seal receipt） | 8+8 个镜像文件 | 低 |
| P2 | M2：invariant 6 / prepare invariant 5 的推进权威改为 `run complete`/`run decide`；同步 success_criteria 措辞 | maestro 4 镜像 + prepare/maestro.md | 中（需确认所有下游引用） |
| P3 | M3：A_AMEND 改为 typed proposal + `--apply-proposal`；`session meta update` 保留为显式 legacy 标注 | maestro 4 镜像 + ralph-amend-goal.md 交叉核对 | 中 |
| P4 | M1：建链协议改双分支——canonical（identity → execution start → bootstrap surface）+ 显式 legacy 回退（`--chain-file`，带 §Legacy 标注与适用条件）；`prepare/maestro.md` §4 重写 | maestro 4 镜像 + prepare/maestro.md + guide | 高（依赖 P0 结论） |
| P5 | N2：maestro-next 标准通道对齐或显式 lite 边界声明；S1 全量（Step 1/2、E002、DAG 判定改 Execution 维度） | next/seal 各 4 镜像 + prepare/execute.md | 中 |

每阶段独立提交，跑 §3.3 四个脚本 + `scripts/__tests__/session-run-lint.test.mjs`、
`session-run-contract-parity.test.mjs`；P4 另需手工用例：`/maestro "<窄意图>"` 在
canonical 与 legacy 两分支各走通一次建链。

## 5. 设计原则

1. **单一权威**：同一动作在提示词中只保留一条 canonical 命令；legacy 只出现在
   显式标注的兼容分支里（对齐 run-loop §Legacy 的"must remain visibly labeled"）。
2. **不发明新语义**：迁移只做"提示词向已定稿协议对齐"，不新增协议行为；协议本身
   的缺口（如 bootstrap surface）走 CLI 任务，不用提示词绕过。
3. **镜像同步**：每个改动同时落 `.claude`/`.codex`/`.agy`/`.agents` 四镜像，
   由 mirror lint 守护。
4. **ralph 为参照**：ralph 命令文件已完成同类迁移（invariant 6"canonical mutation
   uses exact Execution-aware commands"），措辞与结构可直接复用。

## 6. 未决事项（迁移时需裁决）

- reground 熔断阈值：`maestro-ralph.md` transitions/`prepare/ralph.md` 为 ≥60，
  A_EVALUATE 为 ≥80，60–79 区间行为未定义（本方案不裁决，列入 P2 前决策）。
- E003/E004 错误码归属：odyssey 入口与 odyssey-base 各有一套语义，需统一码表。
- `maestro.md` S_FALLBACK 与 `maestro-ralph.md` S_AMEND/S_FAIL/S_RESOLVE 的
  缺失出边（状态机完整性，独立于 legacy 迁移，可并入 P1）。
