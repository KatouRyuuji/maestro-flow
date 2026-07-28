# Maestro 知识系统架构

> 状态：已实现  
> 更新日期：2026-07-28  
> 范围：Spec、Knowhow、Maestro Search、MaestroGraph，以及 Session/Run 知识沉淀闭环。

本文描述知识系统的权威数据、状态转换和命令协作。操作示例见
[知识管理指南](../guide/knowledge-management-guide.md)，检索算法细节见
[搜索系统指南](../guide/search-system-guide.md)，Session/Run 通用协议见
[Session-Run 架构参考](../guide/session-run-architecture.md)。

---

## 1. 设计目标

知识系统解决四个相互制约的问题：

1. **沉淀**：Run 中使用过的知识、被接受的决策和锁定约束必须有可追溯记录。
2. **复用**：搜索结果应保持相关性，同时避免单一文件、来源或历史热门知识垄断结果。
3. **演化**：新增知识在写入前必须识别重复、关联、冲突与替代关系。
4. **治理**：剪枝必须可恢复、保留演进链，并且不能把搜索曝光误当成知识正确性。

系统遵循以下不变量：

- Search 和自动注入只代表 **exposure**，不会自动提升可信度或写入 Spec/Knowhow。
- 显式 `load` 或 `knowledge record` 才能形成 Run 级消费证据。
- Run 完成只暂存 candidate，不直接修改项目知识。
- 任何 semantic duplicate、conflict 或 supersession 都必须先有 reconciliation receipt。
- 需要判断的关系由人确认；promotion 必须显式执行。
- Deprecated 知识保留在演进链中，但默认不参与搜索和注入。
- Prune 默认只生成计划；应用时先备份，再执行 soft deprecate/supersede，不做硬删除。

---

## 2. 分层数据模型

```text
┌──────────────────────────────────────────────────────────────┐
│ 项目知识源                                                   │
│ .workflow/specs/*.md          .workflow/knowhow/*.md         │
│ 约束、规则、演进链             决策、配方、参考、模板          │
└───────────────────────────────┬──────────────────────────────┘
                                │ index / extract
┌───────────────────────────────▼──────────────────────────────┐
│ 可重建投影                                                   │
│ WikiIndexer / BM25F / embedding / MaestroGraph / credibility │
│ 搜索、关系遍历、canonical ID 映射、曝光统计                  │
└───────────────────────────────┬──────────────────────────────┘
                                │ search / load / injection
┌───────────────────────────────▼──────────────────────────────┐
│ Run 知识账本                                                  │
│ knowledge-delta.json                                         │
│ inputs[]：consumed/cited/validated/contradicted              │
│ candidates[]：propose/reaffirm/supersede/contest             │
└───────────────────────────────┬──────────────────────────────┘
                                │ reconcile
┌───────────────────────────────▼──────────────────────────────┐
│ 协调凭证                                                     │
│ knowledge-reconciliation.json                               │
│ matches + evidence + disposition + eligibility + freshness  │
└───────────────────────────────┬──────────────────────────────┘
                                │ resolve / promote
┌───────────────────────────────▼──────────────────────────────┐
│ 项目知识演进                                                 │
│ created / reaffirmed / deprecated / supersedes / contested  │
└──────────────────────────────────────────────────────────────┘
```

各层只拥有本层事实：

| 层 | 权威内容 | 非权威内容 |
|---|---|---|
| Spec/Knowhow 源文件 | 正式知识正文、状态、演进关系 | 搜索排名、Run 使用情况 |
| 搜索/KG 投影 | 可查询索引、图关系、曝光计数 | 知识是否正确、是否应 promotion |
| Run ledger | 本 Run 使用和候选事实 | 项目知识最终状态 |
| Reconciliation receipt | 某个 candidate snapshot 对某个 corpus 的匹配结论 | 永久有效的人工裁决 |
| Session summary | 跨 Run 聚合、corroboration | 单个 Run 的原始证据 |

---

## 3. 身份模型

### 3.1 三种身份

搜索结果同时保留三类身份：

| 字段 | 用途 |
|---|---|
| `id` | Canonical 用户身份，可直接传给 `maestro load --id` |
| `graphId` | MaestroGraph 内部稳定节点身份 |
| `aliases[]` | 兼容旧索引或历史调用方 |

Spec KG extractor 与 WikiIndexer 使用同一 canonical 解析器。项目 Spec 子条目采用
`spec:project:{file-stem}-{NNN}`；Knowhow ID 统一小写，并保留 KG alias。调用方不得根据绝对路径或行号自行构造知识 ID。

### 3.2 Candidate 身份

Candidate ID 为 `KDC-{16 hex}`，由 `target + NFKC/小写/空白归一化后的 content`
计算。相同内容在不同 Run 中得到相同 ID，从而可以在 Session 级聚合：

- 仅一个有效源 Run：`observed`；
- 多个有效源 Run：`corroborated`。

同一 candidate 不能在 Session 内以互相冲突的 action 重复暂存。

---

## 4. 检索与多样性

