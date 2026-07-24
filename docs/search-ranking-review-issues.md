# Maestro Search 排序修复 Review 问题清单

> 日期：2026-07-24  
> 审查范围：提交 `a47ef102` 中 RF-001..RF-012 的修复  
> Review Run：`20260723-006-review`  
> Verdict：**BLOCK**

## 总评

Deep review 覆盖 34 个变更文件和 correctness、security、performance、architecture、maintainability、best-practices 共 6 个维度。

| 严重级别 | 数量 |
|----------|------|
| Critical | 0 |
| High | 17 |
| Medium | 12 |
| Low | 0 |
| 合计 | 29 |

RF-003、RF-006、RF-009、RF-011、RF-012 仍为 **UNMET**，RF-007 为 **PARTIAL**。因此当前实现不能进入最终 Test 或发布阶段。

完整逐项证据、snippet、影响和修复建议以 canonical artifact 为准：

- `.workflow/sessions/maestro-search-ranking-exec-20260723-102551/runs/20260723-006-review/outputs/review-findings.json`
- `.workflow/sessions/maestro-search-ranking-exec-20260723-102551/runs/20260723-006-review/outputs/issue-candidates.json`

本文是面向修复规划的合并视图，不替代上述正式产物。

## 一、阻断性根因

### P0-01：Restore write-before-checkpoint 状态无法收敛

- Finding：CORR-001、ARCH-003
- 位置：`src/tools/knowhow-lifecycle.ts:1294`、`src/tools/knowhow-lifecycle.ts:1321`
- 对应要求：RF-003

Target 已写成 `restoreHash`、但 `completed` checkpoint 尚未持久化时，replay 仍按 pending target 的 `afterHash` 校验，从而把合法 crash 中间态误判为 conflict。

影响：

- Crash recovery 不能自动收敛；
- 多 target restore 会停留在部分恢复状态；
- 错误 conflict receipt 会持续阻断后续 replay。

修复方向：

- 将 `completed=false && actualHash===restoreHash` 建模为合法 reconciliation 状态；
- 只补写 completed checkpoint，不重复写 target；
- 增加 target 写入后、checkpoint 前的 fault hook 和 crash matrix。

### P0-02：Restore receipt 不能独立验证自身 outcome

- Finding：CORR-002、SEC-003、ARCH-004、BP-002
- 位置：`src/tools/knowhow-lifecycle.ts:1101`、`src/tools/knowhow-lifecycle.ts:1137`
- 对应要求：RF-009

`resultHash` 从 sibling intent 计算，而不是从 persisted receipt 自身的 `status`、`targets`、`conflict` 计算。`conflict` 证据可以被修改而不触发 hash 失败；同时 terminal intent 缺少严格状态不变量。

影响：

- Conflict path、expected hash、actual hash 可被篡改；
- Pending intent 可被伪造成 completed；
- 系统可能生成“一个目标都未恢复”的虚假成功 receipt。

修复方向：

- 在 JSON 边界执行严格 runtime schema 校验；
- 从 receipt 自身 canonical outcome 重算 `resultHash`；
- 将 receipt outcome 与 intent 全字段交叉绑定；
- 强制 completed/conflict/pending 的状态机不变量；
- 增加逐字段 tamper matrix。

### P0-03：Release gate 没有 post-child artifact fence

- Finding：CORR-003、SEC-001、ARCH-002、BP-001
- 位置：`scripts/check-search-ranking-release-machine.mjs:869`、`:913`
- 对应要求：RF-006

Release machine 在执行 built children 前读取并认证 artifacts，children 完成后只重读少量 knowhow sentinel，最终仍返回 child 前的 hashes。

影响：

- Child、并发 build 或 atomic replacement 可在认证后替换发布文件；
- 绿色 verdict 不能证明最终发布 bytes 就是已测试 bytes；
- `artifactHashes` 可能指向已经失效的旧内容。

修复方向：

- 初始读取时保存 `realpath/dev/ino/size/mtime/hash` certificate；
- 所有 mutable children 完成后重验全部 certified artifacts；
- 任一变化统一失败为 `ARTIFACT_POST_CHILD_CHANGED`；
- Verdict、scanner 和返回 hashes 只能使用 post-child 重读结果；
- 增加 in-place mutation、atomic replacement、realpath retarget fault tests。

### P0-04：Artifact pathname 与 opened fd 未绑定

- Finding：SEC-004
- 位置：`scripts/check-search-ranking-release-machine.mjs:350`
- 对应要求：RF-006

当前逻辑只分别证明 pathname 前后稳定、fd 前后稳定，没有证明 pathname 与 fd 指向同一 inode。

影响：

- `realpath` 与 `open` 之间的瞬时替换可让 gate 读取另一个 inode；
- 瞬时 symlink 可能越过 workspace containment；
- Fixture、production source 和 executable 的认证均可受影响。

