<!-- session-mode: inherited -->

<required_reading>
@~/.maestro/workflows/run-mode.md
</required_reading>
# Workflow: merge

## Step 1: Parse Arguments and Flags

```
Timestamps use UTC+8 ISO format throughout.

Parse from $ARGUMENTS:
  --session <id>  → sessionId (session_id or intent slug)
  --force         → force (skip incomplete-run confirmation)
  --dry-run       → dryRun (preview only)
  --no-cleanup    → noCleanup (keep worktree after merge)
  --continue      → continueMode (resume after conflict resolution)
```

---

## Step 2: Validate Context

```
Reject: .workflow/worktree-scope.json present (E001 — must run from main worktree).
Require: .workflow/worktrees.json (E002 — nothing to merge without registry).
Require: sessionId provided (E004).
Read registry from worktrees.json.
```

---

## Step 3: Registry Health Check

```
Detect worktree entries whose directories no longer exist.
If stale entries found → warn (W001), remove from registry, rewrite worktrees.json.
```

---

## Step 4: Resolve Merge Target

```
--continue → load target from .workflow/.merge-state.json (E003 if missing), skip to Step 7.
Otherwise → find active worktree for sessionId in registry.
  Match by session_id exact or intent slug.
  E004 if no session specified.
If no matching target → display active worktrees and exit.
```

---

## Step 5: Validate Readiness

```
Check Run completeness in worktree: inspect .workflow/sessions/{sessionId}/runs/
  for sealed vs active/pending runs.
If incomplete runs and not --force → warn (W002), confirm with user.
If --dry-run → display merge preview (branch, session, run status) and exit.
```

---

## Step 6: Stage 1 — Git Merge

```
6a: Pull main into worktree branch (cd {target.path} && git merge main --no-edit).
    On conflict → warn (W003), instruct to resolve in worktree, exit.

6b: Merge worktree branch into main (git merge {target.branch} --no-ff).
    On conflict → save .workflow/.merge-state.json {target, stage:"git_merge_conflict"},
    instruct: resolve, git merge --continue, then /maestro-merge --continue. Exit.

Display "Git merge successful."
```

---

## Step 7: Stage 2 — Artifact Sync

```
7a: Copy session Run artifacts from worktree → main .workflow/sessions/{sessionId}/.
    Sync: session.json, artifacts.json, runs/, context.md, evidence.json, knowhow/, specs/.

7b: Merge artifact registries — update existing by ID, append new entries.

7c: Record in mainState.transition_history:
    { session_id, session_intent, action:"worktree_merge", completed_at, branch }

7d: Merge accumulated_context — deduplicate key_decisions, append deferred items.

Update mainState.last_updated, write .workflow/state.json.

7e: Update session status in state.json.sessions[] if all runs sealed.

7f: Clear session lifecycle fork marker — set session.json.lifecycle.forked_from = null
    in main .workflow/sessions/{sessionId}/session.json.
```

---

## Step 8: Cleanup

```
Unless --no-cleanup: remove git worktree and delete branch.
Remove target entry from worktrees.json registry.
Clean up .workflow/.merge-state.json if present.
```

---

## Step 9: Summary

```
Display:
  === MERGE COMPLETE ===
  Session:    {target.session_id} — {target.session_intent}
  Branch:     {target.branch}
  Runs:       {sealedCount}/{totalRuns} sealed

  State:   .workflow/state.json updated
  Session: .workflow/sessions/{sessionId}/ synced

  Next steps:
    /maestro-session-seal           -- Seal merged session (knowledge extraction + DAG progression)
```