### 4.1 检索边界

`maestro search` 是统一入口：

- 默认：Wiki/知识搜索；
- `--code`：仅 codegraph；
- `--kg`：MaestroGraph full-source；
- `--type`、`--category`：在候选选择前后均执行约束；
- `--include-deprecated`：显式请求历史条目；
- `--diversity balanced|off`：控制多样性选择，默认 `balanced`。

`--type knowhow --kg` 不得泄漏 codegraph 或 Spec 节点。KG 返回的 canonical `id`
必须可被 `maestro load` 回读。

### 4.2 防集中策略

Balanced 模式不是把低相关结果随机插入，而是在相关候选池中执行有界选择：

1. canonical identity 去重；
2. 同一父文档/知识家族设置 family cap；
3. KG 混合结果设置 source cap；
4. Wiki 结果使用高相关权重的 MMR，降低内容重复；
5. 当结果数足够且有曝光统计时，最多保留一个 relevance-floored exploration slot。

曝光计数只影响这个有界 exploration slot：

- 不进入基础 relevance score；
- 不影响 conflict/duplicate 判断；
- 没有计数或计数损坏时自动关闭 exploration，不影响搜索本身；
- 显式 `--diversity off` 返回纯相关性顺序。

这避免了“越常命中越靠前、越靠前越常命中”的正反馈，同时不牺牲首要结果的相关性。

---

## 5. Run 知识账本

每个 Run 可拥有 `{run_dir}/knowledge-delta.json`，schema 为
`run-knowledge-delta/1.0`。

### 5.1 输入信号

| Signal | 含义 |
|---|---|
| `consumed` | 已显式加载并用于当前工作 |
| `cited` | 在报告或产物中引用 |
| `validated` | 当前执行提供了支持证据 |
| `contradicted` | 当前执行发现反例或不一致 |

`search` 和 injection 不自动写 `consumed`。调用方通过下列命令明确归因：

```bash
maestro knowledge record <knowledge-id...> \
  --signal consumed \
  --run <run-id> \
  --session <session-id>
```

### 5.2 Candidate

Candidate 的目标只有 `spec|knowhow`，action 为：

| Action | 意图 |
|---|---|
| `propose` | 新知识 |
| `reaffirm` | 重新确认既有知识 |
| `supersede` | 用新知识替代旧知识 |
| `contest` | 提出冲突或反例 |

来源为 `manual|decision|constraint`。Run 完成时，`report.md` 中 accepted decision
和 locked constraint 会被转换成 candidate；它们仍处于 pending，不直接写项目知识。

Candidate 状态机：

```text
pending ── promote transaction ──→ promoting ── commit ──→ promoted
   │                                  │
   └── duplicate/conflict ───────────→ rejected
                                      │
                                      └── interrupted → replay-safe recovery
```

---

## 6. Reconciliation：写入前知识协调

### 6.1 Receipt

`maestro knowledge reconcile` 生成
`{run_dir}/knowledge-reconciliation.json`，schema 为
`knowledge-reconciliation/1.0`。每个 match 保存：

- canonical knowledge ID、来源文件与行号；
- lexical、semantic、title、relation、stance、composite 分数；
- novelty 与可读 evidence；
- 目标内容 hash。

可能的 disposition：

| Disposition | 默认 eligibility | 行为 |
|---|---|---|
| `unique` | `eligible` | 可 promotion |
| `exact_duplicate` | `suppressed` | 自动拒绝重复 candidate |
| `semantic_duplicate` | `review_required` | 人工确认 duplicate/related/unique |
| `extends` / `related` | `review_required` | 人工确认关系或替代 |
| `potential_conflict` | `review_required` | 人工确认 conflict/related/unique |
| `supersede_candidate` | `review_required` | 人工确认 supersede |

Exact duplicate 可以自动 suppress；语义关系和规范立场不能只凭阈值自动裁决。

### 6.2 Freshness fence

Receipt 同时绑定：

- `candidate_snapshot_hash`：Run ledger 与 report candidates 的快照；
- `corpus_fingerprint`：当前 Spec/Knowhow corpus；
- `matcher_revision`：匹配算法版本。

任一 fence 改变，receipt 即为 stale。`resolve` 和 `promote` 对 stale/missing receipt
fail closed，必须先重新 reconcile。

### 6.3 Review surface

```bash
maestro knowledge review <session-id> [--refresh] [--json]
```

`review` 是人工审查的唯一聚合界面，展示：

- 每个 candidate 的 `missing|stale|fresh`；
- 最多 3 条多样化 match 及 evidence；
- disposition、eligibility 和 canonical target；
- 可复制的 reconcile、resolve、promote 命令。

默认 review 只读。仅在明确使用 `--refresh` 时，才刷新所有 candidate source Runs。

---

## 7. Resolve、Promotion 与演进

人工裁决命令：

```bash
maestro knowledge resolve <candidate-id> \
  --session <session-id> \
  --as duplicate|related|conflict|supersede|unique \
  [--target <knowledge-id>] \
  --reason "<evidence-backed reason>"
```

