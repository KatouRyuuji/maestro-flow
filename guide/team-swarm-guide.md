# 团队蚁群智能指南

> 本文档介绍 Maestro 的蚁群优化（ACO）团队技能 team-swarm。

## 概述

Maestro 提供基于蚁群优化（ACO）算法的团队技能：

| 技能 | 用途 | 特点 |
|------|------|------|
| `team-swarm` | ACO 驱动的多代理探索 | 混合 LLM 协调器 + Python 优化控制器 |

> **v0.5.61 变更**：`team-adversarial-swarm` 技能已删除。其对抗决策模式
> （prosecutor/defender/judge、3-vote 等）作为通用工作流模式保留在
> `workflows/swarm/`（wf-analyze.js / wf-verify.js）中，可在任意 Workflow 脚本里复用。

## 蚁群优化（ACO）原理

蚁群优化是一种模拟蚂蚁觅食行为的元启发式算法：

1. **信息素引导**：蚂蚁根据路径上的信息素浓度选择路径
2. **正反馈**：优质路径吸引更多蚂蚁，信息素浓度增加
3. **蒸发机制**：信息素随时间蒸发，避免过早收敛
4. **探索与利用**：平衡探索新路径和利用已知优质路径

在 Maestro 中，ACO 用于：
- **任务分配**：将探索任务分配给多个并行 agent
- **路径优化**：在代码库中找到最优分析路径
- **质量收敛**：通过迭代改进分析结果

---

## team-swarm

### 用途

蚁群智能团队技能，ACO 驱动的多代理探索。

### 核心特性

- **混合协调器**：LLM 协调器 + Python ACO 控制器
- **通用任务空间**：通过 config 定义节点和评分规则
- **迭代优化**：K 轮迭代，每轮 N 个并行 ant
- **信息素引导**：ant 根据信息素状态选择探索路径

### 架构

```
Coordinator (LLM)
    │
    ├── ACO Controller (Python)
    │   ├── pheromone.py — 信息素管理
    │   ├── scoring.py — 评分函数
    │   └── aco.py — 主控制器
    │
    └── Ant Agents (N parallel)
        ├── Ant 1 → 探索路径 A
        ├── Ant 2 → 探索路径 B
        └── Ant N → 探索路径 N
```

### 使用场景

- 大规模代码库分析
- 多维度并行探索
- 需要迭代优化的复杂任务

### 配置示例

```json
{
  "task": {
    "objective": "分析代码库的安全漏洞",
    "evidence_requirements": "识别 OWASP Top 10 风险"
  },
  "swarm": {
    "n_ants": 5,
    "max_iterations": 4
  },
  "aco": {
    "alpha": 1.0,
    "beta": 2.0,
    "rho": 0.1,
    "q": 1.0
  },
  "task_space": {
    "nodes": ["src/auth/", "src/api/", "src/utils/"],
    "scoring": "security_risk"
  }
}
```

---

## 对抗决策模式（通用工作流模式）

> 原 `team-adversarial-swarm` 技能已于 v0.5.61 删除，但以下对抗决策模式仍是
> Maestro Workflow 的通用能力，现由 `workflows/swarm/` 下的脚本（wf-analyze.js、
> wf-verify.js）承载，可在任意 Workflow 脚本中复用。

### Prosecutor/Defender/Judge

用于通过/失败类判定：

```javascript
const debate = await parallel([
  () => agent('You are the PROSECUTOR. Argue this should FAIL...', { label: 'prosecutor' }),
  () => agent('You are the DEFENDER. Argue this should PASS...', { label: 'defender' }),
])
const verdict = await agent('You are the JUDGE. Resolve the debate...', { label: 'judge' })
```

### 3-Vote Majority

用于质量评估、状态判定：

```javascript
const votes = await parallel([
  () => agent('You are the STRICT voter...', { label: 'vote:strict' }),
  () => agent('You are the LENIENT voter...', { label: 'vote:lenient' }),
  () => agent('You are the OBJECTIVE voter...', { label: 'vote:objective' }),
])
const majority = resolveVotes(votes) // majority wins, tie → objective
```

### 3-Way Advocacy + Referee

用于 go/no-go 类决策：

```javascript
const advocacies = await parallel([
  () => agent('You are the GO ADVOCATE...', { label: 'advocate:go' }),
  () => agent('You are the NO-GO ADVOCATE...', { label: 'advocate:nogo' }),
  () => agent('You are the CONDITIONAL ADVOCATE...', { label: 'advocate:conditional' }),
])
const decision = await agent('You are the REFEREE...', { label: 'referee' })
```

---

## 与其他团队技能的关系

| 维度 | team-swarm | team-coordinate |
|------|-----------|-----------------|
| 算法 | ACO | Beat/Cadence |
| 代理模型 | Ant | Worker |
| 决策模式 | 信息素引导 | 角色协作 |
| 适用场景 | 探索优化 | 通用协作 |
| 复杂度 | 中 | 低 |

### 选择建议

1. **探索优化** → 使用 `team-swarm`
2. **深度分析（对抗验证）** → 使用 `team-swarm` + `workflows/swarm/` 对抗模式
3. **通用协作** → 使用 `team-coordinate`
4. **生命周期** → 使用 `team-lifecycle-v4`

---

## 最佳实践

1. **从小规模开始**：先用 3 个 ant、2 轮迭代测试
2. **明确目标**：objective 要具体、可衡量
3. **合理配置**：根据任务复杂度调整 n_ants 和 max_iterations
4. **监控收敛**：关注 convergence_curve，避免过早收敛
5. **复用配置**：将成功的配置保存为模板

---

## 相关文档

- [命令使用指南](./command-usage-guide.md) — 命令全景与工作流导航
- [团队协作指南](./team-lite-guide.md) — 多代理协作指南
