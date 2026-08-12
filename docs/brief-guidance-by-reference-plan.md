# Brief Guidance 引用化方案（brief-result/1.3）

> 状态：提案。解决 `run brief` 对 prepare/workflow 全文注入在单上下文长链场景下的上下文膨胀问题，
> 并将 guidance 三元组（prepare / workflow / run-mode）的送达策略统一为"引用 + 按需拉取"。

## 1. 背景

当前三个通道对同一份 guidance 采取三种不一致的策略：

| 通道 | prepare | workflow | run-mode |
|---|---|---|---|
| `run next` birth packet | 无正文（仅 refs 清单） | 明确禁运（`next.test.ts` 断言） | 无 |
| `run prepare <step>` | **全文** | 仅 `{path, line_count}` | 仅 `{path, summary}` |
| `run brief` | **全文** | **全文** | 仅 `{path, hash}`（1.2 已引用化） |

run-mode 在 brief-result/1.2 已完成引用化（`briefRunModeRefSchema`，由 Skill
`@required_reading` 负责加载，brief 只带哈希做新鲜度校验）。prepare/workflow 是这条演进
路线上尚未走完的两段。

**膨胀面**：规范编排下每步派发全新 run-executor，brief 落在一次性上下文中，不累积。
真正膨胀的是单上下文多步执行——编排者消费 `--inline-brief`、或自启动模式同一会话连续
执行多个 step 时，每步 5–20KB 的转换后全文线性堆积。

## 2. 硬约束（为什么不能改成裸路径）

1. **平台转换发生在运行时**。brief 注入的内容经过 `transformContentForPlatform()`
   （`runtime.ts` briefRun 路径）；磁盘文件是 claude 风味源文件。裸路径引用会让
   codex/agy/pi 执行器读到未转换正文（错误的工具名与协议块）。
   → 引用必须携带**拉取命令**而非仅文件路径。
2. **Pi bridge 自足性**。`briefResultV10Schema` 注释声明顶层 `upstream` 是 Pi 兼容投影，
   guidance 自足性有既存消费方。→ 需要内联兼容开关与迁移窗口。
3. **新鲜度守护不能退化**。现有 `guidance.freshness`（captured/current 快照哈希比对）
   必须在引用化后继续生效——引用体自带 hash 即可满足。

## 3. Schema 变更

### 3.1 新增引用体（protocol-schemas.ts）

```ts
/** Guidance by-reference: executor pulls platform-transformed full text on demand. */
const briefGuidanceRefSchema = z.object({
  path: z.string(),
  hash: sha256Schema.nullable(),        // 与 guidance_snapshot 同源
  line_count: z.number().int().nonnegative(),
  /** Stateless pull verb returning platform-transformed content, e.g.
   *  `maestro run skill <step> --platform <resolved_platform>` */
  pull_command: nonEmptyString,
  /** Inline compatibility: full transformed text when --inline-guidance; null in ref mode. */
  content: z.string().nullable(),
}).strict();
```

### 3.2 brief-result/1.3

```ts
export const briefResultV13Schema = briefResultV12Schema
  .omit({ schema_version: true, guidance: true })
  .extend({
    schema_version: z.literal('brief-result/1.3'),
    guidance: z.object({
      prepare: briefGuidanceRefSchema.nullable(),
      workflow: briefGuidanceRefSchema.nullable(),
      run_mode: briefRunModeRefSchema.nullable(),   // 不变
      refs: /* 不变 */,
      goal_mode: /* 不变 */,
      freshness: /* 不变 */,
    }).strict(),
  }).strict();
```

要点：

- 单一 schema 承载两种模式（`content` 可空），避免 union 分叉；机器消费方以
  `content === null` 判定是否需要执行 `pull_command`。
- `run-response/1.1` 信封不动，升版只发生在 `result` 内部。
- `pull_command` 由 Runtime 用 Run 的 `resolved_platform` 渲染，执行器不自行推断平台。

### 3.3 拉取动词（已存在，无需新增代码）

`maestro run skill <step> --platform <p>` —— 无状态、无 Session 依赖、返回
`transformContentForPlatform()` 转换后的 prepare + workflow 全文（`SkillContentResult`）。
prepare 单独拉取可用 `maestro run prepare <step> [--session <id>]`（保持现状全文，它本身
就是 prepare 的拉取动词）。

## 4. CLI 面变更

| 命令 | 变更 |
|---|---|
| `run brief` | 默认输出 1.3 引用式；新增 `--inline-guidance` 填充 `content` |
| `run next --inline-brief` | 内嵌的 brief 同步遵循上述默认与开关 |
| `run prepare` / `run skill` | 不变（作为拉取动词） |

**Pi 例外**：`resolved_platform === 'pi'` 时默认 `--inline-guidance`（bridge 依赖自足包），
待 `pi-maestro-flow` 适配 1.3 后移除。

## 5. 提示词面变更

1. `workflows/run-mode.md` — dispatched-executor 段落：birth packet/brief 携带的是
   guidance 引用；执行器在自己上下文中执行 `pull_command` 获取全文，禁止直接 Read
   源文件路径（会绕过平台转换）。
2. `workflows/orchestrator-run-loop.md` 第 3 步 — 派发时传递引用而非正文；编排者
   自身不拉取 guidance 全文。
3. `src/core/entry-command-generator.ts` — execution 第 4 步（brief 可选重挂载）补充
   引用语义说明；第 1 步 `run prepare` 已是拉模式，不变。
4. `guide/session-run-architecture.md` / `guide/cli-commands-guide*.md` — 同步通道表。

## 6. 迁移步骤

| 阶段 | 内容 | 回退 |
|---|---|---|
| P1 | schema 加 1.3 + `--inline-guidance`；默认仍输出 1.2（行为零变化） | 无风险 |
| P2 | 默认切 1.3 引用式（pi 平台除外）；提示词同步落地 | `--inline-guidance` 一键回退 |
| P3 | pi bridge 适配后移除平台例外；1.2 进入 legacy 读兼容 | 保留读侧解析 |

P1/P2 间隔至少一个发布版本，用 `capabilities` 协商暴露 `brief-result/1.3` 支持位。

## 7. 测试清单

- `protocol-schemas.test.ts`：1.3 schema 往返、`content` 双模式、1.2 读兼容。
- `next.test.ts`：`--inline-brief` 引用式断言（正文不落 birth packet 的既有断言保持）；
  `--inline-guidance` 时 `content` 非空。
- `runtime` brief 测试：`pull_command` 用 `resolved_platform` 渲染；freshness 哈希与
  引用体 hash 一致。
- 契约 parity（`check-session-run-contract-parity.mjs`）与提示词 lint
  （`lint-session-run-prompts.mjs` / `lint-session-run-mirrors.mjs`）过闸。

## 8. 预期收益

以 6 步标准链（analyze→plan→execute→test→review→verify）单上下文执行估算：
每步 prepare（4–9KB）+ workflow（6–38KB）转换后合计约 15–45KB，引用化后编排者
上下文累计节省约 90–270KB；派发模式执行器改为按需拉取，成本不变（同量内容从
"推送"变"拉取"，落点仍是执行器自己的一次性上下文）。

## 9. 关联修复（已完成，本方案的前置）

maestro 规划器的 prepare 送达兜底已落地（`.claude/commands/maestro.md` 及
`.codex`/`.agy`/`.agents` 三镜像）：required_reading 缺失重读指令 + A_CREATE
`maestro run prepare maestro --json` 拉取兜底 + §1–§4 引用范围修正。引用化落地后，
规划器与执行器将同处"引用 + 按需拉取"的统一模型下。
