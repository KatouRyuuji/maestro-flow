---
name: maestro-knowledge
disable-model-invocation: true
description: Intent-driven knowledge-store and Run knowledge lifecycle management — audit/prune, inspect Session candidates, record Run relations, stage candidates, promote reviewed knowledge, harvest artifacts, or manage wiki/domain knowledge.
argument-hint: "[intent — e.g. '审计知识库' | 'harvest 这个 session' | 'wiki health' | '注册术语 MVP' | 'extractors']"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - WebFetch
  - AskUserQuestion
session-mode: brief
---

<purpose>
Intent-driven knowledge-store management. No fixed grammar — state your intent; the command classifies it and runs the matching workflow or direct lifecycle command. Explicit keywords still work as deterministic shortcuts.

| Operation | Keywords | Step |
|-----------|----------|------|
| audit | `audit` / 审计 / 清理 / prune / 检查知识库 | `knowledge-audit` |
| session | `session` / 候选 / backlog / reconciliation | `maestro knowledge session <session-id>` |
| record | `record` / cited / validated / contradicted / 记录命中关系 | `maestro knowledge record ...` |
| stage | `stage` / 暂存 / candidate / 沉淀候选 | `maestro knowledge stage ...` |
| promote | `promote` / 晋升 / 发布候选 | `maestro knowledge promote ...` |
| harvest | `harvest` / 提取 / 收割 / 从工件 | `harvest` |
| wiki | `wiki` / 知识图谱 / 连接 / 摘要 / 健康 | `wiki-manage` / `wiki-connect` / `wiki-digest` |
| extractors | `extractors` / 抽取器 / 生成抽取规则 | `extractors` |
| domain | `domain` / 领域术语 / 注册术语 / term | `domain-add` |
</purpose>

<dispatch>
Classify the intent in `$ARGUMENTS` into one operation, then run `maestro run skill <step>` and follow it completely.

1. Explicit keyword present → use its step or direct CLI lifecycle command (deterministic shortcut).
2. Otherwise infer from the intent (see the table above), e.g. "审计/清理知识库" → audit, "从工件/session 提取" → harvest, "知识图谱/wiki 健康" → wiki, "注册术语 X" → domain.
3. `session` / `record` / `stage` / `promote` map directly to the corresponding `maestro knowledge` CLI. Preserve stable knowledge IDs, Run ID, Session ID, signal, and candidate ID exactly; do not translate these operations into direct spec/knowhow writes.
4. For wiki, classify the sub-action: `connect`/连接 → `wiki-connect`; `digest`/摘要 → `wiki-digest`; `health`/`search`/`cleanup`/`stats`/健康/检查/_(none)_ → `wiki-manage`.
5. Ambiguous → display the operation table and ask the user to pick.

### Routing rules

- Remaining tokens after classification become the chosen step's own arguments.
- During an active Run, reusable knowhow is staged here with `maestro knowledge stage knowhow ...`; project knowhow is written only by explicit promotion. Outside a Run, direct `/maestro-knowhow` capture remains available.
</dispatch>
