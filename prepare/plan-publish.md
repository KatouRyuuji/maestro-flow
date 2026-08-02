---
name: plan-publish
description: Publish an approved Pi Markdown Plan through the canonical Run artifact lifecycle
session-mode: run
contract:
  contract_version: 2.1
  arguments: []
  consumes: []
  produces:
    - path: outputs/plan.json
      kind: plan
      alias: current-plan
      role: primary
      required: true
      schema: plan/1.0
  gates:
    entry: []
    exit: []
---

# Plan Publish

CLI-owned producer contract for approved Pi Plans.
