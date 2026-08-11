import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Pencil, Trash2, Copy, X } from 'lucide-react';
import { useAgentStore } from '@/client/store/agent-store.js';
import { useWorkspaceTree } from '@/client/hooks/useWorkspaceTree.js';
import { useGitStatus } from '@/client/hooks/useGitStatus.js';
import { useLayoutContext } from '@/client/components/layout/LayoutContext.js';
import { TreeBrowser } from '@/client/components/artifacts/TreeBrowser.js';
import { useChatSidebar, type SidebarTab } from '@/client/components/chat/ChatSidebarContext.js';
import { AGENT_DOT_COLORS, AGENT_LABELS } from '@/shared/constants.js';
import type { AgentProcess, NormalizedEntry } from '@/shared/agent-types.js';

// ---------------------------------------------------------------------------
// ChatSidebar — multi-view sidebar matching chat.html reference
// ---------------------------------------------------------------------------

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const TAB_ICONS: Record<SidebarTab, { title: string; path: string }> = {
  chat: {
    title: 'Conversations',
    path: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  },
  files: {
    title: 'Explorer',
    path: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  },
  git: {
    title: 'Source Control',
    path: '', // custom SVG below
  },
  search: {
    title: 'Search',
    path: '', // custom SVG below
  },
};

function TabIcon({ tab }: { tab: SidebarTab }) {
  if (tab === 'git') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
      </svg>
    );
  }
  if (tab === 'search') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={TAB_ICONS[tab].path} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ConversationList — list of agent processes grouped by active/completed
// ---------------------------------------------------------------------------

/** Collect all leaf nodes from the editor tree */
function collectLeaves(node: import('@/client/types/layout-types.js').EditorGroupNode): import('@/client/types/layout-types.js').EditorGroupLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

/** Copy text to clipboard */
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// ---------------------------------------------------------------------------
// SessionFilesPanel — files touched in the active session
// ---------------------------------------------------------------------------

interface SessionFile {
  path: string;
  name: string;
  ops: Set<'R' | 'M' | 'C' | 'D'>;
}

const FILE_TOOLS: Record<string, 'R' | 'M' | 'C'> = {
  Read: 'R', Glob: 'R', Grep: 'R',
  Edit: 'M', Write: 'C', NotebookEdit: 'M',
};

function extractSessionFiles(entries: NormalizedEntry[]): SessionFile[] {
  const map = new Map<string, Set<'R' | 'M' | 'C' | 'D'>>();

  for (const entry of entries) {
    if (entry.type === 'tool_use') {
      const op = FILE_TOOLS[entry.name];
      if (!op) continue;
      const p = (entry.input?.file_path ?? entry.input?.path) as string | undefined;
      if (!p || typeof p !== 'string') continue;
      const existing = map.get(p);
      if (existing) existing.add(op);
      else map.set(p, new Set([op]));
    } else if (entry.type === 'file_change') {
      const op = entry.action === 'create' ? 'C' : entry.action === 'delete' ? 'D' : 'M';
      const existing = map.get(entry.path);
      if (existing) existing.add(op);
      else map.set(entry.path, new Set([op]));
    }
  }

  return [...map.entries()].map(([path, ops]) => ({
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    ops,
  }));
}

const OP_STYLES: Record<string, { color: string; bg: string }> = {
  R: { color: 'var(--color-accent-blue)', bg: 'rgba(91,141,184,0.12)' },
  M: { color: 'var(--color-accent-yellow)', bg: 'rgba(184,149,64,0.12)' },
  C: { color: 'var(--color-accent-green)', bg: 'rgba(90,158,120,0.12)' },
  D: { color: 'var(--color-accent-red)', bg: 'rgba(196,101,85,0.12)' },
};