Promotion 必须显式选择：

```bash
maestro knowledge promote <session-id> --candidate <candidate-id>
maestro knowledge promote <session-id> \
  --candidate <candidate-a> \
  --candidate <candidate-b>
maestro knowledge promote <session-id> --all
```

规则：

- `--candidate` 可重复，也兼容逗号分隔；
- 显式 selection 只刷新所选 candidate 的 source Runs；
- `--all` 默认只处理 corroborated、eligible candidates；
- observed-only、review-required、suppressed candidates 会被跳过；
- promotion receipt 的 `outcome` 描述写入结果：`created|reaffirmed`；
- supersession 语义由新旧条目的 `supersedes` / `superseded-by` 和旧条目
  `deprecated` 状态表达，而不是单独的 promotion outcome。

Promotion 使用持久化 receipt 和 `promoting` 中间态，可在中断后安全重放，不重复创建条目。

---

## 8. Session/Run 协同

完整闭环：

```text
prepare/create
  → brief 注入 knowledge-reconciliation-card
  → search/load
  → record inputs
  → stage candidates
  → reconcile（完成前）
  → review/resolve
  → run check
  → run complete（seal Run + candidate receipt）
  → review freshness
  → promote selected candidates
  → session seal
```

关键边界：

- `brief` 只注入摘要、策略和下一步命令，不自动加载所有知识正文；
- `check` 全绿后，finish checklist 要求完成知识记录、reconciliation 和 verdict；
- `complete` 返回 candidate IDs 与 reconciliation summary，但不执行 promotion；
- `session seal` 可以报告未处理 backlog，不会偷偷丢弃 candidate；
- `session seal --json` 使用统一的 `run-response/1.0` envelope；
- promotion 可以发生在 Session seal 前；所有 source Runs 必须已 sealed。

---

## 9. Audit 与安全剪枝

```bash
maestro knowledge audit --scope spec|knowhow|all
maestro knowledge audit --scope all --prune
maestro knowledge audit --scope all --prune --apply
```

Audit 组合检查：

- schema 与 ledger 完整性；
- pending observed/corroborated backlog；
- duplicate、supersession、conflict 和 lifecycle 状态；
- exposure/consumption concentration；
- 演进链与孤立引用。

安全剪枝分两阶段：

1. `--prune` 只生成 deterministic soft-prune plan；
2. `--apply` 先把受影响文件备份到
   `.workflow/.trash/knowledge-audit-{timestamp}/`，再原子应用 deprecate/supersede。

系统不依据“低命中”直接删除知识。低曝光可能代表长尾价值，而不是无效；冲突和重复必须保留证据与演进关系。

---

## 10. 命令协作矩阵

| 阶段 | 命令 | 写入 |
|---|---|---|
| 检索 | `maestro search` | 最多写 exposure counter |
| 读取 | `maestro load` | 可记录显式 consumption |
| 归因 | `maestro knowledge record` | Run `knowledge-delta.json` |
| 暂存 | `maestro knowledge stage` | Run candidate |
| 匹配 | `maestro knowledge reconcile` | Reconciliation receipt |
| 审查 | `maestro knowledge review` | 默认只读；`--refresh` 重建 receipt |
| 裁决 | `maestro knowledge resolve` | Confirmed resolution + candidate 状态 |
| 提升 | `maestro knowledge promote` | Spec/Knowhow + promotion receipt |
| 治理 | `maestro knowledge audit` | 默认只读；`--apply` soft prune |
| 收口 | `maestro session seal` | Session sealed 状态 |

所有 knowledge 子命令支持 `--workflow-root`，便于在隔离项目、脚本和测试中使用。

---

## 11. 验证与可观测性

推荐验证：

```bash
# 人工审查
maestro knowledge review <session-id> --json

# 项目知识健康
maestro knowledge audit --scope all --prune --json
maestro spec health --json

# 搜索类型隔离与 canonical ID 回读
maestro search "<query>" --type knowhow --kg --read-only-probe --json
maestro load --type knowhow --id <canonical-id> --list --json

# Release gates
npm run check:search-ranking-release-machine:source
npm run build
npm run check:search-ranking-release-machine:built
npm run check:session-run-contract-parity
npm run check:session-run-release-machine
```

端到端回归用例位于 `src/commands/knowledge.test.ts`，覆盖：

`record → stage → review → resolve → complete → promote → seal → search readback`。

---

## 12. 设计总结：Evidence-Fenced Knowledge Compiler

该系统可以视为一个 **证据围栏知识编译器**：

```text
Run observations
  → candidate IR
  → semantic reconciliation
  → freshness/type checks
  → human resolution
  → transactional promotion
  → searchable projection
```

创新点不在于增加一个相似度阈值，而在于把“搜索到”“使用过”“认为正确”“允许写入”
拆成四种不同事实，并用 receipt 和 freshness fence 连接。这样既能自动发现知识关系，又不会让搜索热度、模型判断或单次 Run 越权修改项目规范。
