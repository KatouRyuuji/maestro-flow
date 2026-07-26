# Team Swarm Intelligence Guide

> This document introduces Maestro's Ant Colony Optimization (ACO) team skills, including team-swarm and team-adversarial-swarm.

## Overview

Maestro provides two team skills based on Ant Colony Optimization (ACO) algorithms:

| Skill | Purpose | Features |
|-------|---------|----------|
| `team-swarm` | ACO-driven multi-agent exploration | Hybrid LLM coordinator + Python optimization controller |
| `team-adversarial-swarm` | ACO + modular Workflow + adversarial decisions | 4 composable Workflow scripts + adversarial patterns |

## Ant Colony Optimization (ACO) Principles

ACO is a metaheuristic algorithm inspired by ant foraging behavior:

1. **Pheromone Guidance**: Ants choose paths based on pheromone concentration
2. **Positive Feedback**: Quality paths attract more ants, increasing pheromone concentration
3. **Evaporation Mechanism**: Pheromones evaporate over time, preventing premature convergence
4. **Exploration vs Exploitation**: Balancing exploration of new paths and exploitation of known quality paths

In Maestro, ACO is used for:
- **Task Allocation**: Distributing exploration tasks to multiple parallel agents
- **Path Optimization**: Finding optimal analysis paths in codebases
- **Quality Convergence**: Iteratively improving analysis results

---

## team-swarm

### Purpose

Ant Colony Optimization team skill with ACO-driven multi-agent exploration.

### Core Features

- **Hybrid Coordinator**: LLM coordinator + Python ACO controller
- **Universal Task Space**: Define nodes and scoring rules via config
- **Iterative Optimization**: K iterations, N parallel ants per iteration
- **Pheromone Guidance**: Ants choose exploration paths based on pheromone state

### Architecture

```
Coordinator (LLM)
    │
    ├── ACO Controller (Python)
    │   ├── pheromone.py — Pheromone management
    │   ├── scoring.py — Scoring functions
    │   └── aco.py — Main controller
    │
    └── Ant Agents (N parallel)
        ├── Ant 1 → Explore path A
        ├── Ant 2 → Explore path B
        └── Ant N → Explore path N
```

### Use Cases

- Large-scale codebase analysis
- Multi-dimensional parallel exploration
- Complex tasks requiring iterative optimization

### Configuration Example

```json
{
  "task": {
    "objective": "Analyze codebase security vulnerabilities",
    "evidence_requirements": "Identify OWASP Top 10 risks"
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

## team-adversarial-swarm

### Purpose

ACO swarm optimization + modular Workflow composition + adversarial decision gates.

### Core Features

- **4 Composable Workflow Scripts**: explore/score/converge/synthesize
- **Adversarial Decision Patterns**: Inject adversarial agents at every decision node (prosecutor/defender/judge)
- **Python ACO Scripts**: Numerical optimization and pheromone management
- **Modular Design**: Each module independently usable or composable

### Architecture

```
SKILL.md (Coordinator)
    │
    │  Phase 1: Config Generation
    │  Phase 2: ACO Init
    │
    │  Phase 3: Iteration Loop ×K
    │  ┌──────────────────────────────────────┐
    │  │ 3a. aco.py select → assignments      │
    │  │ 3b. wf-swarm-explore → ant_results   │
    │  │ 3c. wf-swarm-score → verified_scores │
    │  │ 3d. aco.py update → pheromone        │
    │  │ 3e. wf-swarm-converge → converged?   │
    │  │ 3f. if converged: break              │
    │  └──────────────────────────────────────┘
    │
    │  Phase 4: wf-swarm-synthesize → best-solution.md
```

### Workflow Modules

| Module | Script | Adversarial Pattern | Returns |
|--------|--------|---------------------|---------|
| **Explore** | `wf-swarm-explore.js` | N ants parallel | `{ ant_results[] }` |
| **Score** | `wf-swarm-score.js` | 3-vote per ant | `{ scores{}, calibration }` |
| **Converge** | `wf-swarm-converge.js` | prosecutor/defender/judge | `{ converged, reason }` |
| **Synthesize** | `wf-swarm-synthesize.js` | 3-perspective + arbitrator | `{ report, caveats }` |

### Use Cases

- Deep analysis of complex problems
- Tasks requiring multi-round iterative optimization
- Decisions requiring adversarial validation
- Systematic auditing of large codebases

### Configuration Example

```json
{
  "task": {
    "objective": "Analyze code quality of last 100 commits",
    "evidence_requirements": "Identify quality degradation trends and causes"
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
    "nodes": ["src/commands/", "src/skills/", "docs-site/"],
    "auto_discover_from": "git log --oneline -100"
  },
  "scoring": {
    "mode": "adversarial",
    "rubric": "Coverage + Accuracy + Timeliness + Readability"
  },
  "convergence": {
    "patience": 2,
    "min_improvement": 0.01,
    "max_iterations": 4
  }
}
```

---

## Adversarial Decision Patterns

### Prosecutor/Defender/Judge

Used for pass/fail determinations:

```javascript
const debate = await parallel([
  () => agent('You are the PROSECUTOR. Argue this should FAIL...', { label: 'prosecutor' }),
  () => agent('You are the DEFENDER. Argue this should PASS...', { label: 'defender' }),
])
const verdict = await agent('You are the JUDGE. Resolve the debate...', { label: 'judge' })
```

### 3-Vote Majority

Used for quality assessments and status determinations:

```javascript
const votes = await parallel([
  () => agent('You are the STRICT voter...', { label: 'vote:strict' }),
  () => agent('You are the LENIENT voter...', { label: 'vote:lenient' }),
  () => agent('You are the OBJECTIVE voter...', { label: 'vote:objective' }),
])
const majority = resolveVotes(votes) // majority wins, tie → objective
```

### 3-Way Advocacy + Referee

Used for go/no-go decisions:

```javascript
const advocacies = await parallel([
  () => agent('You are the GO ADVOCATE...', { label: 'advocate:go' }),
  () => agent('You are the NO-GO ADVOCATE...', { label: 'advocate:nogo' }),
  () => agent('You are the CONDITIONAL ADVOCATE...', { label: 'advocate:conditional' }),
])
const decision = await agent('You are the REFEREE...', { label: 'referee' })
```

---

## Relationship with Other Team Skills

| Dimension | team-swarm | team-adversarial-swarm | team-coordinate |
|-----------|-----------|----------------------|-----------------|
| Algorithm | ACO | ACO + Workflow | Beat/Cadence |
| Agent Model | Ant | Ant + Adversarial | Worker |
| Decision Pattern | Pheromone-guided | Adversarial | Role collaboration |
| Use Case | Exploration optimization | Deep analysis | General collaboration |
| Complexity | Medium | High | Low |

### Selection Guide

1. **Exploration optimization** → Use `team-swarm`
2. **Deep analysis** → Use `team-adversarial-swarm`
3. **General collaboration** → Use `team-coordinate`
4. **Lifecycle management** → Use `team-lifecycle-v4`

---

## Best Practices

1. **Start small**: Begin with 3 ants and 2 iterations for testing
2. **Clear objectives**: Make objectives specific and measurable
3. **Reasonable configuration**: Adjust n_ants and max_iterations based on task complexity
4. **Monitor convergence**: Watch convergence_curve to avoid premature convergence
5. **Reuse configurations**: Save successful configurations as templates

---

## Related Documentation

- [Command Reference](../COMMANDS-CARD-REFERENCE.md) — Quick reference for all commands
- [Team Collaboration Guide](./team-lite-guide.en.md) — Multi-agent collaboration guide
