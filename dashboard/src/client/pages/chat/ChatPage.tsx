import { useState, useCallback, useEffect } from 'react';
import { useAgentStore } from '@/client/store/agent-store.js';
import { useApprovalKeyboard } from '@/client/hooks/useApprovalKeyboard.js';
import { ChatWorkspace } from '@/client/components/chat/ChatWorkspace.js';
import { ChatSidebarContext, type SidebarTab } from '@/client/components/chat/ChatSidebarContext.js';
import { PanelLeft } from 'lucide-react';
import { ChatSidebar } from './ChatSidebar.js';

// ---------------------------------------------------------------------------
// ChatPage — VS Code-style layout with multi-view sidebar + workspace
// ---------------------------------------------------------------------------

export function ChatPage() {
  const activeProcessId = useAgentStore((s) => s.activeProcessId);
  const [sidebarOpen, setSidebarOpen] = useState(() => (
    typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
    || window.matchMedia('(min-width: 640px)').matches
  ));
  const [activeTab, setActiveTab] = useState<SidebarTab>('chat');

  useApprovalKeyboard(activeProcessId);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 640px)');
    const handleBreakpointChange = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    media.addEventListener('change', handleBreakpointChange);
    return () => media.removeEventListener('change', handleBreakpointChange);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && window.innerWidth < 640) setSidebarOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [sidebarOpen]);

  // Backward-compat helpers for EditorGroupLeaf toggle buttons
  const fileTreeOpen = sidebarOpen && activeTab === 'files';
  const setFileTreeOpen = useCallback((open: boolean) => {
    if (open) { setSidebarOpen(true); setActiveTab('files'); }
    else if (activeTab === 'files') setSidebarOpen(false);
  }, [activeTab]);

  const historyOpen = sidebarOpen && activeTab === 'chat';
  const setHistoryOpen = useCallback((open: boolean) => {
    if (open) { setSidebarOpen(true); setActiveTab('chat'); }
    else if (activeTab === 'chat') setSidebarOpen(false);
  }, [activeTab]);

  return (
    <ChatSidebarContext value={{ sidebarOpen, setSidebarOpen, activeTab, setActiveTab, fileTreeOpen, setFileTreeOpen, historyOpen, setHistoryOpen }}>
      <div className="h-full flex min-w-0 overflow-hidden relative">
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close sidebar"
            className="absolute inset-0 z-30 border-none bg-black/35 sm:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Multi-view sidebar (conversations, files, git, search) */}
        <ChatSidebar />

        {/* Main workspace area — EditorGroupContainer with tabs + splits */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div
            className="flex h-8 shrink-0 items-center border-b px-1 sm:hidden"
            style={{
              backgroundColor: 'var(--color-bg-secondary)',
              borderColor: 'var(--color-border-divider)',
            }}
          >
            <button
              type="button"
              aria-label="Open sidebar"
              title="Open sidebar"
              onClick={() => setSidebarOpen(true)}
              className="flex h-7 w-7 items-center justify-center border-none bg-transparent cursor-pointer"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <PanelLeft size={16} strokeWidth={1.8} />
            </button>
          </div>
          <ChatWorkspace />
        </div>
      </div>
    </ChatSidebarContext>
  );
}
