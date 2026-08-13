---
title: Pi skills canonical generation from Maestro sources
description: Generate Pi skills and agents from canonical Maestro .claude sources into .pi outputs without hand-maintained mirrors.
type: recipe
category: arch
explicitId: rcp-20260723-pi-skills-canonical-generation
created: 2026-07-23T01:00:00.000Z
keywords:
  - pi
  - canonical-generation
  - buildPiSkills
  - buildPiAgents
  - generated-assets
tags:
  - pi
  - skills
  - agents
  - generation
supersedes: ["knowhow-rcp-20260716-pi-maestro-flow-cli"]
---

# Canonical Pi generation

Use `.claude/commands`, `.claude/skills`, and `.claude/agents` as the source of truth.
`buildPiSkills` generates `.pi/skills`; `buildPiAgents` generates `.pi/agents`.
The `.pi` trees are generated output and must not be hand edited.
