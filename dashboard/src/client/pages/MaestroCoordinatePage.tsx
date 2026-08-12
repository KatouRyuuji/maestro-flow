import { useEffect, useCallback, useMemo, useState } from 'react';
import { useMaestroCoordinateStore } from '@/client/store/maestro-coordinate-store.js';
import { useI18n } from '@/client/i18n/index.js';
import type { MaestroSessionListItem } from '@/shared/maestro-session-types.js';
import { SessionListPanel } from '@/client/components/maestro-coordinate/SessionListPanel.js';
import { SessionDetailContent } from '@/client/components/maestro-coordinate/SessionDetailContent.js';
import { RefreshCw, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// MaestroCoordinatePage — main page layout
// ---------------------------------------------------------------------------

const SIDEBAR_TIP_DISMISS_KEY = 'maestro-sidebar-tip-dismissed';

export function MaestroCoordinatePage() {
  const { t } = useI18n();

  const sessions = useMaestroCoordinateStore((s) => s.sessions);
  const selectedDir = useMaestroCoordinateStore((s) => s.selectedDir);
  const sessionDetail = useMaestroCoordinateStore((s) => s.sessionDetail);
  const isLoading = useMaestroCoordinateStore((s) => s.isLoading);
  const error = useMaestroCoordinateStore((s) => s.error);
  const fetchSessions = useMaestroCoordinateStore((s) => s.fetchSessions);
  const selectSession = useMaestroCoordinateStore((s) => s.selectSession);
  const clearError = useMaestroCoordinateStore((s) => s.clearError);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const selectedSession = useMemo(
    () =>
      selectedDir
        ? sessions.find((s) => s.dirName === selectedDir) ?? null
        : null,
    [sessions, selectedDir],
  );

  const handleRefresh = useCallback(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Sidebar 桌面应用提醒条（可关闭，localStorage 记忆）
  const [sidebarTipDismissed, setSidebarTipDismissed] = useState(
    () => localStorage.getItem(SIDEBAR_TIP_DISMISS_KEY) === '1',
  );
  const handleDismissSidebarTip = useCallback(() => {
    localStorage.setItem(SIDEBAR_TIP_DISMISS_KEY, '1');
    setSidebarTipDismissed(true);
  }, []);

  const handleSelectSession = useCallback(
    (dirName: string) => {
      selectSession(dirName === selectedDir ? null : dirName);
    },
    [selectSession, selectedDir],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">
      {/* ---- Header bar ---- */}
      <header className="flex items-center justify-between px-4 h-[44px] shrink-0 bg-bg-secondary border-b border-border">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-bold text-text-primary">
            {t('maestro_coordinate.title')}
          </span>
          {isLoading && (
            <span className="text-[10px] text-text-tertiary">Loading...</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="flex items-center justify-center w-7 h-7 p-0 border border-border rounded-[var(--radius-md)] bg-transparent text-text-secondary cursor-pointer transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {/* ---- Sidebar 桌面应用提醒条 ---- */}
      {!sidebarTipDismissed && (
        <div className="flex items-center gap-2 px-4 py-2 text-[11px] text-accent-blue bg-[rgba(59,130,246,0.08)] border-b border-border-divider shrink-0">
          <span className="flex-1">{t('maestro_coordinate.sidebar_tip')}</span>
          <button
            type="button"
            onClick={handleDismissSidebarTip}
            title={t('maestro_coordinate.sidebar_tip_dismiss')}
            aria-label={t('maestro_coordinate.sidebar_tip_dismiss')}
            className="flex items-center gap-1 px-1.5 py-0.5 border-none rounded bg-transparent text-accent-blue cursor-pointer text-[11px] font-semibold hover:bg-bg-hover transition-colors duration-150"
          >
            <X size={12} />
            {t('maestro_coordinate.sidebar_tip_dismiss')}
          </button>
        </div>
      )}

      {/* ---- Error banner ---- */}
      {error && (
        <div className="flex items-center px-4 py-2 text-[11px] text-accent-red bg-[rgba(196,101,85,0.08)] border-b border-border-divider shrink-0">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="px-1.5 border-none rounded bg-transparent text-accent-red cursor-pointer text-[11px] font-semibold"
          >
            x
          </button>
        </div>
      )}

      {/* ---- Master-detail body ---- */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Session list */}
        <SessionListPanel
          sessions={sessions}
          selectedDir={selectedDir}
          onSelect={handleSelectSession}
        />

        {/* Right: Session detail */}
        <main className="flex-1 min-w-0 overflow-y-auto bg-bg-primary">
          {selectedSession && sessionDetail ? (
            <SessionDetailContent
              session={selectedSession}
              detail={sessionDetail}
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>

      {/* ---- Status bar ---- */}
      <footer className="flex items-center justify-between h-7 px-4 bg-bg-secondary border-t border-border text-[10px] shrink-0">
        <span className="text-text-secondary">
          {sessions.length} sessions
        </span>
        <span className="text-text-tertiary">
          Last refresh: {new Date().toLocaleTimeString()}
        </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state placeholder
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-tertiary px-5 py-12">
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-15 mb-3"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
      <div className="text-[13px] font-semibold text-text-secondary">
        Select a session to view details
      </div>
    </div>
  );
}