修复方向：

- 使用 `O_NOFOLLOW` 或平台等价能力；
- 比较 pathname `lstat` 与 fd `fstat` 的 `dev/ino/mode`；
- 读取后再次比较 fd 与最终 pathname 的完整 stable state；
- 优先复用仓库已有 verified-file 模式。

### P0-05：Pi release contract 可空样本通过

- Finding：CORR-004、ARCH-005
- 位置：`scripts/check-search-ranking-release-machine.mjs:889`
- 对应要求：RF-012

Pi primary/holdout 使用嵌套 `Array.every()` 判定。空数组或空 `targetIds` 会 vacuous pass；release verdict 也没有 absolute Recall@20 和非零 denominator。

影响：

- 不执行有效 Pi 查询也能得到绿色 verdict；
- Pi 召回完全退化时仍可能发布；
- 0.899 等阈值边界无法被机器拒绝。

修复方向：

- 提取 production-owned `validatePiReleaseContract()`；
- Primary 和 holdout 各至少 2 条；
- Query、ID、canonical targets 唯一、非空且两组 disjoint；
- 固定或强化 `topK=5`、`recallAt=20`、`minRecall>=0.90`；
- 计算并暴露 `piPrimaryCount`、`piHoldoutCount`、`piRelevantCount`、`piRecallAt20`；
- 在任何 child spawn 前拒绝非法 contract。

### P0-06：Lifecycle lock 仍有 generation race

- Finding：CORR-005、SEC-005、BP-004
- 位置：`src/tools/knowhow-lifecycle.ts:412`、`:428`、`src/tools/knowhow-lifecycle-async.ts:129`
- 对应要求：RF-011

验证 lock generation 后仍通过 pathname 调用 `unlinkSync(lockPath)`。验证与删除之间可以产生 replacement generation，随后被旧 owner 删除。Worker 强制终止还可能留下共享 PID 的永久 lock；部分写入的 malformed lock 同样无法自动回收。

影响：

- Lifecycle mutual exclusion 失效；
- Supersede、recover、snapshot 和 restore 可以并发交错；
- MCP 服务可能持续阻塞直到重启。

修复方向：

- 使用 OS-backed lock 或原子 handle-bound lock；
- 不再依赖 pathname compare-and-delete；
- Worker 使用协作取消和独立 lease identity；
- 覆盖双 contender、timeout、空 lock、截断 JSON 的真实并发测试。

### P0-07：Lifecycle containment 存在 pathname TOCTOU

- Finding：SEC-002
- 位置：`src/tools/knowhow-lifecycle.ts:502`
- 对应要求：RF-007

`resolveLifecyclePath()` 完成 containment 检查后，后续 read/write/delete 仍按字符串路径执行。父目录可以在检查和实际 I/O 之间被替换为 symlink 或 junction。

影响：

- 可能读取 projectRoot 外文件；
- Snapshot 可能泄露外部内容；
- Restore、supersede 或 recovery 可能覆盖、创建或删除外部文件；
- 写入后的再次检查无法撤销已发生的外部 mutation。

修复方向：

- 建立 handle-relative、no-follow 的 secure filesystem abstraction；
- 在同一已验证 parent handle 下完成 read/create/unlink/rename；
- Windows 拒绝 reparse point，Linux 使用 `openat2/openat` 等 beneath/no-symlink 约束；
- 若暂时无法提供安全原语，只能限制 lifecycle 在攻击者不可写的 staging workspace 中运行。

### P0-08：MCP lifecycle Worker 无并发上限

- Finding：PERF-003
- 位置：`src/tools/knowhow-lifecycle-async.ts:76`

每个请求都会创建独立 Worker/V8 isolate，没有 pool、per-project lane、并发上限、队列深度或背压。

影响：

- 请求突发会线性增加线程、V8 heap 和文件扫描；
- Lock contention 时大量 Worker 可同时存活至 timeout；
- MCP 进程可能 OOM 或无法服务其他工具。

修复方向：

- 按 canonical `projectRoot` 串行化 lifecycle 请求；
- 增加全局 bounded Worker pool；
- 设置有限 queue 和 `KNOWHOW_LIFECYCLE_BUSY`；
- Timeout 覆盖排队与执行总 deadline；
- 可进一步使用每项目 persistent Worker。

### P0-09：Execution evidence 未绑定实际测试字节

- Finding：ARCH-001
- 位置：`.workflow/sessions/maestro-search-ranking-exec-20260723-102551/runs/20260723-005-execute/outputs/execution.json:17`

Execution artifact 只记录短 commit、任务状态和聚合计数；change manifest 只记录路径和 task refs，没有 commit tree、file blob 或 gate receipt。

影响：