function SessionFilesPanel({ onSelectFile }: { onSelectFile: (path: string) => void }) {
  const activeProcessId = useAgentStore((s) => s.activeProcessId);
  const entries = useAgentStore((s) => activeProcessId ? s.entries[activeProcessId] : undefined);
  const [collapsed, setCollapsed] = useState(false);

  const files = useMemo(() => {
    if (!entries) return [];
    return extractSessionFiles(entries);
  }, [entries]);

  if (!activeProcessId || files.length === 0) return null;

  const modifiedCount = files.filter((f) => f.ops.has('M') || f.ops.has('C')).length;

  return (
    <div className="mt-1 border-t" style={{ borderColor: 'var(--color-border-divider)' }}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-[4px] w-full border-none bg-transparent cursor-pointer text-left"
        style={{ padding: '5px 6px', fontFamily: 'inherit' }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--color-text-tertiary)" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 100ms' }}>
          <path d="M2 1l4 3-4 3z" />
        </svg>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="text-[9px] font-semibold uppercase tracking-[0.04em] flex-1" style={{ color: 'var(--color-text-tertiary)' }}>
          Session Files ({files.length})
        </span>
        {modifiedCount > 0 && (
          <span className="text-[9px] font-medium px-[4px] rounded" style={{ backgroundColor: 'var(--color-tint-executing)', color: 'var(--color-accent-yellow)' }}>
            {modifiedCount} modified
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-px pb-1">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelectFile(file.path)}
              className="flex items-center gap-[5px] w-full rounded-[4px] border-none bg-transparent cursor-pointer text-left transition-colors duration-75"
              style={{ padding: '3px 7px', fontFamily: 'inherit', color: 'var(--color-text-primary)' }}
              title={file.path}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg-hover)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
            >
              <FileIcon />
              <span className="flex-1 min-w-0 text-[11px] truncate">{file.name}</span>
              <span className="flex gap-[2px] shrink-0">
                {[...file.ops].map((op) => (
                  <span key={op} className="text-[8px] font-bold px-[3px] rounded-[2px]" style={{ color: OP_STYLES[op].color, backgroundColor: OP_STYLES[op].bg }}>
                    {op}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationList({ searchQuery }: { searchQuery?: string }) {
  const processes = useAgentStore((s) => s.processes);
  const setActiveProcessId = useAgentStore((s) => s.setActiveProcessId);
  const activeProcessId = useAgentStore((s) => s.activeProcessId);
  const selectedProcessIds = useAgentStore((s) => s.selectedProcessIds);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const lastClickedId = useRef<string | null>(null);
  const { state: layoutState, dispatch: layoutDispatch } = useLayoutContext();
  const { setSidebarOpen } = useChatSidebar();

  // Select a process: set active + lazy-load entries if empty
  const handleSelect = useCallback(async (processId: string, e?: React.MouseEvent) => {
    // Multi-select: Ctrl/Cmd+Click toggles selection
    if (e && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      useAgentStore.getState().toggleProcessSelection(processId);
      lastClickedId.current = processId;
      return;
    }

    // If in multi-select mode, clicking normally adds/removes from selection
    const { selectedProcessIds: currentSel, clearProcessSelection } = useAgentStore.getState();
    if (currentSel.size > 0 && !currentSel.has(processId)) {
      useAgentStore.getState().toggleProcessSelection(processId);
      lastClickedId.current = processId;
      return;
    }
    if (currentSel.has(processId) && currentSel.size === 1) {
      clearProcessSelection();
      lastClickedId.current = null;
      return;
    }

    // Normal select
    clearProcessSelection();
    setActiveProcessId(processId);
    lastClickedId.current = processId;
    if (window.innerWidth < 640) setSidebarOpen(false);

    // Directly activate the tab in LayoutContext
    const tabId = `chat-${processId}`;
    const leaves = collectLeaves(layoutState.editorArea);
    for (const leaf of leaves) {
      if (leaf.tabs.some((t) => t.id === tabId)) {
        if (leaf.activeTabId !== tabId) {
          layoutDispatch({ type: 'SET_ACTIVE_TAB', groupId: leaf.id, tabId });
        }
        break;
      }
    }

    // Use getState() to read latest entries (avoid stale closure)
    const { entries, setEntries } = useAgentStore.getState();
    const existing = entries[processId];
    // Skip fetch only if we already have content entries (user/assistant messages)
    if (existing && existing.some((en) => en.type === 'user_message' || en.type === 'assistant_message')) return;

    setLoadingId(processId);
    try {
      // Determine the correct API: cli-history vs live agent
      const isCliHistory = processId.startsWith('cli-history-');
      const execId = isCliHistory ? processId.replace('cli-history-', '') : processId;
      const url = isCliHistory
        ? `/api/cli-history/${encodeURIComponent(execId)}/entries`
        : `/api/agents/${encodeURIComponent(processId)}/entries`;

      const res = await fetch(url);
      if (res.ok) {
        const raw = (await res.json()) as NormalizedEntry[];
        // Post-process: merge consecutive assistant_message fragments, fix processId
        const merged: NormalizedEntry[] = [];
        for (const entry of raw) {
          const fixed = { ...entry, processId } as NormalizedEntry;
          if (fixed.type === 'assistant_message') {
            (fixed as { partial: boolean }).partial = false;
            const prev = merged[merged.length - 1];
            if (prev && prev.type === 'assistant_message') {
              (prev as { content: string }).content += (fixed as { content: string }).content;
              continue;
            }
          }
          // Merge tool_use running→completed pairs
          if (fixed.type === 'tool_use' && (fixed.status === 'completed' || fixed.status === 'failed')) {
            const runIdx = merged.findLastIndex(
              (en) => en.type === 'tool_use' && (en as typeof fixed).status === 'running',
            );
            if (runIdx !== -1) {
              const running = merged[runIdx] as typeof fixed;
              merged[runIdx] = {
                ...running,
                status: fixed.status,
                result: fixed.result ?? running.result,
                input: (running.input && Object.keys(running.input).length > 0) ? running.input : fixed.input,
              } as NormalizedEntry;
              continue;
            }
          }
          merged.push(fixed);
        }
        // Deduplicate token_usage: keep only the last one (cumulative totals)
        const tokenUsageIndices: number[] = [];
        for (let i = 0; i < merged.length; i++) {
          if (merged[i].type === 'token_usage') tokenUsageIndices.push(i);
        }
        if (tokenUsageIndices.length > 1) {
          // Remove all but the last token_usage
          for (let i = tokenUsageIndices.length - 2; i >= 0; i--) {
            merged.splice(tokenUsageIndices[i], 1);
          }
        }

        // Synthesize user_message from process config if none exists
        const hasUserMessage = merged.some((en) => en.type === 'user_message');
        if (!hasUserMessage) {
          const proc = useAgentStore.getState().processes[processId];
          const prompt = proc?.config?.prompt;
          if (prompt) {
            const userEntry: NormalizedEntry = {
              id: `synth-user-${processId}`,
              processId,
              timestamp: proc.startedAt,
              type: 'user_message',
              content: prompt,
            } as NormalizedEntry;
            merged.unshift(userEntry);
          }
        }
        setEntries(processId, merged);
      }
    } catch { /* silent */ }
    setLoadingId(null);
  }, [setActiveProcessId, setSidebarOpen, layoutState.editorArea, layoutDispatch]);

  // Keyboard shortcut: Escape clears selection, Delete dismisses selected
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const { selectedProcessIds: sel, clearProcessSelection, batchDismissProcesses } = useAgentStore.getState();
      if (e.key === 'Escape' && sel.size > 0) {
        clearProcessSelection();
      }
      if (e.key === 'Delete' && sel.size > 0) {
        batchDismissProcesses(sel);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const processTitlesForFilter = useAgentStore((s) => s.processTitles);

  const { active, completed } = useMemo(() => {
    const q = searchQuery?.trim().toLowerCase();
    const all = Object.values(processes);
    const activeList: AgentProcess[] = [];
    const completedList: AgentProcess[] = [];
    for (const p of all) {
      // Filter by search query if present
      if (q) {
        const title = processTitlesForFilter[p.id] ?? p.config?.prompt?.slice(0, 80) ?? '';
        const label = AGENT_LABELS[p.type] ?? p.type;
        const haystack = `${title} ${label} ${p.type}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      if (p.status === 'running' || p.status === 'spawning') {
        activeList.push(p);
      } else {
        completedList.push(p);
      }
    }
    // Sort by startedAt descending
    activeList.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    completedList.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return { active: activeList, completed: completedList };
  }, [processes, searchQuery, processTitlesForFilter]);

  const hasSelection = selectedProcessIds.size > 0;

  if (active.length === 0 && completed.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-text-placeholder)', opacity: 0.6 }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <div>
          <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            No sessions yet
          </div>
          <div className="text-[10px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
            Start an agent session from the Kanban board, or use the CLI to delegate tasks.
          </div>
        </div>
        <div className="flex flex-col gap-1.5 w-full mt-1">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[10px]" style={{ backgroundColor: 'var(--color-bg-hover)' }}>
            <span style={{ color: 'var(--color-text-placeholder)' }}>Tip</span>
            <span style={{ color: 'var(--color-text-tertiary)' }}>Ctrl+Click to multi-select sessions</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {active.length > 0 && (
        <>
          <div
            className="text-[9px] font-semibold uppercase tracking-[0.04em] px-[6px] pt-[6px] pb-[2px]"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            Active ({active.length})
          </div>
          {active.map((p) => (
            <ConversationItem
              key={p.id}
              process={p}
              isActive={p.id === activeProcessId}
              isSelected={selectedProcessIds.has(p.id)}
              hasSelection={hasSelection}
              loading={loadingId === p.id}
              onSelect={handleSelect}
            />
          ))}
        </>
      )}
      {completed.length > 0 && (
        <>
          <div
            className="text-[9px] font-semibold uppercase tracking-[0.04em] px-[6px] pt-[8px] pb-[2px]"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            Completed ({completed.length})
          </div>
          {completed.map((p) => (
            <ConversationItem
              key={p.id}
              process={p}
              isActive={p.id === activeProcessId}
              isSelected={selectedProcessIds.has(p.id)}
              hasSelection={hasSelection}
              loading={loadingId === p.id}
              onSelect={handleSelect}
            />
          ))}
        </>
      )}
      {/* Batch action bar */}
      {hasSelection && <BatchActionBar count={selectedProcessIds.size} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// BatchActionBar — floating bar at bottom of sidebar when items selected
// ---------------------------------------------------------------------------

function BatchActionBar({ count }: { count: number }) {
  const clearSelection = useAgentStore((s) => s.clearProcessSelection);
  const selectedIds = useAgentStore((s) => s.selectedProcessIds);

  const handleDelete = useCallback(() => {
    useAgentStore.getState().batchDismissProcesses(selectedIds);
  }, [selectedIds]);

  return (
    <div
      className="flex items-center gap-2 mx-1 mt-2 px-3 py-2 rounded-lg"
      style={{
        backgroundColor: 'var(--color-tint-exploring)',
        border: '1px solid var(--color-accent-blue)',
      }}
    >
      <span className="text-[11px] font-medium flex-1" style={{ color: 'var(--color-text-primary)' }}>
        {count} selected
      </span>
      <button
        type="button"
        onClick={handleDelete}
        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border-none cursor-pointer"
        style={{ backgroundColor: 'var(--color-tint-blocked)', color: 'var(--color-accent-red)' }}
      >
        <Trash2 size={11} />
        Delete
      </button>
      <button
        type="button"
        onClick={clearSelection}
        className="px-2 py-1 rounded text-[10px] border-none cursor-pointer"
        style={{ backgroundColor: 'var(--color-bg-hover)', color: 'var(--color-text-secondary)' }}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConversationItem — with context menu, multi-select, inline rename
// ---------------------------------------------------------------------------

function ConversationItem({
  process,
  isActive,
  isSelected,
  hasSelection,
  loading,
  onSelect,
}: {
  process: AgentProcess;
  isActive: boolean;
  isSelected: boolean;
  hasSelection: boolean;
  loading?: boolean;
  onSelect: (id: string, e?: React.MouseEvent) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const processTitles = useAgentStore((s) => s.processTitles);
  const entries = useAgentStore((s) => s.entries[process.id]);

  // Compute summary stats from entries
  const stats = useMemo(() => {
    if (!entries) return null;
    let fileCount = 0;
    let tokens = 0;
    const seenPaths = new Set<string>();
    for (const e of entries) {
      if (e.type === 'tool_use' && FILE_TOOLS[e.name]) {
        const p = (e.input?.file_path ?? e.input?.path) as string | undefined;
        if (p && !seenPaths.has(p)) { seenPaths.add(p); fileCount++; }
      } else if (e.type === 'file_change' && !seenPaths.has(e.path)) {
        seenPaths.add(e.path); fileCount++;
      } else if (e.type === 'token_usage') {
        tokens = e.inputTokens + e.outputTokens;
      }
    }
    return { fileCount, tokens };
  }, [entries]);

  const isRunning = process.status === 'running' || process.status === 'spawning';
  const dotColor = isRunning
    ? 'var(--color-accent-green)'
    : process.status === 'error'
      ? 'var(--color-accent-red, #D05454)'
      : 'var(--color-text-placeholder)';
  const agentLabel = AGENT_LABELS[process.type] ?? process.type;
  const title = processTitles[process.id] ?? process.config?.prompt?.slice(0, 40) ?? agentLabel;

  const startRename = useCallback(() => {
    setRenameValue(title);
    setRenaming(true);
    // Focus input after render
    requestAnimationFrame(() => renameRef.current?.focus());
  }, [title]);

  const confirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== title) {
      useAgentStore.getState().renameProcess(process.id, trimmed);
    }
    setRenaming(false);
  }, [renameValue, title, process.id]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRename();
    } else if (e.key === 'Escape') {
      setRenaming(false);
    }
  }, [confirmRename]);

  const handleCopyTitle = useCallback(() => {
    copyToClipboard(title);
  }, [title]);

  const handleDelete = useCallback(() => {
    useAgentStore.getState().dismissProcess(process.id);
  }, [process.id]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="relative flex items-center gap-[7px] w-full rounded-[5px] cursor-pointer transition-all duration-100"
          style={{
            padding: '5px 7px',
            backgroundColor: isSelected
              ? 'var(--color-tint-exploring)'
              : isActive
                ? 'var(--color-bg-active)'
                : 'transparent',
            borderLeft: isSelected ? '2px solid var(--color-accent-blue)' : '2px solid transparent',
          }}
          onClick={(e) => onSelect(process.id, e)}
          onMouseEnter={(e) => {
            if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          }}
        >
          {/* Checkbox when in multi-select mode */}
          {hasSelection && (
            <span
              className="shrink-0 w-[13px] h-[13px] rounded-[3px] border flex items-center justify-center"
              style={{
                borderColor: isSelected ? 'var(--color-accent-blue)' : 'var(--color-border)',
                backgroundColor: isSelected ? 'var(--color-accent-blue)' : 'transparent',
              }}
            >
              {isSelected && (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          )}
          <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
          <div className="flex-1 min-w-0">
            {renaming ? (
              <input
                ref={renameRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={confirmRename}
                onKeyDown={handleRenameKeyDown}
                className="w-full text-[11px] font-medium bg-transparent border-b outline-none py-0"
                style={{
                  color: 'var(--color-text-primary)',
                  borderColor: 'var(--color-accent-blue)',
                  fontFamily: 'inherit',
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="text-[11px] font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                {loading ? 'Loading...' : title}
              </div>
            )}
            <div className="flex items-center gap-[4px] text-[9px]" style={{ color: 'var(--color-text-tertiary)' }}>
              <span>{formatTimeAgo(process.startedAt)} &middot; {agentLabel.toLowerCase()}</span>
              {stats && stats.fileCount > 0 && (
                <span className="flex items-center gap-[2px] ml-auto shrink-0" style={{ color: 'var(--color-text-placeholder)' }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /></svg>
                  {stats.fileCount}
                </span>
              )}
              {stats && stats.tokens > 0 && (
                <span className="shrink-0" style={{ color: 'var(--color-text-placeholder)' }}>
                  {stats.tokens > 1000 ? `${(stats.tokens / 1000).toFixed(0)}k` : stats.tokens}t
                </span>
              )}
            </div>
          </div>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content
          className="min-w-[150px] z-[100] rounded-md py-1"
          style={{
            backgroundColor: 'var(--color-bg-elevated, var(--color-bg-primary))',
            border: '1px solid var(--color-border)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ContextMenuItem icon={<Pencil size={13} />} label="Rename" shortcut="F2" onSelect={startRename} />
          <ContextMenuItem icon={<Copy size={13} />} label="Copy Title" onSelect={handleCopyTitle} />
          <ContextMenu.Separator className="h-px my-1" style={{ backgroundColor: 'var(--color-border-divider)' }} />
          <ContextMenuItem icon={<Trash2 size={13} />} label="Delete" shortcut="Del" destructive onSelect={handleDelete} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ContextMenuItem({
  icon,
  label,
  shortcut,
  destructive,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] rounded-sm cursor-pointer outline-none transition-colors"
      style={{
        color: destructive ? 'var(--color-accent-red)' : 'var(--color-text-secondary)',
      }}
      onSelect={onSelect}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = destructive ? 'var(--color-tint-blocked)' : 'var(--color-bg-hover)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
      }}
    >
      <span className="shrink-0" style={{ opacity: 0.7 }}>{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[10px] font-mono" style={{ color: 'var(--color-text-tertiary)' }}>
          {shortcut}
        </span>
      )}
    </ContextMenu.Item>
  );
}

// ---------------------------------------------------------------------------
// ChatSidebar — main component
// ---------------------------------------------------------------------------

/** Get first leaf from editor tree */
function getFirstLeaf(node: import('@/client/types/layout-types.js').EditorGroupNode): import('@/client/types/layout-types.js').EditorGroupLeaf {
  return node.type === 'leaf' ? node : getFirstLeaf(node.first);
}

export function ChatSidebar() {
  const { sidebarOpen, setSidebarOpen, activeTab, setActiveTab } = useChatSidebar();
  const [searchQuery, setSearchQuery] = useState('');
  const workspace = useWorkspaceTree();
  const { state: layoutState, dispatch: layoutDispatch } = useLayoutContext();

  // Open file as a tab in the editor
  const handleSelectFile = useCallback((filePath: string) => {
    const leaf = getFirstLeaf(layoutState.editorArea);
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    layoutDispatch({
      type: 'OPEN_TAB',
      groupId: leaf.id,
      tab: {
        id: `file-${filePath}`,
        type: 'file',
        title: fileName,
        ref: filePath,
      },
    });
    if (window.innerWidth < 640) setSidebarOpen(false);
  }, [layoutState.editorArea, layoutDispatch, setSidebarOpen]);

  return (
    <div
      role="navigation"
      aria-label="Chat navigation"
      aria-hidden={!sidebarOpen}
      inert={!sidebarOpen}
      className={[
        'absolute inset-y-0 left-0 z-40 flex w-[230px] shrink-0 flex-col overflow-hidden',
        'shadow-lg transition-[transform,width] duration-200 sm:relative sm:inset-auto sm:z-auto sm:shadow-none',
        sidebarOpen
          ? 'translate-x-0 sm:w-[230px]'
          : '-translate-x-full pointer-events-none sm:w-0 sm:translate-x-0',
      ].join(' ')}
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderRight: sidebarOpen ? '1px solid var(--color-border)' : 'none',
      }}
    >
      {/* Tab header */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 32,
          padding: '0 4px',
          borderBottom: '1px solid var(--color-border-divider)',
        }}
      >
        {(['chat', 'files', 'git', 'search'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            title={TAB_ICONS[tab].title}
            className="flex items-center justify-center border-none bg-transparent cursor-pointer transition-all duration-100"
            style={{
              width: 30,
              height: 32,
              color: activeTab === tab ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              borderBottom: activeTab === tab ? '2px solid var(--color-text-primary)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab) (e.currentTarget as HTMLElement).style.color = 'var(--color-text-primary)';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab) (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)';
            }}
          >
            <TabIcon tab={tab} />
          </button>
        ))}
        <button
          type="button"
          aria-label="Close sidebar"
          title="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="ml-auto flex h-8 w-8 items-center justify-center border-none bg-transparent cursor-pointer sm:hidden"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* Search bar */}
      <div className="px-[8px] py-[4px]">
        <div className="relative">
          <svg
            className="absolute left-[7px] top-1/2 -translate-y-1/2 pointer-events-none"
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-placeholder)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full py-[4px] pl-[26px] pr-[7px] text-[11px] rounded-[5px] border outline-none transition-[border-color] duration-100"
            style={{
              borderColor: 'var(--color-border)',
              backgroundColor: 'var(--color-bg-card)',
              color: 'var(--color-text-primary)',
              fontFamily: 'inherit',
            }}
            onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent-blue)'; }}
            onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)'; }}
          />
        </div>
      </div>

      {/* View body */}
      <div className="flex-1 overflow-y-auto px-[6px] pb-[8px]">
        {activeTab === 'chat' && (
          <>
            <ConversationList searchQuery={searchQuery} />
            <SessionFilesPanel onSelectFile={handleSelectFile} />
          </>
        )}
        {activeTab === 'files' && (
          <TreeBrowser
            tree={workspace.tree}
            selectedPath={null}
            onSelectFile={handleSelectFile}
            loading={workspace.loading}
          />
        )}
        {activeTab === 'git' && (
          <GitView />
        )}
        {activeTab === 'search' && (
          <SearchView searchQuery={searchQuery} onSelectFile={handleSelectFile} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchView — file content search
// ---------------------------------------------------------------------------

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

function SearchView({ searchQuery, onSelectFile }: { searchQuery: string; onSelectFile: (path: string) => void }) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced fetch
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.length < 2) {
      setResults([]);
      setTotal(0);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/workspace/search?q=${encodeURIComponent(searchQuery)}&limit=30`);
        if (res.ok) {
          const data = await res.json() as { results: SearchResult[]; total: number };
          setResults(data.results);
          setTotal(data.total);
          setCollapsedFiles(new Set());
        }
      } catch { /* silent */ }
      setLoading(false);
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  // Group results by file
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const list = map.get(r.file);
      if (list) list.push(r);
      else map.set(r.file, [r]);
    }
    return map;
  }, [results]);

  const toggleFile = useCallback((file: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  if (searchQuery.length < 2) {
    return (
      <div className="px-[10px] py-[20px] text-center text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Type to search across files
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-[10px] py-[20px] text-center text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Searching...
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="px-[10px] py-[20px] text-center text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        No results
      </div>
    );
  }

  return (
    <div>
      <div className="text-[9px] px-[6px] py-[2px]" style={{ color: 'var(--color-text-tertiary)' }}>
        {total} result{total !== 1 ? 's' : ''} in {grouped.size} file{grouped.size !== 1 ? 's' : ''}
      </div>
      {[...grouped.entries()].map(([file, matches]) => (
        <div key={file}>
          {/* File header */}
          <button
            type="button"
            onClick={() => toggleFile(file)}
            className="flex items-center gap-[4px] w-full border-none bg-transparent cursor-pointer text-left"
            style={{ padding: '4px 6px', fontFamily: 'inherit' }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--color-text-tertiary)" style={{ transform: collapsedFiles.has(file) ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 100ms' }}>
              <path d="M2 1l4 3-4 3z" />
            </svg>
            <FileIcon />
            <span className="flex-1 min-w-0 text-[11px] font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
              {file}
            </span>
            <span className="text-[9px] shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
              {matches.length}
            </span>
          </button>
          {/* Match rows */}
          {!collapsedFiles.has(file) && matches.map((m) => (
            <button
              key={`${file}:${m.line}`}
              type="button"
              onClick={() => onSelectFile(file)}
              className="flex items-center gap-[6px] w-full border-none bg-transparent cursor-pointer text-left transition-colors duration-75"
              style={{ padding: '3px 7px 3px 22px', color: 'var(--color-text-primary)', fontFamily: 'inherit' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg-hover)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
            >
              <span className="text-[10px] shrink-0 font-mono" style={{ color: 'var(--color-text-tertiary)', minWidth: 28, textAlign: 'right' }}>
                {m.line}
              </span>
              <span className="text-[11px] truncate min-w-0">{m.text.trim()}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitView — full git source control sidebar
// ---------------------------------------------------------------------------

const STATUS_BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  M: { bg: 'rgba(201,155,45,0.15)', color: 'var(--color-accent-yellow)' },
  A: { bg: 'rgba(61,155,111,0.15)', color: 'var(--color-accent-green)' },
  D: { bg: 'rgba(208,84,84,0.15)', color: 'var(--color-accent-red)' },
  R: { bg: 'rgba(130,130,200,0.15)', color: 'var(--color-accent-blue)' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.M;
  return (
    <span
      className="text-[9px] font-semibold px-[5px] rounded-[3px] shrink-0"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {status}
    </span>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ opacity: 0.6 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function GitFileRow({ path, status, onClick }: { path: string; status: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-[6px] px-[7px] py-[3px] rounded-[4px] cursor-pointer w-full border-none bg-transparent text-left transition-colors duration-75"
      style={{ color: 'var(--color-text-primary)', fontFamily: 'inherit' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
    >
      <FileIcon />
      <span className="flex-1 min-w-0 text-[11px] truncate">{path}</span>
      <StatusBadge status={status} />
    </button>
  );
}

function GitView() {
  const git = useGitStatus();
  const { state: layoutState, dispatch: layoutDispatch } = useLayoutContext();
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);

  const openFile = useCallback((filePath: string) => {
    const leaf = getFirstLeaf(layoutState.editorArea);
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    layoutDispatch({
      type: 'OPEN_TAB',
      groupId: leaf.id,
      tab: {
        id: `file-${filePath}`,
        type: 'file',
        title: fileName,
        ref: filePath,
      },
    });
  }, [layoutState.editorArea, layoutDispatch]);

  if (git.loading && !git.branch) {
    return (
      <div className="px-[10px] py-[20px] text-center text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        Loading git status...
      </div>
    );
  }

  if (git.error && !git.branch) {
    return (
      <div className="px-[10px] py-[20px] text-center text-[11px]" style={{ color: 'var(--color-accent-red)' }}>
        {git.error}
      </div>
    );
  }

  const stagedCount = git.staged.length;
  const changesCount = git.unstaged.length + git.untracked.length;

  return (
    <div>
      {/* Branch bar */}
      <div className="flex items-center gap-[5px] px-[7px] py-[4px] text-[11px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="flex-1 min-w-0 truncate">{git.branch || 'unknown'}</span>
        <button
          type="button"
          onClick={git.refresh}
          title="Refresh"
          className="flex items-center justify-center border-none bg-transparent cursor-pointer rounded-[3px] transition-colors duration-75"
          style={{ width: 18, height: 18, color: 'var(--color-text-tertiary)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-primary)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Staged Changes */}
      {stagedCount > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setStagedOpen((v) => !v)}
            className="flex items-center gap-[4px] w-full border-none bg-transparent cursor-pointer text-left"
            style={{ padding: '4px 6px', fontFamily: 'inherit' }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--color-text-tertiary)" style={{ transform: stagedOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 100ms' }}>
              <path d="M2 1l4 3-4 3z" />
            </svg>
            <span className="text-[9px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--color-text-tertiary)' }}>
              Staged Changes ({stagedCount})
            </span>
          </button>
          {stagedOpen && git.staged.map((f) => (
            <GitFileRow key={`staged-${f.path}`} path={f.path} status={f.status} onClick={() => openFile(f.path)} />
          ))}
        </div>
      )}

      {/* Changes (unstaged + untracked) */}
      {changesCount > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setChangesOpen((v) => !v)}
            className="flex items-center gap-[4px] w-full border-none bg-transparent cursor-pointer text-left"
            style={{ padding: '4px 6px', fontFamily: 'inherit' }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--color-text-tertiary)" style={{ transform: changesOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 100ms' }}>
              <path d="M2 1l4 3-4 3z" />
            </svg>
            <span className="text-[9px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--color-text-tertiary)' }}>
              Changes ({changesCount})
            </span>
          </button>
          {changesOpen && (
            <>
              {git.unstaged.map((f) => (
                <GitFileRow key={`unstaged-${f.path}`} path={f.path} status={f.status} onClick={() => openFile(f.path)} />
              ))}
              {git.untracked.map((f) => (
                <GitFileRow key={`untracked-${f}`} path={f} status="A" onClick={() => openFile(f)} />
              ))}
            </>
          )}
        </div>
      )}

      {/* No changes message */}
      {stagedCount === 0 && changesCount === 0 && (
        <div className="px-[7px] py-[10px] text-center text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
          No changes detected
        </div>
      )}

      {/* Recent Commits */}
      {git.commits.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setCommitsOpen((v) => !v)}
            className="flex items-center gap-[4px] w-full border-none bg-transparent cursor-pointer text-left"
            style={{ padding: '4px 6px', marginTop: 4, fontFamily: 'inherit' }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--color-text-tertiary)" style={{ transform: commitsOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 100ms' }}>
              <path d="M2 1l4 3-4 3z" />
            </svg>
            <span className="text-[9px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--color-text-tertiary)' }}>
              Recent Commits
            </span>
          </button>
          {commitsOpen && git.commits.map((commit) => (
            <div
              key={commit.hash}
              className="flex items-center gap-[6px] px-[7px] py-[3px] text-[10px]"
              style={{ color: 'var(--color-text-primary)', opacity: 0.7 }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
                <circle cx="6" cy="6" r="3" fill="var(--color-text-tertiary)" />
              </svg>
              <span className="truncate min-w-0">
                <span className="font-mono" style={{ color: 'var(--color-accent-blue)', marginRight: 4 }}>{commit.shortHash}</span>
                {commit.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
