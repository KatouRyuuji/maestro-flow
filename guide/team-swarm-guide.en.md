# Team Swarm Intelligence Guide

> This document introduces Maestro's Ant Colony Optimization (ACO) team skill team-swarm.

## Overview

Maestro provides an Ant Colony Optimization (ACO) based team skill:

| Skill | Purpose | Features |
|-------|---------|----------|
| `team-swarm` | ACO-driven multi-agent exploration | Hybrid LLM coordinator + Python optimization controller |

> **v0.5.61 change**: the `team-adversarial-swarm` skill was removed. Its adversarial
> decision patterns (prosecutor/defender/judge, 3-vote, etc.) survive as general workflow
> patterns in `workflows/swarm/` (wf-analyze.js / wf-verify.js), reusable in any Workflow script.

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

## Adversarial Decision Patterns (general workflow patterns)

> The former `team-adversarial-swarm` skill was removed in v0.5.61, but the adversarial
> decision patterns below remain general Maestro Workflow capabilities, now carried by the
> scripts under `workflows/swarm/` (wf-analyze.js, wf-verify.js) and reusable in any Workflow script.

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

| Dimension | team-swarm | team-coordinate |
|-----------|-----------|-----------------|
| Algorithm | ACO | Beat/Cadence |
| Agent Model | Ant | Worker |
| Decision Pattern | Pheromone-guided | Role collaboration |
| Use Case | Exploration optimization | General collaboration |
| Complexity | Medium | Low |

### Selection Guide

1. **Exploration optimization** → Use `team-swarm`
2. **Deep analysis (adversarial validation)** → Use `team-swarm` + the adversarial patterns in `workflows/swarm/`
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

- [Command Usage Guide](./command-usage-guide.en.md) — Command panorama and workflow navigation
- [Team Collaboration Guide](./team-lite-guide.en.md) — Multi-agent collaboration guide