- 无法证明测试运行于最终 commit 的精确字节；
- Dirty worktree 中的实现可能被错误归入 sealed execution；
- Downstream Run 可能复用 false-green 完成证据。

修复方向：

- 记录 full commit SHA、tree SHA、plan hash 和 manifest hash；
- 每个文件记录 before/after blob ID；
- Gate receipt 记录 argv、cwd、exit code、stdout/stderr hash、tested tree 和 post-gate tree；
- 将每项 RF acceptance criterion 绑定到具体测试 receipt。

## 二、中优先级独立问题

| ID | Finding | 问题 | 位置 | 修复方向 |
|----|---------|------|------|----------|
| P1-01 | CORR-006 | 显式 ID replay 忽略 `lang/source/assetType/codePaths/specCategory/tool` 等 caller-owned metadata | `src/utils/frontmatter.ts:212` | 将所有 caller-owned 持久字段纳入 replay equality |
| P1-02 | PERF-001 | 默认非 linked mixed 搜索也将候选池扩大约 3 倍，并与 Wiki 内部扩池叠加 | `src/commands/search.ts:582` | 默认路径保持用户 limit，仅对 linked provider 渐进扩池 |
| P1-03 | PERF-002 | Exact Knowledge FTS 已填满 limit 时仍执行宽泛 OR 查询 | `src/graph/kg/db/queries.ts:641` | Exact 已满足 requested limit 时提前返回 |
| P1-04 | BP-003 | Source release gate 未包含 release-machine 自测和 MCP lifecycle worker 回归测试 | `scripts/check-search-ranking-release-machine.mjs:41` | 扩展精确 ownership matrix 和 `node --test` phase |

## 三、可维护性问题

| Finding | 问题 | 位置 |
|---------|------|------|
| MAINT-001 | Release machine 保留约 180 行废弃 shadow ranking/latency 死代码 | `scripts/check-search-ranking-release-machine.mjs:537` |
| MAINT-002 | Ranking metrics 和 special-case scanner 与 canonical evaluator 重复且已发生语义漂移 | `scripts/check-search-ranking-release-machine.mjs:593` |
| MAINT-003 | RF-001 回归测试依赖源码字符串，而不是可观察运行时行为 | `src/search/evaluation/relevance-evaluator.test.ts:368` |
| MAINT-004 | `runCodeSearch` 使用 6 个位置参数和相邻 boolean，调用含义不清晰 | `src/commands/search.ts:499` |
| MAINT-005 | Lifecycle API 将 lock timeout、unsafe path、not found、cycle 等全部映射为 `CONFLICT` | `src/tools/knowhow-lifecycle.ts:893` |
| MAINT-006 | Restore 状态机、filesystem mutation、checkpoint 和 receipt 集中在一个 178 行函数中 | `src/tools/knowhow-lifecycle.ts:1195` |

建议在 P0 根因闭合后处理，避免可维护性重构扩大关键修复的变更面。

## 四、完整 Finding 索引

| 维度 | High | Medium |
|------|------|--------|
| Correctness | CORR-001、CORR-002、CORR-003、CORR-004、CORR-005 | CORR-006 |
| Security | SEC-001、SEC-002、SEC-003、SEC-004 | SEC-005 |
| Performance | PERF-003 | PERF-001、PERF-002 |
| Architecture | ARCH-001、ARCH-002、ARCH-003、ARCH-004、ARCH-005 | — |
| Maintainability | — | MAINT-001、MAINT-002、MAINT-003、MAINT-004、MAINT-005、MAINT-006 |
| Best practices | BP-001、BP-002 | BP-003、BP-004 |

## 五、建议修复顺序

1. Restore crash reconciliation 与 receipt 自验证；
2. Lifecycle lock、Worker cancellation 和 containment；
3. Release artifact pathname/fd identity 与 post-child fence；
4. Pi contract validator 和 absolute Recall@20；
5. Execution evidence content attestation；
6. Worker backpressure、默认搜索性能和 release test ownership；
7. 可维护性清理。

每组修复应包含：

- 对应 finding/RF 映射；
- 负向 fault injection；
- 独立 source test；
- 恰好一次 build；
- Built-only machine gate；
- Post-gate tree/artifact identity 证明。

## 六、当前状态说明

- Review Run 已以 `done-with-concerns` 封存，Review verdict 为 `BLOCK`；
- 后续 Test Run `20260723-007-test` 已创建；
- Test Run 的 `latest-review` reuse assessment 为 `REJECT / QUALITY_LOW`；
- `GATE-007-01` 当前阻塞，不能通过 `-y`、自动提示词或人工伪造上游来继续；
- Runtime 推荐先进入新的 full fix `plan` loop。

Review 期间工作树出现了未提交的 lifecycle 修复差异。这些差异不属于 sealed commit `a47ef102`，本文不会把它们计为已解决，也不会覆盖或回退它们。
