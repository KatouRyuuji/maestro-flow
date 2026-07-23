<!-- session-mode: inherited -->
# Canonical Orchestrator Run Loop

Canonical lifecycle reference: `@~/.maestro/workflows/run-mode.md`.

Maestro 与 Ralph 共享这一执行循环。它只调用 `maestro run ...`；Session 与 Run 协议文件始终由 Runtime 写入。

## Public flags

- `-y`：自动确认低风险选择；不得越过高风险、低置信度、边界歧义或 drift 熔断。
- `-c`：继续唯一 live compatible Session。多个候选必须询问，paused Session 进入 audited recovery。
- `--amend`：修改唯一 live Session 的目标；剩余文本为 change request。

除以上 3 个 flags 外，其余文本全部视为 intent。Roadmap、quality、executor、platform、模板复用、并行与对抗策略由 intent、Session state、Skill contract 和 host runtime 推断。

## Authority

- Session 是 topic grouping/index；`session.json.orchestration` 是 chain/goal/decision 唯一真相源。
- Run 是一次执行 attempt；Run 的 outputs、handoff、gate、proposal 与 transition receipt 归该 Run。
- Skill 决定领域结果及可选 `chain-proposal/1.0`；orchestrator 决定 accept/reject/revise；Runtime 独占 chain mutation。
- historical similarity 只读；同 Session sealed outputs 只经 birth packet 的 canonical `upstream` 复用。

## Lifecycle

### 1. Resolve or create

1. `-c` / `--amend`：用 `maestro run recall <command> --intent "{intent}" --json` 定位唯一 live Session。
2. 新 intent：分类并构建 chain definition。每个 execution step 只声明 `command/args/stage/goal_ref/retry_max`；decision step 声明 `decision_ref`。
3. 用临时 JSON 文件创建，不把未转义 JSON 拼入 shell：

   `maestro run start "{intent}" --id {slug} --chain-file {path} --no-dispatch`

4. Runtime resolver 在 `run next` 分配 Run 前校验 command、Skill 和 lifecycle step；prompt 不调用独立 catalog CLI。

### 2. Locate and allocate

1. `maestro run status {session_id}` 读取 canonical 状态。
2. execution step：显式调用 `maestro run next --session {session_id} --json`。只有该动词能分配下一 Run。
3. decision step：不创建 Run，转 Decision evaluation。
4. `CHAIN_COMPLETE`：校验 goals 与 gates 后转 Session seal。

### 3. Load and execute one Run

1. 从 birth packet 取得 `run_id/run_dir/upstream/previous_handoff/queue/goal`。
2. `maestro run brief {run_id} --session {session_id}` 加载 Resume Packet 与 Skill 正文。
3. 派发一个 unnamed `run-executor`；executor 只执行该 Run，可按 Skill 自身 contract 选择串行、并行或对抗实现。
4. executor 写 formal artifacts 到 `{run_dir}/outputs/`，handoff 写 `{run_dir}/report.md`，然后运行 `maestro run check {run_id} --session {session_id}`。
5. executor 不调用 `run done/complete`；completion authority 属于 orchestrator。

### 4. Analyze, gate, and complete

从 executor 结果提取：

- `summary`：必须，动词开头，≤100 字。
- `evidence`：验证产物路径。
- `decision`：非显而易见的技术决策。
- `note`：concern、deferred 或 minor drift。

Drift policy：

| Result | Action |
|---|---|
| aligned | `run done --verdict done` |
| minor drift | `run done --verdict done-with-concerns --note ...` |
| major drift，未重试 | `run done --verdict needs-retry` |
| major drift，已重试 | `run done --verdict done-with-concerns` |
| external blocker | `run done --verdict blocked --reason ...` |

日常 completion：

`maestro run done {run_id} --session {session_id} --verdict {verdict} --summary "{summary}" [--evidence ...] [--decision ...] [--note ...]`

Runtime 返回的 next 仅为 `suggest_only`；orchestrator 明确接受后才再次调用 `run next`。

### 5. Chain proposal

`run check` 自动发现并校验当前 Run outputs 中的 typed `chain-proposal/1.0`。

- accept：必须恰好有一个 valid proposal，调用 `run done ... --apply-proposal`；proposal 与 completion 在同一事务应用。
- reject：不传 `--apply-proposal`，以 `--note` 记录理由。
- revise：不 complete；用同一 `run_id` 重新加载 `run brief`，让原 Skill 修订后再次 check。

`-y` 仅可自动接受：proposal valid、只修改 pending tail、未越 budget、intent aligned、无 escalate。路径参数 `--chain-proposal` 只保留 legacy compatibility，不在 orchestrator 中使用。

### 6. Decision step

1. 派发一个只读 generic evaluator，读取对应 Run artifacts 与 goal evidence。
2. 严格解析 `proceed|fix|escalate`；解析失败降级为 `fix`，confidence=low，并在 summary 标记 `parse_failed=true`。
3. 调用：

   `maestro run decide {point_id} --session {session_id} --verdict {verdict} [--confidence high|medium|low] [--summary "..."] [--evidence ...]`

4. `fix` 需要改变 pending tail 时，必须由 repair Skill 产生 proposal；prompt 不直接复制 fix-loop template。

### 7. Recovery and amend

Paused recovery 仅由显式 `-c` 触发：

1. `run status` 读取 exact blocker 与 revisions。
2. 每个 blocker 经用户选择后调用 `maestro run recover --session {id} ... (--decision {point}|--step {step}) --disposition {value}`。
3. blockers 清零后调用 `maestro run recover --resume --session {id} ...`。
4. resume 只恢复 Session；下一 Run 仍由显式 `run next` 分配。

Goal amend：读取 `ralph-amend-goal.md`，完成 snapshot → impact audit → confirmation → 通过 `maestro run edit --decomposition-file -` 整块更新 → planning Skill proposal。高风险修改不受 `-y` 影响。

### 8. Seal

所有 execution Runs sealed、decision steps terminal、goals done、Session gates clean 后：

`maestro run seal-session {session_id} --summary "..."`

## Failure rules

- `run check` blocking：重新附着同一 Run 修复，不得报告成功或分配新 Run。
- executor failed/null：首次 `needs-retry`；达到 retry budget 后 `blocked` 并暂停。
- lease/revision conflict：停止并重新读取 status，不猜测或 force。
- sealed/archived Session：终态，`run next` 应返回 `CHAIN_COMPLETE`，不得 resume。
