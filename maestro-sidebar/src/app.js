// ===========================================================================
// Maestro Sidebar — 前端逻辑
// 数据流：Rust 后端快照（get_snapshot / snapshot-changed 事件）→ 渲染三区块
// 详情：点击 Agent 调用 / 会话 → 详情视图（调用对话 / Session·Run 时间线）
// ===========================================================================

'use strict';

const i18n = window.MaestroI18n;
const t = (key, variables) => i18n.t(key, variables);

// ---------------------------------------------------------------------------
// 启动错误捕获（必须最先注册，任何初始化失败都可见）
// ---------------------------------------------------------------------------

function showBootError(msg) {
  const el0 = document.getElementById('bootError');
  if (el0) {
    el0.hidden = false;
    el0.textContent = (el0.textContent ? el0.textContent + '\n' : '') + msg;
  }
}
window.addEventListener('error', (e) => {
  showBootError(`${e.message} @ ${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  showBootError(`Promise: ${e.reason && e.reason.message ? e.reason.message : String(e.reason)}`);
});

// Tauri global API（防御式获取；失败时显示明确错误）
const TAURI = window.__TAURI__;
const { invoke } = TAURI?.core ?? {};
const { listen } = TAURI?.event ?? {};
const { open: dialogOpen } = TAURI?.dialog ?? {};
const appWindow = TAURI?.window?.getCurrentWindow?.() ?? null;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let snapshot = null;          // 最近一次快照
let config = null;            // 配置（roots / always_on_top）
let workspaces = [];          // 可用工作空间 [{path, name, active, source}]
let view = null;              // null=列表 | {kind:'call'|'session', id}
let detail = null;            // 详情数据（CallDetail / SessionDetail）
let detailStatus = 'idle';    // idle | loading | ready | not-found | error
let detailRequestId = 0;
let detailReturnFocus = null;
const viewStack = [];       // 详情导航栈（主列表 → 知识列表 → 条目详情）
const detailCache = {};     // key: `${kind}::${id}` → { detail }
let menuTrigger = null;
let expandedSessions = new Set(); // 列表里展开 run 明细的会话
const runDisclosureState = new Map();
const sessionRunCache = {};   // 会话 run 缓存
const sessionLoadState = {};  // collapsed | loading | expanded | error
const sessionRunGeneration = {};
const CALLS_LIMIT = 8;
const SESSIONS_LIMIT = 8;
let callsExpanded = false;
let sessionsListExpanded = false;
// 调用筛选：状态 / 工具（chips）
let callsFilter = { status: '', tool: '' };
let liveCallRefreshTimer = null;
let capsulePane = 'session';
const callDetailUiState = new Map();
const CHAT_FOLLOW_THRESHOLD = 48;
const LONG_MESSAGE_CHARS = 1200;
const LONG_MESSAGE_LINES = 14;
let dockedEdge = null;
let dockTracking = false;
let dockMoveTimer = null;
let dockHideTimer = null;

// 搜索：区块列表搜索（主视图）+ 详情页搜索
const listSearch = { calls: '', sessions: '', knowledge: '' };
let detailSearch = '';
// 语义搜索（知识详情页）：maestro search 桥接
let semanticMode = false;
let semanticReqId = 0;
let semanticResults = null; // null=loading | {results,error,...}
let semanticTimer = null;
// 系统通知：状态迁移检测（快照对比，只通知一次）
const notifySeen = { calls: new Map(), sessions: new Map() };
let notifyReady = false;
// 知识统计摘要：md 类计数（specs/memory/knowhow/issues 行数）变化 → 条目缓存失效
let lastKbStatsDigest = '';
// 高频知识缓存（30s TTL）
let topKbCache = { ts: 0, items: null };
const TOP_KB_TTL = 30 * 1000;
const TOP_KB_LIMIT = 5;
// 后端 snapshot 携带的高频知识摘要（learning 行 command/frequency/lastUsed 哈希）。
// 摘要变化 → 立即失效 30s TTL 缓存，避免面板滞后；未变化则不重扫（流式事件下零额外开销）。
let lastLearningDigest = null;
let kbItemsPromise = null; // 知识条目全量缓存（详情页 / 区块搜索共用）

const TOOL_COLORS = {
  'claude-code': '#e08a57',
  'claude': '#e08a57',
  'codex': 'var(--info)',
  'gemini': 'var(--ok)',
  'qwen': 'var(--warn)',
  'opencode': 'var(--accent)',
  'pi': 'var(--info)',
  'agy': 'var(--info)',
  'api-explore': 'var(--warn)',
};
const TOOL_LABEL = {
  'claude-code': 'Claude',
  'claude': 'Claude',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'qwen': 'Qwen',
  'opencode': 'OpenCode',
  'pi': 'Pi',
  'agy': 'Antigravity',
  'api-explore': 'API Explore',
};
const VERDICT_COLOR = {
  ready: 'var(--ok)', done: 'var(--ok)', completed: 'var(--ok)', sealed: 'var(--ok)',
  blocked: 'var(--danger)', failed: 'var(--danger)',
  needs_retry: 'var(--warn)', done_with_concerns: 'var(--warn)', ready_with_concerns: 'var(--warn)',
};
// verdict 中文语义（层次分明的状态语言）；原始英文保留在 title 中供技术读者查看
const VERDICT_LABEL_KEYS = {
  ready: 'common.ready', done: 'common.done', completed: 'common.done', sealed: 'common.sealed',
  running: 'common.running', pending: 'common.pending', cancelled: 'common.cancelled',
  blocked: 'knowledge.status.blocked', failed: 'common.failed', needs_retry: 'common.retry',
  done_with_concerns: 'runs.concernsTitle', ready_with_concerns: 'runs.concernsTitle',
};
function normalizeRunSignal(value) {
  return String(value || '').toLowerCase().replace('needs-retry', 'needs_retry');
}
function verdictLabel(v) {
  const s = normalizeRunSignal(v);
  return VERDICT_LABEL_KEYS[s] ? t(VERDICT_LABEL_KEYS[s]) : (s || t('common.unknown'));
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
// DOM id 安全化 + 短哈希：避免中文/特殊字符碰撞出重复 id
const safeDomId = (value) => {
  const raw = String(value || 'item');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return `${raw.replace(/[^A-Za-z0-9_-]+/g, '-')}-${h.toString(36)}`;
};

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  await i18n.init();
  applyLocaleUi();
  if (!TAURI) showBootError(t('boot.tauriMissing'));
  if (!invoke) showBootError(t('boot.coreMissing'));
  applyTheme();
  await bindEvents();
  try {
    config = await invoke('get_config');
  } catch { config = { configured: false, roots: [], always_on_top: false }; }
  applyTop(config.always_on_top);
  applyWallpaper(config);
  applyGlobalMode();

  if (!config.configured) {
    $('setup').hidden = false;
    return;
  }
  $('mainView').hidden = false;
  await refreshWorkspaces();

  // 冷启动优化：先渲染上次快照缓存（秒开），再拉取最新数据覆盖
  try {
    const cached = JSON.parse(localStorage.getItem('snapshot-cache') || 'null');
    if (cached && cached.snapshot && cached.snapshot.sessions) {
      const locatorReady = !Boolean(config.global_mode ?? config.globalMode)
        || cached.snapshot.sessions.every((session) => Boolean(session.project_path));
      if (locatorReady) {
        snapshot = cached.snapshot;
        render();
        $('liveStatus').textContent = t('status.cached', { time: fmtClock2(new Date(cached.ts).toISOString()) });
      } else {
        localStorage.removeItem('snapshot-cache');
      }
    }
  } catch { /* 缓存损坏忽略 */ }

  // 首帧骨架：无缓存时快照到达前不闪空态
  if (!snapshot) {
    $('liveStatus').textContent = t('status.loading');
    renderSkeleton();
  }
  try {
    snapshot = await invoke('get_snapshot');
    cacheSnapshot(snapshot);
    seedNotifyState(snapshot);
  } catch (err) {
    snapshot = {
      workspace: t('workspace.notConnected'),
      active_session_id: null,
      active_project_path: null,
      sessions: [], calls: [], knowledge: { total: 0 },
    };
    $('liveStatus').textContent = t('status.disconnected');
    $('liveDot').classList.add('stale');
    showBootError(t('boot.snapshotFailed', { error: String(err && err.message ? err.message : err) }));
    seedNotifyState(snapshot);
  }
  render();

  // 后端推送：快照变化即重渲染（指纹去重在 Rust 端）；菜单打开或焦点在行内时保留焦点
  let pollFallback = false;
  try {
    await listen('snapshot-changed', (event) => {
      snapshot = event.payload;
      cacheSnapshot(snapshot);
      notifyMigration(snapshot);
      refreshKbCacheOnStatsChange(snapshot);
      const digest = snapshot?.learning_top_digest || '';
      if (digest !== lastLearningDigest) {
        lastLearningDigest = digest;
        topKbCache = { ts: 0, items: null }; // 高频知识摘要变化 → 绕过 30s TTL
      }
      scheduleLiveCallDetailRefresh();
      if (!$('menuPop').hidden) return;
      $('liveDot').classList.remove('stale');
      $('liveStatus').textContent = t('status.live');
      renderWithFocus();
    });
    await listen('knowledge-updated', (event) => {
      void refreshKnowledgeCaches(event.payload || {});
    });
    $('liveStatus').textContent = t('status.live');
  } catch {
    pollFallback = true;
    $('liveStatus').textContent = t('status.polling');
    $('liveDot').classList.add('stale');
  }

  // 15s 兜底轮询
  setInterval(async () => {
    try {
      const s = await invoke('get_snapshot');
      // 连接恢复：清除 stale 状态点并复位文案（轮询降级模式保留「轮询模式」提示）
      if ($('liveDot').classList.contains('stale')) {
        $('liveDot').classList.remove('stale');
        $('liveStatus').textContent = pollFallback ? t('status.polling') : t('status.live');
      }
      if (JSON.stringify(s) !== JSON.stringify(snapshot)) {
        snapshot = s;
        cacheSnapshot(snapshot);
        notifyMigration(snapshot);
        refreshKbCacheOnStatsChange(snapshot);
        const digest = s?.learning_top_digest || '';
        if (digest !== lastLearningDigest) {
          lastLearningDigest = digest;
          topKbCache = { ts: 0, items: null };
        }
        scheduleLiveCallDetailRefresh();
        if (!$('menuPop').hidden) return;
        renderWithFocus();
      }
    } catch {
      $('liveStatus').textContent = t('status.disconnected');
      $('liveDot').classList.add('stale');
    }
  }, 15000);
}

/** 渲染并尽力保留键盘焦点（监听推送/轮询重绘时用） */
function renderWithFocus() {
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.focusKey || '';
  render();
  requestAnimationFrame(() => {
    if (focused && focused.isConnected) {
      focused.focus();
      return;
    }
    if (!focusKey) return;
    const replacement = Array.from(document.querySelectorAll('[data-focus-key]'))
      .find((node) => node.dataset.focusKey === focusKey);
    replacement?.focus();
  });
}

/** Refresh an open call without replacing the detail view with a skeleton. */
function scheduleLiveCallDetailRefresh() {
  if (view?.kind !== 'call') return;
  const call = (snapshot?.calls || []).find((item) => item.execId === view.id);
  if (!call) return;
  clearTimeout(liveCallRefreshTimer);
  liveCallRefreshTimer = setTimeout(async () => {
    const id = view?.kind === 'call' ? view.id : null;
    if (!id) return;
    try {
      const result = await invoke('get_call_detail', { execId: id });
      if (!result || view?.kind !== 'call' || view.id !== id) return;
      detail = result;
      detailStatus = 'ready';
      detailCache[`call::${id}`] = result;
      renderWithFocus();
    } catch {
      // Keep the last good frame; the next JSONL write or fallback poll retries.
    }
  }, 400);
}

/** 快照写入 localStorage 缓存（冷启动秒开用） */
function cacheSnapshot(snap) {
  try {
    localStorage.setItem('snapshot-cache', JSON.stringify({ ts: Date.now(), snapshot: snap }));
  } catch { /* 存储满/不可用忽略 */ }
}

/** 首帧骨架行（快照到达前） */
function renderSkeleton() {
  for (const id of ['callsList', 'sessionsList']) {
    const list = $(id);
    list.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'loading-line');
      if (i === 1) row.classList.add('short');
      list.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function setDockedEdge(edge) {
  dockedEdge = edge || null;
  if (dockedEdge) document.body.dataset.docked = dockedEdge;
  else delete document.body.dataset.docked;
}

function resetDockClient() {
  dockTracking = false;
  clearTimeout(dockMoveTimer);
  clearTimeout(dockHideTimer);
  setDockedEdge(null);
  document.body.classList.remove('dock-revealed');
}

function bindDockBehavior() {
  if (appWindow?.onMoved) {
    appWindow.onMoved(() => {
      if (!dockTracking) return;
      clearTimeout(dockMoveTimer);
      dockMoveTimer = setTimeout(async () => {
        dockTracking = false;
        try {
          setDockedEdge(await invoke('dock_window_if_near_edge'));
        } catch {
          setDockedEdge(null);
        }
      }, 280);
    }).catch(() => {});
  }

  const world = $('world');
  world.addEventListener('mouseenter', async () => {
    if (!dockedEdge) return;
    clearTimeout(dockHideTimer);
    try {
      await invoke('reveal_docked_window');
      document.body.classList.add('dock-revealed');
    } catch { /* 停靠状态已失效 */ }
  });
  world.addEventListener('mouseleave', () => {
    if (!dockedEdge || dockTracking) return;
    clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(async () => {
      try {
        await invoke('hide_docked_window');
        document.body.classList.remove('dock-revealed');
      } catch { /* 窗口已隐藏或退出 */ }
    }, 650);
  });
}

function bindWindowDrag(surface, blockedSelector) {
  surface.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.detail > 1) return;
    if (blockedSelector && event.target.closest(blockedSelector)) return;
    if (!appWindow?.startDragging) return;
    event.preventDefault();
    resetDockClient();
    dockTracking = true;
    invoke('undock_window').catch(() => {});
    appWindow.startDragging().catch(() => {
      dockTracking = false;
      $('liveStatus').textContent = t('status.dragUnavailable');
    });
  });
}

function setCapsulePane(pane) {
  capsulePane = pane === 'agent' ? 'agent' : 'session';
  const sessionActive = capsulePane === 'session';
  const capsule = $('capsule');
  capsule.dataset.pane = capsulePane;
  $('capSessionPanel').classList.toggle('active', sessionActive);
  $('capSessionPanel').setAttribute('aria-hidden', String(!sessionActive));
  $('capAgentPanel').classList.toggle('active', !sessionActive);
  $('capAgentPanel').setAttribute('aria-hidden', String(sessionActive));
}

function toggleCapsuleMenu(open) {
  const pop = $('capMenuPop');
  const show = open !== undefined ? open : pop.hidden;
  pop.hidden = !show;
  $('btnCapMenu').setAttribute('aria-expanded', String(show));
  if (show) requestAnimationFrame(() => pop.querySelector('button')?.focus());
}

async function enterCapsule() {
  resetDockClient();
  toggleMenu(false);
  toggleCapsuleMenu(false);
  await invoke('set_window_mode', { mode: 'capsule' });
  document.body.dataset.mode = 'capsule';
  $('card').hidden = true;
  $('capsule').hidden = false;
  $('capsule').classList.add('mode-enter');
  setTimeout(() => $('capsule').classList.remove('mode-enter'), 200);
}

async function restoreCard() {
  resetDockClient();
  toggleCapsuleMenu(false);
  await invoke('set_window_mode', { mode: 'card' });
  document.body.dataset.mode = 'card';
  $('capsule').hidden = true;
  $('card').hidden = false;
  $('card').classList.add('mode-enter');
  setTimeout(() => $('card').classList.remove('mode-enter'), 200);
  fitWindow();
}

function bindEvents() {
  bindDockBehavior();
  bindWindowDrag(document.querySelector('.topbar'), '.tb-btns, button, input, a, [role="button"]');
  bindWindowDrag($('capsule'), '.cap-window-actions, .cap-menu-pop');

  // 面板折叠（.sec 0fr 动画）
  for (const id of ['Calls', 'Sessions', 'Knowledge']) {
    const head = $(`head${id}`);
    const sec = $(head.dataset.sec);
    const applyExpanded = (expanded) => {
      head.setAttribute('aria-expanded', String(expanded));
      sec.classList.toggle('closed', !expanded);
    };
    head.addEventListener('click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      applyExpanded(!expanded);
      localStorage.setItem(`panel-${id}`, String(!expanded));
      fitWindow();
      scheduleFade();
    });
    if (localStorage.getItem(`panel-${id}`) === 'false') applyExpanded(false);
  }

  // 区块头部「详情」按钮 → 全部列表详情视图
  $('goCalls').addEventListener('click', () => openDetail('calls', 'all'));
  $('goSessions').addEventListener('click', () => openDetail('sessions', 'all'));
  $('goKnowledge').addEventListener('click', () => openDetail('knowledge', 'all'));
  // 顶部概览卡头部
  $('ovRunningHead').addEventListener('click', () => openDetail('sessions', 'all'));
  $('ovTopKbHead').addEventListener('click', () => openDetail('knowledge', 'all'));

  // 调用筛选 chips 容器（搜索框下方，内容由 renderCallFilterChips 刷新）
  const callsSearch = $('callsSearch');
  if (callsSearch) {
    const filterRow = el('div', 'filter-chips');
    filterRow.id = 'callsFilterRow';
    callsSearch.closest('.sec-search').after(filterRow);
  }

  // 区块搜索框（输入即过滤；Esc/清除按钮复位）
  for (const name of ['calls', 'sessions', 'knowledge']) {
    const input = $(`${name}Search`);
    const clear = $(`${name}SearchClear`);
    input.addEventListener('input', () => {
      listSearch[name] = input.value.trim();
      clear.hidden = !input.value;
      render();
      fitWindow();
      scheduleFade();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.stopPropagation();
        input.value = '';
        listSearch[name] = '';
        clear.hidden = true;
        render();
        fitWindow();
      }
    });
    clear.addEventListener('click', () => {
      input.value = '';
      listSearch[name] = '';
      clear.hidden = true;
      input.focus();
      render();
      fitWindow();
    });
  }

  // 详情页搜索栏
  $('detailSearch').addEventListener('input', onDetailSearchInput);
  $('detailSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && view?.kind === 'knowledge' && semanticMode) {
      runSemanticSearch(detailSearch);
    }
  });
  $('detailSearchClear').addEventListener('click', () => {
    $('detailSearch').value = '';
    onDetailSearchInput();
    $('detailSearch').focus();
  });
  // 语义搜索 toggle（知识详情页）
  $('semToggle').addEventListener('click', () => {
    semanticMode = !semanticMode;
    semanticResults = null;
    semanticReqId += 1;
    $('detailSearch').value = '';
    detailSearch = '';
    $('detailSearchClear').hidden = true;
    $('detailSearchCount').hidden = true;
    onDetailSearchInput();
    $('detailSearch').focus();
  });
  // 全局搜索：Ctrl/⌘+K（卡片模式下任意视图可用）
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
    if (document.body.dataset.mode === 'capsule') return;
    e.preventDefault();
    openGlobalSearch();
  });

  // 快捷键：列表视图下按 / 聚焦第一个区块搜索框
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || view || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    const first = document.querySelector('#listView .sec-search input');
    if (first && !first.closest('.sec').classList.contains('closed')) first.focus();
  });

  // 键盘导航：主列表 j/k 上下移动、Enter 聚焦首个可见行、r 刷新
  document.addEventListener('keydown', (e) => {
    if (view || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (key === 'r') {
      e.preventDefault();
      $('btnRefresh').click();
      return;
    }
    if (key !== 'j' && key !== 'k' && key !== 'Enter') return;
    e.preventDefault();
    // 当前区块内的可交互行（.row / .ke / 会话 toggle），仅可见项
    const section = document.activeElement && document.activeElement.closest('.sec');
    const rows = Array.from((section || document).querySelectorAll('.rows .row, .ke, .srow .sess-toggle'))
      .filter((n) => n.offsetParent !== null);
    if (!rows.length) return;
    const idx = rows.indexOf(document.activeElement);
    if (key === 'Enter') {
      if (idx < 0) rows[0].focus();
      return; // 焦点已在 button 上时 Enter 由浏览器原生触发 click
    }
    const next = key === 'j' ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
    if (next !== idx) rows[next].focus();
  });

  // 底部渐隐与时钟
  $('content').addEventListener('scroll', updateFade);
  const tickClock = () => { $('clk').textContent = i18n.formatTime(new Date()); };
  setInterval(tickClock, 1000);
  tickClock();

  // 刷新
  $('btnRefresh').addEventListener('click', async () => {
    const btn = $('btnRefresh');
    btn.classList.add('rotating');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    $('liveStatus').textContent = t('status.refreshing');
    try {
      snapshot = await invoke('get_snapshot');
      cacheSnapshot(snapshot);
      notifyMigration(snapshot);
      refreshKbCacheOnStatsChange(snapshot);
      renderWithFocus();
      // 高频知识同步强刷
      await loadTopKnowledge(true);
      if (!view) renderOverview();
      $('liveDot').classList.remove('stale');
      $('liveStatus').textContent = t('status.updated', { time: fmtClock2(new Date().toISOString()) });
      // 完成闭环反馈：旋转图标短暂变为勾选（复用复制按钮模式）
      const use = btn.querySelector('use');
      if (use) {
        use.setAttribute('href', 'icons.svg#i-check');
        setTimeout(() => { if (use.isConnected) use.setAttribute('href', 'icons.svg#i-refresh'); }, 900);
      }
    } catch (err) {
      $('liveStatus').textContent = t('status.refreshFailed', { detail: err && err.message ? ' · ' + err.message : '' });
    } finally {
      btn.classList.remove('rotating');
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });

  // 详情返回
  $('btnBack').addEventListener('click', closeDetail);

  // 窗口工具栏：刷新 / 胶囊 / 菜单 / 隐藏 / 退出
  $('btnCapsuleQuick').addEventListener('click', enterCapsule);
  $('btnMenu').addEventListener('click', (e) => toggleMenu($('menuPop').hidden, e.currentTarget));
  $('btnHideWin').addEventListener('click', () => {
    resetDockClient();
    invoke('hide_window');
  });
  $('btnQuitWin').addEventListener('click', () => invoke('quit_app'));

  // 菜单
  $('menuScrim').addEventListener('click', () => toggleMenu(false));
  $('btnTop').addEventListener('click', async () => {
    const btn = $('btnTop');
    const flag = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await invoke('set_always_on_top', { flag });
      applyTop(flag);
    } catch {
      $('liveStatus').textContent = t('status.topFailed');
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
  // 开机自启开关
  const applyAutoStart = (flag) => {
    const btn = $('btnAutoStart');
    btn.setAttribute('aria-checked', String(flag));
    btn.querySelector('i').textContent = flag ? t('common.on') : t('common.off');
  };
  $('btnAutoStart').addEventListener('click', async () => {
    const btn = $('btnAutoStart');
    const flag = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await invoke('set_autostart', { flag });
      applyAutoStart(flag);
      $('liveStatus').textContent = flag ? t('status.autostartEnabled') : t('status.autostartDisabled');
    } catch {
      $('liveStatus').textContent = t('status.autostartFailed');
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
  invoke('get_autostart').then(applyAutoStart).catch(() => { /* 插件不可用时保持关 */ });
  $('btnCapsule').addEventListener('click', enterCapsule);
  $('btnHide').addEventListener('click', () => {
    resetDockClient();
    toggleMenu(false);
    invoke('hide_window');
  });
  $('btnQuit').addEventListener('click', () => invoke('quit_app'));
  $('btnAddRoot').addEventListener('click', async () => {
    toggleMenu(false);
    const path = await dialogOpen({ directory: true, multiple: false });
    if (!path) return;
    const btn = $('btnAddRoot');
    btn.disabled = true;
    try {
      config = await invoke('add_root', { path });
      await refreshWorkspaces();
      snapshot = await invoke('get_snapshot');
      render();
      $('setup').hidden = true;
      $('mainView').hidden = false;
      $('liveStatus').textContent = t('status.projectsAdded', { count: (config.roots || []).length });
    } catch {
      $('liveStatus').textContent = t('setup.invalidDirectory');
    } finally {
      btn.disabled = false;
    }
  });
  // 底部工作空间选择按钮
  $('btnWs').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWsPop();
  });
  // 全局模式切换（全部工程 vs 激活单工程）
  $('btnGlobal').addEventListener('click', async () => {
    const btn = $('btnGlobal');
    const flag = !Boolean(config?.global_mode);
    btn.disabled = true;
    try {
      await invoke('set_global_mode', { flag });
      config = await invoke('get_config');
      snapshot = await invoke('get_snapshot');
      cacheSnapshot(snapshot);
      seedNotifyState(snapshot);
      applyGlobalMode();
      render();
      $('liveStatus').textContent = flag ? t('status.globalEnabled') : t('status.globalDisabled');
    } catch {
      $('liveStatus').textContent = t('status.globalFailed');
    } finally {
      btn.disabled = false;
    }
  });
  // 点击外部关闭选择弹层或胶囊菜单
  document.addEventListener('click', (e) => {
    if (!$('wsPop').hidden && !e.target.closest('#wsPop') && e.target.id !== 'btnWs') {
      toggleWsPop(false);
    }
    if (!$('capMenuPop').hidden && !e.target.closest('#capMenuPop') && !e.target.closest('#btnCapMenu')) {
      toggleCapsuleMenu(false);
    }
  });

  $('btnCapMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCapsuleMenu();
  });
  $('btnCapRestore').addEventListener('click', async (e) => {
    e.stopPropagation();
    await restoreCard();
  });
  $('btnCapTop').addEventListener('click', async () => {
    const btn = $('btnCapTop');
    const flag = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    try {
      await invoke('set_always_on_top', { flag });
      applyTop(flag);
    } catch {
      // 胶囊无状态栏：用上下文 meta 短暂反馈失败（下次渲染自动覆盖）
      $('capContextMeta').textContent = t('status.topFailed');
    } finally {
      btn.disabled = false;
      toggleCapsuleMenu(false);
    }
  });
  $('btnCapHide').addEventListener('click', () => {
    resetDockClient();
    toggleCapsuleMenu(false);
    invoke('hide_window');
  });
  $('btnCapQuit').addEventListener('click', () => invoke('quit_app'));

  // 主题与语言（点击 + radiogroup 方向键，roving tabindex）
  $('localeSelect').addEventListener('change', (event) => {
    i18n.setPreference(event.currentTarget.value);
  });
  const dots = Array.from(document.querySelectorAll('.theme-dot'));
  const selectTheme = (name) => {
    document.body.dataset.theme = name;
    localStorage.setItem('theme', name);
    applyTheme();
  };
  dots.forEach((dot) => {
    dot.addEventListener('click', () => selectTheme(dot.dataset.theme));
  });
  $('themeRow').addEventListener('keydown', (event) => {
    const idx = dots.findIndex((d) => d.dataset.theme === document.body.dataset.theme);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (idx + 1) % dots.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (idx - 1 + dots.length) % dots.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = dots.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTheme(dots[next].dataset.theme);
    dots[next].focus();
  });

  // 壁纸：选择 / 不透明度（80ms 防抖）/ 清除
  const updateWallpaperUI = () => {
    const on = Boolean(config.wallpaper);
    $('wpSliderRow').hidden = !on;
    $('btnWallpaperClear').hidden = !on;
    const name = $('wpName');
    name.textContent = on ? config.wallpaper.split(/[\\/]/).pop() : '';
    name.classList.toggle('on', on);
    if (on) {
      $('wpOpacity').value = String(Math.round((config.wallpaper_opacity ?? 0.45) * 100));
      $('wpVal').textContent = `${$('wpOpacity').value}%`;
    }
  };
  $('btnWallpaper').addEventListener('click', async () => {
    const path = await dialogOpen({
      directory: false,
      multiple: false,
      filters: [{ name: t('settings.chooseWallpaper'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (!path) return;
    try {
      config = await invoke('set_wallpaper', { path });
      applyWallpaper(config);
      updateWallpaperUI();
      $('liveStatus').textContent = t('status.wallpaperApplied');
    } catch {
      $('liveStatus').textContent = t('status.wallpaperUnavailable');
    }
  });
  let wpTimer = null;
  $('wpOpacity').addEventListener('input', () => {
    const v = $('wpOpacity').value;
    $('wpVal').textContent = `${v}%`;
    document.body.style.setProperty('--wp-opacity', String(Number(v) / 100));
    clearTimeout(wpTimer);
    wpTimer = setTimeout(async () => {
      try {
        config = await invoke('set_wallpaper_opacity', { opacity: Number(v) / 100 });
      } catch {
        // 本地预览保留，但持久化失败要可感知
        $('liveStatus').textContent = t('status.wallpaperOpacityUnsaved');
      }
    }, 80);
  });
  $('btnWallpaperClear').addEventListener('click', async () => {
    try {
      config = await invoke('clear_wallpaper');
      applyWallpaper(config);
      updateWallpaperUI();
      $('liveStatus').textContent = t('status.wallpaperCleared');
    } catch {
      $('liveStatus').textContent = t('status.clearFailed');
    }
  });

  // 胶囊 → 卡片：双击面板直达对应详情（单击 mousedown 仍走窗口拖拽，event.detail>1 不触发拖拽）
  $('capSessionPanel').title = t('capsule.doubleClickSession');
  $('capAgentPanel').title = t('capsule.doubleClickCall');
  $('capSessionPanel').addEventListener('dblclick', async () => {
    const active = findActiveSession(snapshot);
    await restoreCard();
    if (active) openDetail('session', active.session_id, null, false, active.project_path);
  });
  $('capAgentPanel').addEventListener('dblclick', async () => {
    const calls = snapshot?.calls || [];
    const running = calls.filter((c) => callStatus(c) === 'running');
    const target = running[0] || calls[0];
    await restoreCard();
    if (target) openDetail('call', target.execId);
  });

  // Esc 关闭菜单或返回列表；菜单打开时 Tab 焦点陷阱
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('capMenuPop').hidden) {
        toggleCapsuleMenu(false);
        $('btnCapMenu').focus();
      } else if (!$('menuPop').hidden) {
        toggleMenu(false);
      } else if (!view && (listSearch.calls || listSearch.sessions || listSearch.knowledge)) {
        // 主视图：Esc 逐层清除区块搜索
        for (const name of ['calls', 'sessions', 'knowledge']) {
          if (listSearch[name]) {
            const input = $(`${name}Search`);
            input.value = '';
            listSearch[name] = '';
            $(`${name}SearchClear`).hidden = true;
            render();
            fitWindow();
            return;
          }
        }
      } else if (view && $('detailSearch').value) {
        // 详情页：先清除搜索，再返回
        $('detailSearch').value = '';
        onDetailSearchInput();
      } else if (view) {
        closeDetail();
      }
      return;
    }
    if (event.key === 'Tab' && !$('menuPop').hidden) {
      const focusables = Array.from($('menuPop').querySelectorAll('button:not([disabled]), select:not([disabled]), input[type="range"]')).filter((n) => !n.hidden);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // 设置引导
  $('btnScanExisting').addEventListener('click', async () => {
    const path = await dialogOpen({ directory: true, multiple: false });
    if (!path) return;
    try {
      config = await invoke('add_root', { path });
      $('setup').hidden = true;
      $('mainView').hidden = false;
      await refreshWorkspaces();
      snapshot = await invoke('get_snapshot');
      render();
    } catch {
      $('setupError').hidden = false;
    }
  });
  $('btnUseDefaults').addEventListener('click', async () => {
    try { await invoke('complete_setup'); } catch {}
    config = await invoke('get_config');
    $('setup').hidden = true;
    $('mainView').hidden = false;
    snapshot = await invoke('get_snapshot');
    render();
  });
}

function toggleMenu(open, trigger = null) {
  if (open) menuTrigger = trigger || document.activeElement;
  $('menuPop').hidden = !open;
  $('menuScrim').hidden = !open;
  $('btnMenu').setAttribute('aria-expanded', String(open));
  if (open) {
    requestAnimationFrame(() => $('menuPop').focus());
  } else if (menuTrigger && typeof menuTrigger.focus === 'function') {
    menuTrigger.focus();
    menuTrigger = null;
  }
}

function applyTop(flag) {
  $('btnTop').setAttribute('aria-checked', String(flag));
  $('btnTop').querySelector('i').textContent = flag ? t('common.on') : t('common.off');
  $('btnCapTop').setAttribute('aria-checked', String(flag));
  $('btnCapTop').querySelector('i').textContent = flag ? t('common.on') : t('common.off');
}

function applyLocaleUi() {
  i18n.applyTranslations(document);
  const select = $('localeSelect');
  if (select) select.value = i18n.getPreference();
  for (const dot of document.querySelectorAll('.theme-dot')) {
    const name = t(dot.dataset.themeNameKey);
    dot.title = name;
    dot.setAttribute('aria-label', t('settings.theme', { name }));
  }
  for (const id of ['btnTop', 'btnCapTop', 'btnAutoStart']) {
    const button = $(id);
    if (!button) continue;
    button.querySelector('i').textContent = button.getAttribute('aria-checked') === 'true' ? t('common.on') : t('common.off');
  }
  $('capSessionPanel').title = t('capsule.doubleClickSession');
  $('capAgentPanel').title = t('capsule.doubleClickCall');
}

window.addEventListener('maestro-locale-changed', () => {
  applyLocaleUi();
  if (config) {
    applyGlobalMode();
    renderRootList();
  }
  if (snapshot) renderWithFocus();
});

function applyTheme() {
  const supported = ['graphite', 'mist', 'glass', 'ember', 'blueprint', 'ocean', 'sunset'];
  const aliases = { specimen: 'graphite', synthwave: 'ember' };
  const stored = aliases[localStorage.getItem('theme')] || localStorage.getItem('theme');
  const theme = supported.includes(stored) ? stored : 'graphite';
  document.body.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  // roving tabindex：radio 组单 Tab 停靠 + 方向键
  document.querySelectorAll('.theme-dot').forEach((dot) => {
    const selected = dot.dataset.theme === theme;
    dot.classList.toggle('active', selected);
    dot.setAttribute('aria-checked', String(selected));
    dot.tabIndex = selected ? 0 : -1;
  });
}

/** 应用自定义壁纸：config.wallpaper → asset URL + 不透明度；文件失效时静默回退主题背景 */
function applyWallpaper(cfg) {
  const path = cfg && cfg.wallpaper;
  const opacity = cfg && typeof cfg.wallpaper_opacity === 'number' ? cfg.wallpaper_opacity : 0.45;
  document.body.style.setProperty('--wp-opacity', String(opacity));
  const world = $('world');
  if (!path) {
    document.body.classList.remove('has-wallpaper');
    world.style.removeProperty('--wp-img');
    return;
  }
  const url = TAURI?.core?.convertFileSrc ? TAURI.core.convertFileSrc(path) : `file:///${path.replace(/\\/g, '/')}`;
  const probe = new Image();
  probe.onload = () => {
    document.body.classList.add('has-wallpaper');
    world.style.setProperty('--wp-img', `url("${url}")`);
  };
  probe.onerror = () => {
    document.body.classList.remove('has-wallpaper');
    world.style.removeProperty('--wp-img');
    $('liveStatus').textContent = t('status.wallpaperMissing');
  };
  probe.src = url;
}

function renderRootList() {
  const box = $('rootList');
  box.innerHTML = '';
  if (!workspaces.length) {
    box.appendChild(el('div', 'mp-label', t('workspace.notFound')));
    return;
  }
  for (const ws of workspaces) {
    const row = el('button', `mp-row${ws.active ? ' active-ws' : ''}`);
    row.type = 'button';
    row.title = ws.active ? `${ws.name} (${t('workspace.current')})` : t('workspace.switchTo', { name: ws.name });
    row.setAttribute('aria-label', t('workspace.aria', { name: ws.name, current: ws.active ? ` (${t('workspace.current')})` : '' }));
    row.appendChild(svg(ws.source === 'root' ? 'i-folder' : 'i-git', 12));
    const span = el('span', 'root-path', `${ws.name} · ${ws.path}`);
    span.title = ws.path;
    row.appendChild(span);
    // 激活标记（✓）
    if (ws.active) {
      const mark = el('span', 'ws-mark', '✓');
      row.appendChild(mark);
    } else {
      row.appendChild(el('span', 'ws-mark', ''));
    }
    // 切换激活
    row.addEventListener('click', async () => {
      if (ws.active) return;
      try {
        await invoke('set_active_root', { path: ws.path });
        config = await invoke('get_config');
        snapshot = await invoke('get_snapshot');
        render();
        await refreshWorkspaces();
        $('liveStatus').textContent = t('status.switchedWorkspace', { name: ws.name });
        fitWindow();
      } catch {
        $('liveStatus').textContent = t('status.switchFailed');
      }
    });
    // 删除（仅 root 来源）
    if (ws.source === 'root' && config?.roots?.includes(ws.path)) {
      const trash = el('span', 'ws-trash', '');
      trash.title = t('workspace.remove');
      trash.setAttribute('role', 'button');
      trash.setAttribute('aria-label', t('workspace.removeAria', { name: ws.name }));
      trash.appendChild(svg('i-trash', 11));
      trash.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(t('workspace.removeConfirm', { path: ws.path }))) return;
        config = await invoke('remove_root', { path: ws.path });
        await refreshWorkspaces();
        snapshot = await invoke('get_snapshot');
        render();
      });
      row.appendChild(trash);
    }
    box.appendChild(row);
  }
}

/** 拉取工作空间列表并渲染：菜单工程组 + 底部切换按钮 */
async function refreshWorkspaces() {
  try {
    workspaces = await invoke('list_workspaces');
  } catch {
    workspaces = [];
  }
  renderRootList();
  const active = workspaces.find((w) => w.active) || workspaces[0] || null;
  const name = active ? active.name : (snapshot?.workspace || '—');
  $('wsName').textContent = name;
  $('wsName').title = active ? active.path : '';
}

/** 工作空间选择弹层开关 */
function toggleWsPop(open) {
  const pop = $('wsPop');
  const show = open !== undefined ? open : pop.hidden;
  pop.hidden = !show;
  $('btnWs').setAttribute('aria-expanded', String(show));
  if (show) renderWorkspacePop();
}

/** 渲染工作空间选择列表（当前项 ✓ 且置顶） */
function renderWorkspacePop() {
  const list = $('wsList');
  list.innerHTML = '';
  const order = [...workspaces].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  for (const ws of order) {
    const row = el('button', `ws-item${ws.active ? ' active' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(ws.active));
    row.appendChild(el('span', 'ws-item-name', ws.name));
    row.appendChild(el('span', 'ws-item-path', ws.path));
    row.appendChild(el('span', 'ws-item-src', ws.source === 'root' ? t('workspace.root') : t('workspace.automatic')));
    row.appendChild(el('span', 'ws-item-mark', ws.active ? '✓' : ''));
    row.addEventListener('click', async () => {
      if (ws.active) { toggleWsPop(false); return; }
      try {
        await invoke('set_active_root', { path: ws.path });
        config = await invoke('get_config');
        snapshot = await invoke('get_snapshot');
        render();
        await refreshWorkspaces();
        toggleWsPop(false);
        $('liveStatus').textContent = t('status.switchedWorkspace', { name: ws.name });
        fitWindow();
      } catch {
        $('liveStatus').textContent = t('status.switchFailed');
      }
    });
    list.appendChild(row);
  }
}

/** 切换到下一个工作空间（胶囊 chip 循环） */
async function cycleWorkspace() {
  if (workspaces.length < 2) {
    $('liveStatus').textContent = workspaces.length === 1 ? t('status.oneWorkspace') : t('status.noWorkspace');
    return;
  }
  const idx = workspaces.findIndex((w) => w.active);
  const next = workspaces[(idx + 1) % workspaces.length];
  try {
    await invoke('set_active_root', { path: next.path });
    config = await invoke('get_config');
    snapshot = await invoke('get_snapshot');
    render();
    await refreshWorkspaces();
    $('liveStatus').textContent = t('status.switchedWorkspace', { name: next.name });
    fitWindow();
  } catch {
    $('liveStatus').textContent = t('status.switchFailed');
  }
}

// ---------------------------------------------------------------------------
// 系统通知：状态迁移检测
// 规则：call running/queued → done/error；session running/paused → blocked/failed。
// 首次快照只登记状态（seed），之后每次快照更新检测迁移并去重（迁移只发生一次）。
// ---------------------------------------------------------------------------

function seedNotifyState(snap) {
  notifySeen.calls = new Map((snap.calls || []).map((c) => [c.execId, callStatus(c)]));
  notifySeen.sessions = new Map(
    (snap.sessions || []).map((s) => [sessionObjectKey(s), String(s.status || '').toLowerCase()]),
  );
  notifyReady = true;
  lastKbStatsDigest = JSON.stringify(snap.knowledge || null);
}

/** 知识统计变化 → 条目列表缓存失效（md 类计数变化即文件增删/编辑） */
function refreshKbCacheOnStatsChange(snap) {
  const digest = JSON.stringify(snap?.knowledge || null);
  if (digest !== lastKbStatsDigest) {
    lastKbStatsDigest = digest;
    invalidateKnowledgeCaches();
  }
}

function notifyMigration(snap) {
  if (!snap || !notifyReady) return;
  const calls = snap.calls || [];
  for (const c of calls) {
    const prev = notifySeen.calls.get(c.execId);
    const now = callStatus(c);
    if (prev !== undefined && prev !== now
      && ['running', 'queued'].includes(prev)
      && ['done', 'error'].includes(now)) {
      const tool = TOOL_LABEL[c.tool] || c.tool || 'Agent';
      const title = now === 'done' ? t('notifications.agentDone', { tool }) : t('notifications.agentFailed', { tool });
      const body = oneLine(c.prompt || t('overview.noPrompt')).slice(0, 120);
      invoke('notify', { title, body }).catch(() => {});
    }
    notifySeen.calls.set(c.execId, now);
  }
  // 清理已不在快照中的记录（防止 map 无限增长）
  const seenCalls = new Set(calls.map((c) => c.execId));
  for (const k of notifySeen.calls.keys()) {
    if (!seenCalls.has(k)) notifySeen.calls.delete(k);
  }

  const sessions = snap.sessions || [];
  for (const s of sessions) {
    const sessionKey = sessionObjectKey(s);
    const prev = notifySeen.sessions.get(sessionKey);
    const now = String(s.status || '').toLowerCase();
    if (prev !== undefined && prev !== now
      && ['running', 'active', 'executing', 'paused'].includes(prev)
      && ['blocked', 'failed', 'error'].includes(now)) {
      const body = oneLine(s.intent || s.session_id).slice(0, 120);
      invoke('notify', { title: t('notifications.sessionBlocked'), body }).catch(() => {});
    }
    notifySeen.sessions.set(sessionKey, now);
  }
  const seenSessions = new Set(sessions.map(sessionObjectKey));
  for (const key of notifySeen.sessions.keys()) {
    if (!seenSessions.has(key)) notifySeen.sessions.delete(key);
  }
}

function applyGlobalMode() {
  const on = Boolean(config?.global_mode);
  const btn = $('btnGlobal');
  btn.setAttribute('aria-pressed', String(on));
  $('globalName').textContent = on ? t('workspace.global') : t('workspace.singleProject');
  btn.title = on ? t('workspace.globalTitle') : t('workspace.singleTitle');
}

// ---------------------------------------------------------------------------
// 渲染主入口
// ---------------------------------------------------------------------------

function render() {
  if (!snapshot) return;
  $('wsChip').textContent = config?.global_mode && workspaces.length > 1
    ? t('workspace.globalCount', { count: workspaces.length })
    : (snapshot.workspace || t('workspace.notConnected'));
  $('wsChip').title = snapshot.workspace || '';

  // 详情视图
  if (view) {
    $('listView').hidden = true;
    $('detailView').hidden = false;
    if (view.kind === 'call') renderCallDetail();
    else if (view.kind === 'calls') renderCallsListDetail();
    else if (view.kind === 'sessions') renderSessionsListDetail();
    else if (view.kind === 'knowledge') renderKnowledgeDetail();
    else if (view.kind === 'knowledge-item') renderKnowledgeItemDetail();
    else if (view.kind === 'pending') renderPendingDetail();
    else renderSessionDetail();
  } else {
    $('detailView').hidden = true;
    $('listView').hidden = false;
    renderCalls();
    renderSessions();
    renderKnowledge();
    renderOverview();
  }
  updateDetailSearchUI();
  renderCapsule();
  fitWindow();
  scheduleFade();
}

// ---------------------------------------------------------------------------
// 搜索 & 顶部概览
// ---------------------------------------------------------------------------

/** 关键词高亮：命中片段包 <mark>（不转义，直接按原文切分） */
function highlightText(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return document.createTextNode(t);
  const lower = t.toLowerCase();
  const frag = document.createDocumentFragment();
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      frag.appendChild(document.createTextNode(t.slice(i)));
      break;
    }
    if (idx > i) frag.appendChild(document.createTextNode(t.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.textContent = t.slice(idx, idx + q.length);
    frag.appendChild(mark);
    i = idx + q.length;
  }
  return frag;
}

/** 详情搜索命中计数（无搜索时隐藏） */
function setSearchCount(matched, total) {
  const el0 = $('detailSearchCount');
  if (!detailSearch) {
    el0.hidden = true;
    return;
  }
  el0.hidden = false;
  el0.textContent = `${matched} / ${total}`;
}

function emptySearchResult(text) {
  const d = el('div', 'detail-empty');
  d.appendChild(el('div', '', text || t('search.noMatch')));
  d.appendChild(el('div', 'empty-hint', t('search.tryAnother')));
  return d;
}

/** 调用匹配：提示词 / 模型 / 工具 / execId / 模式 / 目录 */
function matchCall(c, q) {
  if (!q) return true;
  return [c.prompt, c.lastOutputPreview, c.model, c.tool, c.execId, c.mode, c.workDir]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

/** Return the complete active Run set while retaining legacy singular data. */
function sessionActiveRunIds(session) {
  const ids = Array.isArray(session?.active_run_ids)
    ? session.active_run_ids.filter(Boolean).map(String)
    : [];
  if (!ids.length && session?.active_run_id) ids.push(String(session.active_run_id));
  return [...new Set(ids)];
}

function sessionLocatorKey(sessionId, projectPath = '') {
  return `${projectPath || ''}::${sessionId}`;
}

function sessionObjectKey(session) {
  return sessionLocatorKey(
    session?.session_id || '',
    session?.project_path || session?.project || '',
  );
}

function findActiveSession(snap) {
  const sessions = snap?.sessions || [];
  if (snap?.active_project_path) {
    const exact = sessions.find((session) => (
      session.session_id === snap.active_session_id
      && session.project_path === snap.active_project_path
    ));
    if (exact) return exact;
  }
  return sessions.find((session) => session.session_id === snap?.active_session_id)
    || sessions[0]
    || null;
}

function isRunActive(run, session) {
  return Boolean(run?.run_id) && sessionActiveRunIds(session).includes(String(run.run_id));
}

function runExecutorLabel(run) {
  if (run?.platform) return TOOL_LABEL[run.platform] || run.platform;
  return run?.actor_id ? `@${run.actor_id}` : '';
}

function runDisplayTime(run) {
  return run?.started_at || run?.created_at || run?.completed_at || null;
}

/** 会话匹配：ID / 意图 / 工程 / 状态 / 最新 Run */
function matchSession(s, q) {
  if (!q) return true;
  const run = s.latest_run || {};
  const hay = [
    s.session_id, s.intent, s.project, s.status, sessionActiveRunIds(s).join(' '),
    run.command, run.platform, run.actor_id, run.verdict, run.status, run.run_id, run.handoff_summary,
  ]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
  return hay;
}

/** Run 匹配：序号 / 命令 / run_id / verdict / 交接 / 决策 / 疑虑 / 门禁 */
function runMatches(run, q) {
  if (!q) return true;
  const parts = [
    run.sequence, run.command, run.platform, run.actor_id, run.run_id, run.verdict, run.status,
    run.handoff_summary, (run.decisions || []).join(' '), (run.concerns || []).join(' '),
    (run.gate_ids || []).join(' '),
  ];
  return parts.filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
}

/** 知识条目匹配：标题 / ID / 摘要 / 标签 / 状态 */
function matchKbItem(item, q) {
  if (!q) return true;
  return [item.title, item.id, item.summary, item.status, (item.tags || []).join(' ')]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

/** 知识条目全量缓存（详情页与区块搜索共用一次拉取） */
function getKbItems(force) {
  if (force || !kbItemsPromise) {
    kbItemsPromise = invoke('get_knowledge_items')
      .then((items) => (Array.isArray(items) ? items : []))
      .catch(() => []);
  }
  return kbItemsPromise;
}

function invalidateKnowledgeCaches(kind, id) {
  kbItemsPromise = null;
  topKbCache = { ts: 0, items: null };
  delete detailCache['knowledge::all'];
  if (kind && id) delete detailCache[`knowledge-item::${kind}::${id}`];
}

async function refreshKnowledgeCaches(payload) {
  const kind = String(payload?.kind || '');
  const id = String(payload?.id || '');
  invalidateKnowledgeCaches(kind, id);

  if (view?.kind === 'knowledge') {
    const currentId = view.id;
    const items = await getKbItems(true);
    if (view?.kind !== 'knowledge' || view.id !== currentId) return;
    detail = { items };
    detailStatus = 'ready';
    detailCache[`knowledge::${currentId}`] = detail;
    renderWithFocus();
    return;
  }

  const itemId = `${kind}::${id}`;
  if (kind && id && view?.kind === 'knowledge-item' && view.id === itemId) {
    const item = await invoke('get_knowledge_item_content', { kind, id }).catch(() => null);
    if (view?.kind !== 'knowledge-item' || view.id !== itemId) return;
    detail = item ? { item } : null;
    detailStatus = item ? 'ready' : 'not-found';
    if (item) detailCache[`knowledge-item::${itemId}`] = detail;
    renderWithFocus();
    return;
  }

  if (!view) renderWithFocus();
}

/** 高频知识：30s TTL 缓存，force 强制刷新 */
async function loadTopKnowledge(force = false) {
  if (!force && topKbCache.items && Date.now() - topKbCache.ts < TOP_KB_TTL) {
    return topKbCache.items;
  }
  try {
    const items = await invoke('get_top_knowledge', { limit: TOP_KB_LIMIT });
    topKbCache = { ts: Date.now(), items: Array.isArray(items) ? items : [] };
  } catch {
    if (!topKbCache.items) topKbCache = { ts: Date.now(), items: [] };
  }
  return topKbCache.items;
}

/** 顶部概览卡的紧凑统计网格。 */
function renderOverviewStats(container, items) {
  container.innerHTML = '';
  for (const item of items) {
    const stat = el('div', 'ov-stat');
    stat.appendChild(el('span', 'ov-stat-label', item.label));
    stat.appendChild(el('strong', `ov-stat-value${item.tone ? ` ${item.tone}` : ''}`, String(item.value)));
    container.appendChild(stat);
  }
}

/** 顶部概览条：实时运行（Agent/会话）+ 高频知识沉淀 */
async function renderOverview() {
  if (view) return;
  const sessions = snapshot.sessions || [];
  const runningSessions = sessions.filter((s) =>
    ['running', 'active', 'executing'].includes(String(s.status || '').toLowerCase()),
  );
  const calls = snapshot.calls || [];
  const runningCalls = calls.filter((c) => callStatus(c) === 'running');
  const failedSessions = sessions.filter((s) => ['failed', 'blocked', 'error'].includes(String(s.status || '').toLowerCase())).length;
  const failedCalls = calls.filter((c) => callStatus(c) === 'error').length;
  const runningTotal = runningSessions.length + runningCalls.length;
  $('ovRunningCount').textContent = String(runningTotal);
  renderOverviewStats($('ovRunningStats'), [
    { label: 'Session', value: sessions.length },
    { label: 'Agent', value: calls.length },
    { label: t('overview.running'), value: runningTotal, tone: 'live' },
    { label: t('overview.issues'), value: failedSessions + failedCalls, tone: failedSessions + failedCalls ? 'warn' : '' },
  ]);
  const knowledge = snapshot.knowledge || {};
  $('ovTopKbCount').textContent = String(knowledge.total || 0);
  renderOverviewStats($('ovTopKbStats'), [
    { label: t('overview.specs'), value: knowledge.specs || 0 },
    { label: t('overview.memory'), value: knowledge.memory || 0 },
    { label: 'Know-how', value: knowledge.knowhow || 0 },
    { label: 'Learning', value: knowledge.learning_rows || 0 },
  ]);
  const rBody = $('ovRunningBody');
  rBody.innerHTML = '';
  if (!runningSessions.length && !runningCalls.length) {
    rBody.appendChild(el('div', 'ov-empty', t('overview.noRunning')));
  } else {
    for (const s of runningSessions.slice(0, 2)) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = t('overview.openSession', { id: s.session_id });
      const dot = el('span', 'dot pulse');
      dot.style.setProperty('--c', 'var(--ok)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', t('overview.session')));
      txt.appendChild(el('span', 'ov-row-b', oneLine(s.intent) || s.session_id));
      row.appendChild(txt);
      row.addEventListener('click', () => openDetail(
        'session', s.session_id, row, false, s.project_path,
      ));
      rBody.appendChild(row);
    }
    for (const c of runningCalls.slice(0, 2)) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = t('overview.openCall', { id: c.execId });
      const dot = el('span', 'dot pulse');
      dot.style.setProperty('--c', TOOL_COLORS[c.tool] || 'var(--ok)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', TOOL_LABEL[c.tool] || c.tool || 'Agent'));
      txt.appendChild(el('span', 'ov-row-b', oneLine(c.prompt) || t('overview.noPrompt')));
      row.appendChild(txt);
      row.addEventListener('click', () => openDetail('call', c.execId, row));
      rBody.appendChild(row);
    }
  }
  // 高频知识沉淀
  const kb = await loadTopKnowledge();
  if (view) return; // 等待期间已切换视图
  const kbBody = $('ovTopKbBody');
  kbBody.innerHTML = '';
  if (!kb.length) {
    kbBody.appendChild(el('div', 'ov-empty', t('overview.noTopKnowledge')));
  } else {
    for (const item of kb) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = t('overview.openKnowledge', { id: item.id, count: item.frequency });
      const dot = el('span', 'lg-dot');
      dot.style.setProperty('--c', 'var(--accent)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', item.title || item.id));
      txt.appendChild(el('span', 'ov-row-b', item.summary ? oneLine(item.summary) : t('overview.usedTimes', { count: item.frequency })));
      row.appendChild(txt);
      const freq = el('span', 'ov-freq', `×${item.frequency ?? '—'}`);
      freq.title = t('overview.frequency', { count: item.frequency });
      row.appendChild(freq);
      row.addEventListener('click', () => openDetail('knowledge-item', `${item.kind}::${item.id}`, row));
      kbBody.appendChild(row);
    }
  }
}

/** 详情搜索输入：仅重渲染详情正文（保留标题/滚动位置） */
function onDetailSearchInput() {
  const input = $('detailSearch');
  const nextSearch = input.value.trim().toLowerCase();
  if (view?.kind === 'call') {
    const call = detail?.call || { execId: view.id };
    captureCallDetailViewport(call.execId || view.id);
    const state = getCallDetailUi(call);
    if (!detailSearch && nextSearch) {
      state.followBeforeSearch = state.followLive;
      state.scrollBeforeSearch = state.scrollTop;
      state.followLive = false;
      state.skipNextCapture = true;
    } else if (detailSearch && !nextSearch) {
      restoreCallDetailSearchState(call.execId || view.id);
    }
  }
  detailSearch = nextSearch;
  $('detailSearchClear').hidden = !input.value;
  if (!view) return;
  // 语义模式：输入即触发（防抖 300ms），回车兜底
  if (view.kind === 'knowledge' && semanticMode) {
    clearTimeout(semanticTimer);
    semanticTimer = setTimeout(() => runSemanticSearch(nextSearch), 300);
    renderKnowledgeDetail();
    scheduleFade();
    return;
  }
  if (view.kind === 'call') renderCallDetail();
  else if (view.kind === 'calls') renderCallsListDetail();
  else if (view.kind === 'session') renderSessionDetail();
  else if (view.kind === 'sessions') renderSessionsListDetail();
  else if (view.kind === 'knowledge') renderKnowledgeDetail();
  else if (view.kind === 'pending') renderPendingDetail();
  else renderKnowledgeItemDetail();
  scheduleFade();
}

/** 详情搜索栏可见性 + 占位符随视图类型切换 */
function updateDetailSearchUI() {
  const row = $('detailSearchRow');
  const input = $('detailSearch');
  row.hidden = !view;
  if (!view) return;
  // 语义搜索 toggle 仅知识详情页可用
  const sem = $('semToggle');
  const kbView = view.kind === 'knowledge';
  sem.hidden = !kbView;
  sem.setAttribute('aria-pressed', String(kbView && semanticMode));
  sem.textContent = semanticMode ? t('search.semanticOn') : t('search.semantic');
  const ph = {
    call: t('search.callPlaceholder'),
    calls: t('search.callsPlaceholder'),
    session: t('search.sessionPlaceholder'),
    sessions: t('search.sessionsPlaceholder'),
    knowledge: semanticMode ? t('search.semanticPlaceholder') : t('search.knowledgePlaceholder'),
    'knowledge-item': t('search.fullTextPlaceholder'),
    pending: t('search.pendingPlaceholder'),
  };
  input.placeholder = ph[view.kind] || t('common.search');
  $('detailSearchCount').hidden = !detailSearch;
}

// ---------------------------------------------------------------------------
// Agent 调用（列表）
// ---------------------------------------------------------------------------

function renderCalls() {
  const all = snapshot.calls || [];
  const q = listSearch.calls;
  const searching = Boolean(q);
  const filtering = Boolean(callsFilter.status || callsFilter.tool);
  let calls = q ? all.filter((c) => matchCall(c, q)) : all;
  if (callsFilter.status) calls = calls.filter((c) => callStatus(c) === callsFilter.status);
  if (callsFilter.tool) calls = calls.filter((c) => (c.tool || '') === callsFilter.tool);
  $('callsCount').textContent = (q || filtering) ? `${calls.length}/${all.length}` : String(all.length);
  $('callsEmpty').hidden = all.length > 0 && !((searching || filtering) && !calls.length);
  renderCallFilterChips();
  // Section 头状态 chip：运行中调用数
  let meta = $('headCalls').querySelector('.sh-meta');
  if (meta) meta.remove();
  const runningCount = all.filter((c) => callStatus(c) === 'running').length;
  if (runningCount > 0) {
    meta = el('span', 'sh-meta');
    const hm = el('span', 'hm run');
    const dot = el('i', 'hm-dot');
    dot.style.setProperty('--c', 'var(--ok)');
    hm.appendChild(dot);
    hm.appendChild(document.createTextNode(t('calls.runCount', { count: runningCount })));
    meta.appendChild(hm);
    $('headCalls').insertBefore(meta, $('callsCount'));
  }
  const list = $('callsList');
  list.innerHTML = '';
  const visibleCalls = searching || filtering || callsExpanded ? calls : calls.slice(0, CALLS_LIMIT);
  for (const call of visibleCalls) list.appendChild(callRowEl(call, q));
  if (!all.length) {
    const empty = $('callsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-activity', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', t('sections.noCalls')));
    empty.appendChild(el('div', 'empty-hint', t('calls.emptyHint')));
  } else if ((searching || filtering) && !calls.length) {
    const empty = $('callsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-search', 18));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', t('search.noMatchingCalls')));
    empty.appendChild(el('div', 'empty-hint', t('search.callsHint')));
  }
  const foot = $('callsFoot');
  foot.innerHTML = '';
  if (calls.length > CALLS_LIMIT && !searching) {
    foot.hidden = false;
    const expand = el('button', 'expand-btn', callsExpanded ? t('calls.collapse') : t('calls.expandAll', { count: calls.length }));
    expand.type = 'button';
    expand.setAttribute('aria-expanded', String(callsExpanded));
    expand.addEventListener('click', () => {
      callsExpanded = !callsExpanded;
      renderCalls();
      const newBtn = $('callsFoot').querySelector('.expand-btn');
      if (newBtn) newBtn.focus();
      fitWindow();
      scheduleFade();
    });
    foot.appendChild(expand);
  } else {
    foot.hidden = true;
  }
}

/** 调用筛选 chips（状态 + 工具，工具集来自快照动态生成） */
function renderCallFilterChips() {
  const wrap = $('callsFilterRow');
  if (!wrap) return;
  wrap.innerHTML = '';
  const statuses = [
    ['', t('common.all')], ['running', t('common.running')], ['error', t('common.failed')], ['done', t('common.done')],
    ['queued', t('common.queued')], ['cancel', t('common.cancelled')],
  ];
  for (const [val, label] of statuses) {
    const chip = el('button', `fchip${callsFilter.status === val ? ' on' : ''}`, label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(callsFilter.status === val));
    chip.addEventListener('click', () => {
      callsFilter.status = callsFilter.status === val ? '' : val;
      renderCalls();
      fitWindow();
      scheduleFade();
    });
    wrap.appendChild(chip);
  }
  const sep = el('span', 'fchip-sep');
  sep.setAttribute('aria-hidden', 'true');
  wrap.appendChild(sep);
  const tools = [...new Set((snapshot.calls || []).map((c) => c.tool).filter(Boolean))].sort();
  for (const t of tools) {
    const label = TOOL_LABEL[t] || t;
    const chip = el('button', `fchip${callsFilter.tool === t ? ' on' : ''}`, label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(callsFilter.tool === t));
    chip.addEventListener('click', () => {
      callsFilter.tool = callsFilter.tool === t ? '' : t;
      renderCalls();
      fitWindow();
      scheduleFade();
    });
    wrap.appendChild(chip);
  }
}

/** 单条调用行（列表视图与「全部调用」详情视图共用） */
function callRowEl(call, q) {
  const running = callStatus(call) === 'running';
  const item = el('button', 'row');
  item.type = 'button';
  item.title = oneLine(call.prompt) || t('calls.call');
  item.setAttribute('aria-label', t('calls.aria', {
    tool: TOOL_LABEL[call.tool] || call.tool || 'Agent',
    prompt: oneLine(call.prompt) || t('overview.noPrompt'),
    status: callStatusLabel(call),
  }));
  const dot = el('span', `dot${running ? ' pulse' : ''}`);
  dot.style.setProperty('--c', TOOL_COLORS[call.tool] || 'var(--text-dim)');
  item.appendChild(dot);

  const rb = el('div', 'rb');
  const rl = el('div', 'rl');
  const toolN = el('span', 'tool-n');
  toolN.appendChild(highlightText(TOOL_LABEL[call.tool] || call.tool || 'Agent', q));
  rl.appendChild(toolN);
  if (call.model) {
    const m = el('span', 'model');
    m.appendChild(highlightText(call.model, q));
    rl.appendChild(m);
  }
  const rc = el('span', 'rc');
  rc.appendChild(el('span', 'rt', fmtAgo(call.startedAt)));
  rc.appendChild(el('span', `bd ${callStatusClass(call)}`, callStatusLabel(call)));
  rl.appendChild(rc);
  rb.appendChild(rl);
  const livePreview = running ? oneLine(call.lastOutputPreview) : '';
  const rp = el('div', `rp${livePreview ? ' live' : ''}`);
  rp.appendChild(highlightText(livePreview || oneLine(call.prompt) || t('calls.emptyPrompt'), q));
  rb.appendChild(rp);
  item.appendChild(rb);

  item.addEventListener('click', () => openDetail('call', call.execId, item));
  return item;
}

function callStatus(call) {
  const delegate = String(call.delegateStatus || '').toLowerCase();
  if (delegate === 'cancelling' || delegate === 'cancelled') return 'cancel';
  if (delegate === 'queued') return 'queued';
  if (delegate === 'running') return 'running';
  if (call.completedAt) return call.exitCode === 0 ? 'done' : 'error';
  // 无 completed_at 且无 delegate：仅当 started_at 新鲜（≤10 分钟）才算运行中；
  // 陈旧记录（中断/测试探针/旧版 meta）显示未知，避免误报「运行中」
  const activity = Number(call.lastActivityMs);
  const started = call.startedAt ? new Date(call.startedAt).getTime() : NaN;
  const t = Number.isFinite(activity) && activity > 0 ? activity : started;
  if (!Number.isNaN(t) && Date.now() - t < 10 * 60 * 1000) return 'running';
  return 'unknown';
}
function callStatusClass(call) {
  switch (callStatus(call)) {
    case 'done': return 'st-done';
    case 'error': return 'st-error';
    case 'cancel': return 'st-cancel';
    case 'queued': return 'st-queued';
    case 'unknown': return 'st-unknown';
    default: return 'st-running';
  }
}
function callStatusLabel(call) {
  switch (callStatus(call)) {
    case 'done': return t('common.done');
    case 'error': return t('common.failed');
    case 'cancel': return t('common.cancelled');
    case 'queued': return t('common.queued');
    case 'unknown': return call.delegateStatus || t('common.unknown');
    default: return t('common.running');
  }
}

// ---------------------------------------------------------------------------
// Session · Run（列表 + 时间线展开）
// ---------------------------------------------------------------------------

function sessionStatusMeta(status, activeRunCount = 0) {
  const s = String(status || '').toLowerCase();
  if (activeRunCount > 0 || s === 'running' || s === 'active' || s === 'executing') {
    return ['st-running', t('common.running'), true, 'var(--ok)'];
  }
  if (s === 'open') return ['st-queued', t('common.open'), false, 'var(--info)'];
  if (s === 'completed' || s === 'done') return ['st-queued', t('common.done'), false, 'var(--info)'];
  if (s === 'sealed') return ['st-queued', t('common.sealed'), false, 'var(--info)'];
  if (s === 'archived') return ['st-queued', t('common.archived'), false, 'var(--text-dim)'];
  if (s === 'paused' || s === 'pending' || s === 'cancelled') return ['st-cancel', verdictLabel(s), false, 'var(--warn)'];
  if (s === 'failed' || s === 'blocked' || s === 'error') return ['st-error', t('common.failed'), false, 'var(--danger)'];
  return ['st-unknown', t('common.unknown'), false, 'var(--text-dim)'];
}

function miniTlNode(run) {
  const signal = normalizeRunSignal(run.verdict || run.status);
  const vc = VERDICT_COLOR[signal] || 'var(--text-dim)';
  const running = String(run.status || '').toLowerCase() === 'running';
  const node = el('div', 'tln');
  const d = el('span', `tld${running ? ' pulse' : ''}`);
  d.style.setProperty('--c', vc);
  node.appendChild(d);
  const tlc = el('div', 'tlc');
  const tlh = el('div', 'tlh');
  const runOrder = run.sequence ?? (String(run.run_id || '').slice(0, 8) || '—');
  const cmd = el('span', 'tlh-cmd', `#${runOrder} ${run.command || 'run'}`);
  cmd.title = `${run.run_id || ''} · ${run.verdict || run.status || ''}`;
  tlh.appendChild(cmd);
  const executor = runExecutorLabel(run);
  if (executor) tlh.appendChild(el('span', 'bd bd-dim', executor));
  const v = el('span', `bd ${verdictClass(signal)}`, verdictLabel(signal));
  v.title = run.verdict || run.status || 'unknown';
  tlh.appendChild(v);
  tlh.appendChild(el('span', 'rt', `${fmtClock2(runDisplayTime(run))}${run.duration_secs != null ? ` · ${run.duration_secs}s` : ''}`));
  tlc.appendChild(tlh);
  if (run.handoff_summary) tlc.appendChild(el('div', 'tls', oneLine(run.handoff_summary)));
  node.appendChild(tlc);
  return node;
}

function renderSessions() {
  const all = snapshot.sessions || [];
  const q = listSearch.sessions;
  const sessions = q ? all.filter((s) => matchSession(s, q)) : all;
  $('sessionsCount').textContent = q ? `${sessions.length}/${all.length}` : String(all.length);
  const searching = Boolean(q);
  $('sessionsEmpty').hidden = all.length > 0 && !(searching && !sessions.length);
  // Section 头状态概览 chips：运行/封存/暂停/失败 一眼可见
  let meta = $('headSessions').querySelector('.sh-meta');
  if (meta) meta.remove();
  const statusCounts = { running: 0, sealed: 0, paused: 0, failed: 0 };
  for (const s of all) {
    const st = String(s.status || '').toLowerCase();
    if (sessionActiveRunIds(s).length || ['running', 'active', 'executing'].includes(st)) statusCounts.running++;
    else if (['sealed', 'completed', 'done', 'archived'].includes(st)) statusCounts.sealed++;
    else if (st === 'paused' || st === 'open') statusCounts.paused++;
    else if (['failed', 'blocked', 'error'].includes(st)) statusCounts.failed++;
  }
  const statusChips = [];
  if (statusCounts.running) statusChips.push(['run', t('sessions.runningCount', { count: statusCounts.running })]);
  if (statusCounts.paused) statusChips.push(['', t('sessions.pausedCount', { count: statusCounts.paused })]);
  if (statusCounts.failed) statusChips.push(['fail', t('sessions.failedCount', { count: statusCounts.failed })]);
  if (statusChips.length) {
    meta = el('span', 'sh-meta');
    for (const [cls, text] of statusChips) {
      const hm = el('span', `hm${cls ? ' ' + cls : ''}`);
      if (cls === 'run') {
        const dot = el('i', 'hm-dot');
        dot.style.setProperty('--c', 'var(--ok)');
        hm.appendChild(dot);
      }
      hm.appendChild(document.createTextNode(text));
      meta.appendChild(hm);
    }
    $('headSessions').insertBefore(meta, $('sessionsCount'));
  }
  const list = $('sessionsList');
  list.innerHTML = '';
  if (!all.length) {
    const empty = $('sessionsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-session', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', t('sections.noSessions')));
    empty.appendChild(el('div', 'empty-hint', t('sessions.emptyHint')));
  } else if (searching && !sessions.length) {
    const empty = $('sessionsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-search', 18));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', t('search.noMatchingSessions')));
    empty.appendChild(el('div', 'empty-hint', t('search.sessionsHint')));
  }
  const active = findActiveSession(snapshot);
  const orderedSessions = sessions.slice().sort((a, b) => Number(b === active) - Number(a === active));
  const visibleSessions = searching || sessionsListExpanded ? orderedSessions : orderedSessions.slice(0, SESSIONS_LIMIT);

  for (const s of visibleSessions) {
    list.appendChild(sessionRowEl(s, s === active));
  }
  const foot = $('sessionsFoot');
  foot.innerHTML = '';
  if (sessions.length > SESSIONS_LIMIT && !searching) {
    foot.hidden = false;
    const expand = el('button', 'expand-btn', sessionsListExpanded ? t('calls.collapse') : t('sessions.expandAll', { count: sessions.length }));
    expand.type = 'button';
    expand.setAttribute('aria-expanded', String(sessionsListExpanded));
    expand.addEventListener('click', () => {
      sessionsListExpanded = !sessionsListExpanded;
      renderSessions();
      const newBtn = $('sessionsFoot').querySelector('.expand-btn');
      if (newBtn) newBtn.focus();
      fitWindow();
      scheduleFade();
    });
    foot.appendChild(expand);
  } else {
    foot.hidden = true;
  }
}

/** 单条会话行（含可展开 Run 时间线；列表与「全部会话」详情视图共用） */
function sessionRowEl(s, isActive) {
  const cacheKey = sessionObjectKey(s);
  const expanded = expandedSessions.has(cacheKey);
  const loadState = sessionLoadState[cacheKey] || 'collapsed';
  const sm = sessionStatusMeta(s.status, sessionActiveRunIds(s).length);
  const lr = s.latest_run || null;
  const timelineId = `session-runs-${safeDomId(cacheKey)}`;
  const item = el('article', `srow${expanded ? ' open' : ''}${isActive ? ' active' : ''}`);

  const toggle = el('button', 'sess-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-controls', timelineId);
  if (isActive) toggle.setAttribute('aria-current', 'true');

  const rl = el('div', 'rl');
  const dot = el('span', `dot${sm[2] ? ' pulse' : ''}`);
  dot.style.setProperty('--c', sm[3]);
  rl.appendChild(dot);
  rl.appendChild(el('span', 'sid', s.session_id));
  // 多工程合并：行内标注工程归属
  if (s.project && s.project !== snapshot.workspace) {
    const proj = el('span', 'bd bd-dim', s.project);
    proj.title = t('sessions.project', { name: s.project });
    rl.appendChild(proj);
  }
  if (isActive) rl.appendChild(el('span', 'bd bd-accent', 'ACTIVE'));
  rl.appendChild(el('span', 'rl-spacer'));
  rl.appendChild(el('span', `bd ${sm[0]}`, sm[1]));
  toggle.appendChild(rl);
  const sl2 = el('div', 'sl2');
  sl2.appendChild(el('span', 'si', oneLine(s.intent) || t('sessions.noIntent')));
  toggle.appendChild(sl2);
  const sl3 = el('div', 'sl3');
  const slat = el('span', 'slat');
  if (lr) {
    const signal = normalizeRunSignal(lr.verdict || lr.status);
    const vc = VERDICT_COLOR[signal] || 'var(--text-dim)';
    slat.append(t('sessions.step', { current: lr.sequence ?? '—', total: s.run_count || '—' }) + ` · ${lr.command || 'run'} · `);
    const v = el('span', 'slat-v', verdictLabel(lr.verdict || lr.status));
    v.style.color = vc;
    v.title = `${lr.run_id || ''} · ${lr.verdict || lr.status || ''}`;
    slat.appendChild(v);
    slat.append(` · ${fmtAgo(runDisplayTime(lr))}${lr.duration_secs != null ? ` · ${lr.duration_secs}s` : ''}`);
  } else {
    slat.textContent = t('sessions.noRunData', { count: s.run_count || 0 });
  }
  sl3.appendChild(slat);
  const chev = el('span', 'schev');
  chev.appendChild(svg('i-chevron', 10));
  sl3.appendChild(chev);
  toggle.appendChild(sl3);
  toggle.addEventListener('click', () => toggleSessionExpand(s));
  item.appendChild(toggle);

  const sexpb = el('div', 'sexpb');
  const sbi = el('div', 'sbi');
  const sexp = el('div', 'sexp');
  const tl = el('div', 'mini-tl');
  tl.id = timelineId;
  tl.setAttribute('role', 'region');
  tl.setAttribute('aria-label', t('sessions.timelineAria', { id: s.session_id }));
  tl.setAttribute('aria-busy', String(loadState === 'loading'));
  const MINI_TL_CAP = 8;
  const cached = sessionRunCache[cacheKey];
  const runs = expanded && cached?.length ? cached.slice(-MINI_TL_CAP) : (lr ? [lr] : []);
  for (const run of runs) tl.appendChild(miniTlNode(run));
  if (expanded && cached && cached.length > MINI_TL_CAP) {
    tl.appendChild(el('div', 'timeline-limit', t('sessions.recentRuns', { shown: MINI_TL_CAP, total: cached.length })));
  }
  if (loadState === 'loading') tl.appendChild(el('div', 'run-inline-status', t('sessions.loadingRuns')));
  if (loadState === 'error') tl.appendChild(el('div', 'run-inline-error', t('sessions.loadRunsFailed')));
  sexp.appendChild(tl);
  const sexpf = el('div', 'sexp-f');
  const engine = s.orchestration?.engine;
  if (engine) sexpf.appendChild(el('span', 'bd bd-dim', `engine · ${engine}`));
  if (loadState === 'error') {
    const retry = el('button', 'more', t('common.retry'));
    retry.type = 'button';
    retry.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSessionExpand(s, true);
    });
    sexpf.appendChild(retry);
  }
  const more = el('button', 'more', t('sessions.viewDetails'));
  more.type = 'button';
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    openDetail('session', s.session_id, more, false, s.project_path);
  });
  sexpf.appendChild(more);
  sexp.appendChild(sexpf);
  sbi.appendChild(sexp);
  sexpb.appendChild(sbi);
  item.appendChild(sexpb);
  return item;
}

async function toggleSessionExpand(session, force = false) {
  const sessionId = session.session_id;
  const projectPath = session.project_path || null;
  const cacheKey = sessionObjectKey(session);
  if (!force && expandedSessions.has(cacheKey)) {
    sessionRunGeneration[cacheKey] = (sessionRunGeneration[cacheKey] || 0) + 1;
    expandedSessions.delete(cacheKey);
    sessionLoadState[cacheKey] = 'collapsed';
    renderSessions();
    fitWindow();
    return;
  }
  if (!force && sessionRunCache[cacheKey]?.length) {
    expandedSessions.add(cacheKey);
    sessionLoadState[cacheKey] = 'expanded';
    renderSessions();
    fitWindow();
    refocusSessionToggle(cacheKey);
    return;
  }
  sessionLoadState[cacheKey] = 'loading';
  expandedSessions.add(cacheKey);
  const generation = (sessionRunGeneration[cacheKey] || 0) + 1;
  sessionRunGeneration[cacheKey] = generation;
  renderSessions();
  try {
    const runs = await invoke('get_session_runs', { sessionId, projectPath });
    if (sessionRunGeneration[cacheKey] !== generation || !expandedSessions.has(cacheKey)) return;
    sessionRunCache[cacheKey] = Array.isArray(runs) ? runs : [];
    sessionLoadState[cacheKey] = 'expanded';
  } catch {
    if (sessionRunGeneration[cacheKey] !== generation || !expandedSessions.has(cacheKey)) return;
    // 失败保留展开状态 + 行内错误（含重试），不静默折叠
    sessionLoadState[cacheKey] = 'error';
  }
  renderSessions();
  fitWindow();
  refocusSessionToggle(cacheKey);
}

function refocusSessionToggle(cacheKey) {
  requestAnimationFrame(() => {
    const tl = document.getElementById(`session-runs-${safeDomId(cacheKey)}`);
    const toggle = tl && tl.closest('.srow')?.querySelector('.sess-toggle');
    if (toggle && toggle.isConnected) toggle.focus();
  });
}

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (s === 'running' || s === 'active' || s === 'executing') return 'sb-running';
  if (s === 'sealed' || s === 'completed' || s === 'done' || s === 'archived') return 'sb-sealed';
  if (s === 'open' || s === 'paused' || s === 'pending' || s === 'cancelled') return 'sb-paused';
  if (s === 'failed' || s === 'blocked' || s === 'error') return 'sb-failed';
  return 'sb-unknown';
}
function verdictClass(v) {
  const s = normalizeRunSignal(v);
  if (!s) return 'default';
  if (s === 'ready' || s === 'done' || s === 'completed' || s === 'sealed') return 'v-ready';
  if (s === 'blocked' || s === 'failed') return 'v-blocked';
  if (s === 'pending' || s === 'cancelled' || s === 'needs_retry' || s === 'done_with_concerns' || s === 'ready_with_concerns') return 'v-retry';
  return 'default';
}

// ---------------------------------------------------------------------------
// 知识积累（五类占比）
// ---------------------------------------------------------------------------

const KNOWLEDGE_ITEMS = [
  ['specs', 'knowledge.specs', 'var(--accent)'],
  ['memory', 'knowledge.memory', 'var(--info)'],
  ['knowhow', 'knowledge.knowhow', 'var(--ok)'],
  ['learning', 'knowledge.learning', 'var(--cyan, #22d3ee)'],
  ['issues', 'knowledge.issues', 'var(--danger)'],
];

function knowledgeValue(stats, key) {
  if (key === 'learning') return stats.learning ?? stats.learning_rows ?? 0;
  if (key === 'issues') return stats.issues ?? stats.issue_rows ?? 0;
  return stats[key] || 0;
}

function renderKnowledge() {
  const k = snapshot.knowledge || {};
  const total = k.total || 0;
  const body = $('kbBody');
  const q = listSearch.knowledge;
  // 搜索模式：内联展示匹配条目（最多 8 条），异步拉取条目列表
  if (q) {
    $('knowledgeTotal').textContent = `…/${total}`;
    body.innerHTML = '';
    const searching = el('div', 'kb-searching', t('search.searchingFor', { query: q }));
    body.appendChild(searching);
    getKbItems().then((items) => {
      if (listSearch.knowledge !== q) return; // 关键词已变化，丢弃过期结果
      body.innerHTML = '';
      body.appendChild(searching);
      const matched = items.filter((it) => matchKbItem(it, q));
      if (!matched.length) {
        const empty = el('div', 'empty');
        const ic = el('div', 'empty-ic');
        ic.appendChild(svg('i-search', 18));
        empty.appendChild(ic);
        empty.appendChild(el('div', '', t('search.noMatchingKnowledge')));
        empty.appendChild(el('div', 'empty-hint', t('search.knowledgeHint')));
        body.appendChild(empty);
        return;
      }
      for (const item of matched.slice(0, 8)) body.appendChild(kbEntryEl(item, q));
      const foot = el('div', 'kb-foot');
      const more = el('button', 'expand-btn', t('knowledge.moreResults', { count: matched.length }));
      more.type = 'button';
      more.addEventListener('click', () => openDetail('knowledge', 'all', more));
      foot.appendChild(more);
      body.appendChild(foot);
      fitWindow();
      scheduleFade();
    });
    return;
  }
  $('knowledgeTotal').textContent = String(total);
  body.innerHTML = '';
  if (!total) {
    const empty = el('div', 'empty');
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-book', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', t('knowledge.empty')));
    empty.appendChild(el('div', 'empty-hint', t('knowledge.emptyHint')));
    body.appendChild(empty);
    return;
  }
  const kpis = el('div', 'kpis');
  const stack = el('div', 'stack');
  const legend = el('div', 'legend');
  for (const [key, labelKey, color] of KNOWLEDGE_ITEMS) {
    const label = t(labelKey);
    const value = knowledgeValue(k, key);
    const kpi = el('button', 'kpi');
    kpi.type = 'button';
    kpi.style.setProperty('--c', color);
    kpi.title = t('knowledge.kpiTitle', { kind: key, count: value });
    kpi.setAttribute('aria-label', t('knowledge.kpiAria', { label }));
    kpi.appendChild(el('b', '', String(value)));
    kpi.appendChild(el('span', '', label));
    kpi.addEventListener('click', () => openDetail('knowledge', 'all', kpi));
    kpis.appendChild(kpi);
    const pct = total ? (value / total) * 100 : 0;
    const seg = document.createElement('i');
    seg.className = 'seg';
    seg.style.setProperty('--c', color);
    seg.style.width = `${pct.toFixed(1)}%`;
    stack.appendChild(seg);
    if (Math.round(pct)) {
      const li = el('span', 'lg-i');
      const ldot = document.createElement('i');
      ldot.className = 'lg-dot';
      ldot.style.setProperty('--c', color);
      li.appendChild(ldot);
      li.appendChild(document.createTextNode(`${label} ${Math.round(pct)}%`));
      legend.appendChild(li);
    }
  }
  body.appendChild(kpis);
  body.appendChild(stack);
  body.appendChild(legend);
  const foot = el('div', 'kb-foot');
  // 待沉淀候选入口（A1）：KDC 候选 > 0 时置顶显示
  const pc = snapshot.pending_candidates;
  if (pc && pc.total > 0) {
    const pend = el('button', 'expand-btn pend-btn');
    pend.type = 'button';
    pend.title = t('knowledge.pendingTitle');
    pend.appendChild(el('span', 'pend-dot'));
    pend.appendChild(document.createTextNode(t('knowledge.pendingCount', { count: pc.total })));
    pend.addEventListener('click', () => openDetail('pending', 'all', pend));
    foot.appendChild(pend);
  }
  const all = el('button', 'expand-btn', t('knowledge.viewAll'));
  all.type = 'button';
  all.addEventListener('click', () => openDetail('knowledge', 'all', all));
  foot.appendChild(all);
  const create = el('button', 'expand-btn', t('knowledge.create'));
  create.type = 'button';
  create.addEventListener('click', createKnowledgeItem);
  foot.appendChild(create);
  body.appendChild(foot);
}

function knowledgeStatusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  const keys = {
    open: 'knowledge.status.open', blocked: 'knowledge.status.blocked',
    registered: 'knowledge.status.registered', draft: 'knowledge.status.draft',
    in_progress: 'knowledge.status.inProgress', completed: 'knowledge.status.completed',
    closed: 'knowledge.status.closed',
  };
  return keys[normalized] ? t(keys[normalized]) : (status || t('common.unknown'));
}

/** 知识条目行（知识详情分组 / 区块搜索共用；点击复制 ID） */
function kbEntryEl(item, q) {
  const ke = el('button', 'ke');
  ke.type = 'button';
  ke.title = `${item.id} · ${knowledgeStatusLabel(item.status)}`;
  ke.setAttribute('aria-label', `${t('common.copy')} ${item.id}`);
  const kh = el('div', 'ke-h');
  kh.appendChild(el('span', 'ke-id', item.id || ''));
  const titleNode = el('span', 'ke-t');
  titleNode.appendChild(highlightText(item.title || t('knowledge.unnamed'), q));
  kh.appendChild(titleNode);
  ke.appendChild(kh);
  if (item.summary) {
    const s = el('div', 'ke-s');
    s.appendChild(highlightText(oneLine(item.summary), q));
    ke.appendChild(s);
  }
  const kf = el('div', 'ke-f');
  for (const tag of (item.tags || []).slice(0, 4)) {
    kf.appendChild(el('span', 'tag', String(tag)));
  }
  if (item.status) kf.appendChild(el('span', `bd ${kbStatusClass(item.status)}`, knowledgeStatusLabel(item.status)));
  if (item.updated) kf.appendChild(el('span', 'rt', t('knowledge.updated', { time: fmtAgo(item.updated) })));
  ke.appendChild(kf);
  ke.addEventListener('click', () => openEditor(item.kind, item.id));
  return ke;
}

// 知识条目状态徽章（参考 ref/sidebar.html：open→danger / draft→warn / 其余→ok）
function kbStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'open' || s === 'failed' || s === 'blocked') return 'st-error';
  if (s === 'draft' || s === 'pending' || s === 'paused' || s === 'optional') return 'st-cancel';
  if (s === 'completed' || s === 'active' || s === 'required' || s === 'sealed' || s === 'done') return 'st-done';
  return 'st-unknown';
}
const KB_KIND_ORDER = [
  ['specs', 'knowledge.specs'], ['memory', 'knowledge.memory'], ['knowhow', 'knowledge.knowhow'],
  ['learning', 'knowledge.learning'], ['issues', 'knowledge.issues'],
];
// issues 状态子分组（真实数据含 open/completed/registered；未知状态归「其他」）
const ISSUE_STATUS_ORDER = [
  ['open', 'knowledge.status.open'], ['blocked', 'knowledge.status.blocked'], ['registered', 'knowledge.status.registered'],
  ['draft', 'knowledge.status.draft'], ['in_progress', 'knowledge.status.inProgress'], ['completed', 'knowledge.status.completed'], ['closed', 'knowledge.status.closed'],
];

function renderKnowledgeDetail() {
  if (!renderDetailState(t('knowledge.title'))) return;
  if (semanticMode) {
    renderSemanticDetail();
    return;
  }
  const body = $('detailBody');
  const items = Array.isArray(detail.items) ? detail.items : [];
  const q = detailSearch;
  const matched = q ? items.filter((it) => matchKbItem(it, q)) : items;
  $('detailTitle').textContent = t('knowledge.title');
  $('detailKind').textContent = 'KNOWLEDGE';
  setSearchCount(matched.length, items.length);
  const sub = el('div', 'kb-sub');
  sub.textContent = t('knowledge.subtitle');
  body.appendChild(sub);
  if (!items.length) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.noItems')));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult(t('search.noMatchingKnowledge')));
    return;
  }
  const colorOf = (key) => {
    const found = KNOWLEDGE_ITEMS.find(([k]) => k === key);
    return found ? found[2] : 'var(--text-dim)';
  };
  for (const [kind, labelKey] of KB_KIND_ORDER) {
    const label = t(labelKey);
    const group = matched.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const head = el('div', 'kg-h');
    const dot = el('i', 'lg-dot');
    dot.style.setProperty('--c', colorOf(kind));
    head.appendChild(dot);
    head.appendChild(el('span', '', label));
    head.appendChild(el('span', 'pill', String(group.length)));
    body.appendChild(head);
    if (kind === 'issues') {
      // D5：按状态子分组（open → blocked → registered → … → 其他）
      const buckets = new Map();
      for (const item of group) {
        const st = String(item.status || 'open').toLowerCase();
        if (!buckets.has(st)) buckets.set(st, []);
        buckets.get(st).push(item);
      }
      for (const [st, stLabelKey] of ISSUE_STATUS_ORDER) {
        const stLabel = t(stLabelKey);
        const items = buckets.get(st);
        if (!items) continue;
        buckets.delete(st);
        body.appendChild(el('div', 'issue-sub', `${stLabel} · ${items.length}`));
        for (const item of items) body.appendChild(kbEntryEl(item, q));
      }
      if (buckets.size) {
        const rest = [...buckets.values()].reduce((n, a) => n + a.length, 0);
        body.appendChild(el('div', 'issue-sub', `${t('common.other')} · ${rest}`));
        for (const items of buckets.values()) {
          for (const item of items) body.appendChild(kbEntryEl(item, q));
        }
      }
    } else {
      for (const item of group) body.appendChild(kbEntryEl(item, q));
    }
  }
}

/** 知识条目详情：meta 卡 + 全文（点击列表条目进入） */
function renderKnowledgeItemDetail() {
  if (!renderDetailState(t('knowledge.item'))) return;
  const body = $('detailBody');
  const item = (detail && detail.item) || {};
  $('detailTitle').textContent = item.title || item.id || t('knowledge.item');
  $('detailKind').textContent = String(item.kind || '').toUpperCase();
  const meta = el('section', 'detail-card');
  meta.appendChild(el('h2', 'd-sec-title', t('knowledge.itemInfo')));
  meta.appendChild(detailRow('ID', item.id));
  meta.appendChild(detailRow(t('knowledge.type'), item.kind));
  meta.appendChild(detailRow(t('knowledge.state'), item.status ? knowledgeStatusLabel(item.status) : '—'));
  if (item.priority) meta.appendChild(detailRow(t('knowledge.priority'), item.priority));
  if (item.updated) meta.appendChild(detailRow(t('knowledge.updatedLabel'), fmtFull(item.updated)));
  if (Array.isArray(item.tags) && item.tags.length) meta.appendChild(detailRow(t('knowledge.tags'), item.tags.join(' / ')));
  const copyBtn = el('button', 'retry-btn', t('knowledge.copyId'));
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.id || '');
      $('liveStatus').textContent = t('status.copied', { value: item.id });
    } catch { /* 剪贴板不可用 */ }
  });
  meta.appendChild(copyBtn);
  // markdown 类条目：详情页内渲染预览 modal（md.js 共享渲染器）
  if (['specs', 'memory', 'knowhow'].includes(item.kind)) {
    const pv = el('button', 'retry-btn primary', t('knowledge.previewMarkdown'));
    pv.type = 'button';
    pv.title = t('knowledge.previewMarkdownTitle');
    pv.addEventListener('click', () => openMdPreview(String(item.content || ''), item.title || item.id));
    meta.appendChild(pv);
  }
  body.appendChild(meta);
  const content = String(item.content || '');
  const q = detailSearch;
  const lines = content.split('\n');
  const matchedLines = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  setSearchCount(matchedLines.length, lines.length);
  if (!content) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.noBody')));
    return;
  }
  if (q && !matchedLines.length) {
    body.appendChild(emptySearchResult(t('search.noMatch')));
    return;
  }
  const card = el('section', 'detail-card full-width');
  card.appendChild(el('h2', 'd-sec-title', q ? t('knowledge.fullTextMatches', { count: matchedLines.length }) : t('knowledge.fullText')));
  const pre = el('pre', 'd-prompt');
  if (q) {
    for (const line of matchedLines) {
      const div = el('div', 'd-prompt-line');
      div.appendChild(highlightText(line, q));
      pre.appendChild(div);
    }
  } else {
    pre.textContent = content;
  }
  card.appendChild(pre);
  body.appendChild(card);
}
/** 语义搜索详情（maestro search 桥接）：wiki + 代码图谱 */
async function runSemanticSearch(q) {
  const reqId = ++semanticReqId;
  semanticResults = null; // loading
  renderKnowledgeDetail();
  if (!q) return;
  try {
    const out = await invoke('semantic_search', { query: q, limit: 10 });
    if (reqId !== semanticReqId) return;
    semanticResults = out || { results: [], error: t('search.noData') };
  } catch (err) {
    if (reqId !== semanticReqId) return;
    semanticResults = { results: [], error: String(err && err.message ? err.message : err) };
  }
  renderKnowledgeDetail();
}

function semanticRowEl(r, q) {
  const row = el('article', 'sem-row');
  const head = el('div', 'sem-head');
  head.appendChild(el('span', `bd ${r.source === 'code' ? 'st-done' : 'st-queued'}`, r.source === 'code' ? t('knowledge.code') : t('knowledge.knowledge')));
  if (r.kind) head.appendChild(el('span', 'sem-kind', r.kind));
  const name = el('span', 'sem-name');
  name.appendChild(highlightText(r.name || r.detail || t('knowledge.unnamed'), q));
  name.title = r.name || '';
  head.appendChild(name);
  row.appendChild(head);
  if (r.snippet) {
    const sn = el('div', 'sem-snippet');
    sn.appendChild(highlightText(oneLine(r.snippet), q));
    row.appendChild(sn);
  }
  if (r.summary) {
    const su = el('div', 'sem-summary');
    su.appendChild(highlightText(oneLine(r.summary).slice(0, 240), q));
    row.appendChild(su);
  }
  const foot = el('div', 'sem-foot');
  if (r.detail) foot.appendChild(el('span', 'sem-detail', r.detail));
  if (r.score != null) foot.appendChild(el('span', 'rt', t('knowledge.score', { score: (r.score * 100).toFixed(0) })));
  row.appendChild(foot);
  if (r.detail) {
    row.appendChild(copyButton(r.detail, t('knowledge.copyReference'), t('knowledge.copiedReference')));
  }
  return row;
}

function renderSemanticDetail() {
  const body = $('detailBody');
  $('detailTitle').textContent = t('knowledge.semanticTitle');
  $('detailKind').textContent = 'SEARCH';
  const sub = el('div', 'kb-sub');
  sub.textContent = t('knowledge.semanticSubtitle');
  body.appendChild(sub);
  const q = detailSearch;
  if (!q) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.semanticStart')));
    return;
  }
  if (!semanticResults) {
    body.appendChild(el('div', 'loading-state'));
    body.appendChild(el('div', 'loading-line'));
    body.appendChild(el('div', 'loading-line short'));
    body.appendChild(el('div', 'loading-line'));
    return;
  }
  if (semanticResults.error) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.semanticUnavailable', { error: semanticResults.error })));
    const back = el('button', 'retry-btn', t('knowledge.localSearch'));
    back.type = 'button';
    back.addEventListener('click', () => { semanticMode = false; semanticResults = null; onDetailSearchInput(); });
    body.appendChild(back);
    return;
  }
  const results = Array.isArray(semanticResults.results) ? semanticResults.results : [];
  $('detailSearchCount').textContent = t('knowledge.resultsCount', { count: results.length });
  $('detailSearchCount').hidden = false;
  if (!results.length) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.noRelated')));
    return;
  }
  const rows = el('div', 'rows');
  for (const r of results) rows.appendChild(semanticRowEl(r, q));
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', t('knowledge.semanticHint')));
}

// ---------------------------------------------------------------------------
// 详情视图
// ---------------------------------------------------------------------------

async function openDetail(kind, id, trigger = null, fromStack = false, projectPath = null) {
  teardownCallDetailSearch();
  const requestId = ++detailRequestId;
  const key = kind === 'session'
    ? `${kind}::${sessionLocatorKey(id, projectPath || '')}`
    : `${kind}::${id}`;
  if (trigger) detailReturnFocus = trigger;
  if (!fromStack) viewStack.push({ kind, id, projectPath });
  // 重置详情搜索
  detailSearch = '';
  semanticReqId += 1;
  semanticResults = null;
  const dInput = $('detailSearch');
  if (dInput.value) dInput.value = '';
  $('detailSearchClear').hidden = true;
  // 快照直供视图（全部调用 / 全部会话 / 待处置候选）：无需后端拉取
  if (kind === 'calls' || kind === 'sessions' || kind === 'pending') {
    view = { kind, id, projectPath };
    detail = { ok: true };
    detailStatus = 'ready';
    render();
    $('content').scrollTop = 0;
    requestAnimationFrame(() => $('detailTitle').focus());
    return;
  }
  // 已缓存 → 直接展示（返回栈回退秒开）
  if (detailCache[key]) {
    view = { kind, id, projectPath };
    detail = detailCache[key];
    detailStatus = 'ready';
    render();
    $('content').scrollTop = 0;
    requestAnimationFrame(() => $('detailTitle').focus());
    return;
  }
  view = { kind, id, projectPath };
  detail = null;
  detailStatus = 'loading';
  render();
  // 详情从顶部开始（.content 是唯一滚动容器）
  $('content').scrollTop = 0;
  requestAnimationFrame(() => $('detailTitle').focus());
  try {
    let result;
    if (kind === 'call') {
      result = await invoke('get_call_detail', { execId: id });
    } else if (kind === 'knowledge') {
      result = await getKbItems();
    } else if (kind === 'knowledge-item') {
      const sep = id.indexOf('::');
      const k = sep > 0 ? id.slice(0, sep) : '';
      const iid = sep > 0 ? id.slice(sep + 2) : id;
      result = await invoke('get_knowledge_item_content', { kind: k, id: iid });
    } else {
      result = await invoke('get_session_detail', { sessionId: id, projectPath });
    }
    if (requestId !== detailRequestId
      || view?.kind !== kind
      || view?.id !== id
      || (view?.projectPath || null) !== (projectPath || null)) return;
    if (!result) {
      detailStatus = 'not-found';
      detail = null;
    } else {
      detailStatus = 'ready';
      detail = kind === 'knowledge' ? { items: result } : kind === 'knowledge-item' ? { item: result } : result;
      detailCache[key] = detail;
    }
  } catch (err) {
    if (requestId !== detailRequestId) return;
    detailStatus = 'error';
    detail = { error: String(err && err.message ? err.message : err) };
  }
  render();
  requestAnimationFrame(() => $('detailTitle').focus());
}

function closeDetail() {
  teardownCallDetailSearch();
  detailRequestId += 1;
  viewStack.pop();
  // 返回栈回退：回到上一详情（知识列表等），而不是直接跳回主列表
  const prev = viewStack[viewStack.length - 1] || null;
  if (prev) {
    openDetail(prev.kind, prev.id, null, true, prev.projectPath || null);
    return;
  }
  view = null;
  detail = null;
  detailStatus = 'idle';
  render();
  // 回到列表后窗口高度重新自适应内容
  fitWindow();
  requestAnimationFrame(() => {
    if (detailReturnFocus?.isConnected) detailReturnFocus.focus();
    detailReturnFocus = null;
  });
}

function renderDetailState(kindLabel) {
  $('detailKind').textContent = kindLabel;
  const body = $('detailBody');
  body.className = 'detail-body';
  body.innerHTML = '';
  body.setAttribute('aria-busy', String(detailStatus === 'loading'));
  if (detailStatus === 'loading') {
    $('detailTitle').textContent = t('detail.loading');
    const loading = el('div', 'loading-state');
    loading.appendChild(el('div', 'loading-line'));
    loading.appendChild(el('div', 'loading-line short'));
    loading.appendChild(el('div', 'loading-line'));
    body.appendChild(loading);
    return false;
  }
  if (detailStatus === 'not-found') {
    $('detailTitle').textContent = view?.kind === 'session'
      ? t('detail.sessionUnavailable')
      : view?.kind === 'knowledge-item' ? t('detail.knowledgeUnavailable') : t('detail.callUnavailable');
    const missing = el('section', 'missing-state');
    missing.appendChild(svg('i-alert', 20));
    missing.appendChild(el('h2', 'missing-title', t('detail.notFound')));
    missing.appendChild(el('p', 'missing-copy', t('detail.notFoundDescription')));
    missing.appendChild(el('code', 'missing-id', view?.id || 'unknown'));
    const actions = el('div', 'missing-actions');
    const back = el('button', 'retry-btn', t('detail.back'));
    back.type = 'button';
    back.addEventListener('click', closeDetail);
    const retry = el('button', 'retry-btn primary', t('detail.reload'));
    retry.type = 'button';
    retry.addEventListener('click', () => openDetail(
      view.kind, view.id, null, true, view.projectPath || null,
    ));
    actions.appendChild(back);
    actions.appendChild(retry);
    missing.appendChild(actions);
    body.appendChild(missing);
    return false;
  }
  if (detailStatus === 'error') {
    $('detailTitle').textContent = t('detail.loadFailed');
    const error = el('section', 'missing-state error');
    error.appendChild(svg('i-alert', 20));
    error.appendChild(el('h2', 'missing-title', t('detail.loadFailedTitle')));
    error.appendChild(el('p', 'missing-copy', detail?.error || t('detail.loadFailedDescription')));
    const actions = el('div', 'missing-actions');
    const back = el('button', 'retry-btn', t('detail.back'));
    back.type = 'button';
    back.addEventListener('click', closeDetail);
    const retry = el('button', 'retry-btn primary', t('common.retry'));
    retry.type = 'button';
    retry.addEventListener('click', () => openDetail(
      view.kind, view.id, null, true, view.projectPath || null,
    ));
    actions.appendChild(back);
    actions.appendChild(retry);
    error.appendChild(actions);
    body.appendChild(error);
    return false;
  }
  return true;
}

function detailRow(label, value) {
  const row = el('div', 'd-row');
  row.appendChild(el('span', 'd-label', label));
  row.appendChild(el('span', 'd-value', value || '—'));
  return row;
}

function normalizeCallEntries(rawEntries, running) {
  const allowed = new Set([
    'user_message', 'assistant_message', 'thinking', 'tool_use', 'tool_result',
    'system_message', 'error', 'status_change',
  ]);
  const entries = [];
  for (const [sourceIndex, raw] of (Array.isArray(rawEntries) ? rawEntries : []).entries()) {
    if (!raw || !allowed.has(raw.type)) continue;
    const fallbackKey = [raw.type || 'entry', raw.timestamp || 'no-time', sourceIndex].join(':');
    const entry = {
      ...raw,
      _sourceIndex: sourceIndex,
      _uiKey: raw.id ? String(raw.id) : fallbackKey,
    };
    if (entry.type === 'assistant_message') {
      entry.partial = running && Boolean(entry.partial);
      const previous = entries[entries.length - 1];
      if (previous?.type === 'assistant_message') {
        previous.content = String(previous.content || '') + String(entry.content || '');
        previous.partial = entry.partial;
        previous.timestamp = entry.timestamp || previous.timestamp;
        continue;
      }
    }
    if (entry.type === 'tool_use' && ['completed', 'failed'].includes(entry.status)) {
      const pending = entries.findLastIndex((item) => (
        item.type === 'tool_use'
        && item.status === 'running'
        && (!entry.name || item.name === entry.name)
      ));
      if (pending >= 0) {
        const pendingEntry = entries[pending];
        entries[pending] = {
          ...pendingEntry,
          ...entry,
          _sourceIndex: pendingEntry._sourceIndex,
          _uiKey: pendingEntry._uiKey,
        };
        continue;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function callEntryText(entry) {
  if (entry.type === 'tool_use') {
    const head = [entry.name || t('calls.tool'), entry.status].filter(Boolean).join(' · ');
    return [head, entry.result].filter(Boolean).join('\n');
  }
  if (entry.type === 'error') return entry.message || entry.content || t('calls.callFailed');
  if (entry.type === 'status_change') return [entry.status, entry.reason].filter(Boolean).join(' · ');
  return entry.content || entry.message || entry.result || '';
}

const AUXILIARY_CALL_ENTRY_TYPES = new Set([
  'thinking', 'tool_use', 'tool_result', 'system_message', 'status_change',
]);

function callEntryKey(entry, index) {
  if (entry._uiKey) return String(entry._uiKey);
  if (entry.id) return String(entry.id);
  return [entry.type || 'entry', entry.timestamp || 'no-time', entry._sourceIndex ?? index].join(':');
}

function callEntryKind(entry) {
  if (entry.type === 'user_message') return 'user';
  if (entry.type === 'assistant_message') return 'assistant';
  if (entry.type === 'error') return 'error';
  if (entry.type === 'thinking') return 'thinking';
  if (entry.type === 'status_change') return 'status';
  return 'tool';
}

function callEntryRole(entry) {
  const keys = {
    user_message: 'calls.roles.user',
    assistant_message: 'calls.roles.assistant',
    thinking: 'calls.roles.thinking',
    tool_use: 'calls.roles.tool',
    tool_result: 'calls.roles.toolResult',
    system_message: 'calls.roles.system',
    status_change: 'calls.roles.status',
    error: 'calls.roles.error',
  };
  return keys[entry.type] ? t(keys[entry.type]) : (entry.type || t('calls.roles.message'));
}

function getCallDetailUi(call) {
  const id = String(call.execId || view?.id || 'unknown');
  let state = callDetailUiState.get(id);
  if (!state) {
    const running = callStatus(call) === 'running';
    state = {
      initialized: false,
      followLive: running,
      scrollTop: 0,
      bottomDistance: 0,
      newActivityCount: 0,
      metaExpanded: callStatus(call) === 'error',
      metaTouched: false,
      promptExpanded: false,
      auxiliaryExpanded: new Set(),
      longExpanded: new Set(),
      lastSignature: '',
      lastEntryCount: 0,
      lastStatus: callStatus(call),
      followBeforeSearch: null,
      scrollBeforeSearch: null,
      skipNextCapture: false,
    };
    callDetailUiState.set(id, state);
  }
  const status = callStatus(call);
  if (status === 'error' && state.lastStatus !== 'error' && !state.metaTouched) {
    state.metaExpanded = true;
  }
  state.lastStatus = status;
  return state;
}

function captureCallDetailViewport(callId) {
  const scroll = $('detailBody')?.querySelector('.chat-scroll');
  if (!scroll || !callId) return;
  const state = callDetailUiState.get(String(callId));
  if (!state) return;
  const distance = Math.max(0, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
  state.scrollTop = scroll.scrollTop;
  state.bottomDistance = distance;
  state.followLive = distance <= CHAT_FOLLOW_THRESHOLD;
  if (state.followLive) state.newActivityCount = 0;
}

function restoreCallDetailSearchState(callId) {
  if (!callId) return;
  const state = callDetailUiState.get(String(callId));
  if (!state || state.followBeforeSearch === null) return;
  state.followLive = state.followBeforeSearch;
  if (!state.followLive && state.scrollBeforeSearch !== null) state.scrollTop = state.scrollBeforeSearch;
  state.followBeforeSearch = null;
  state.scrollBeforeSearch = null;
  state.skipNextCapture = true;
}

function teardownCallDetailSearch() {
  if (view?.kind !== 'call' || !detailSearch) return;
  const state = callDetailUiState.get(String(view.id));
  if (!state || state.followBeforeSearch === null) return;
  captureCallDetailViewport(view.id);
  restoreCallDetailSearchState(view.id);
}

function iconButton(symbol, label, className = 'chat-icon-btn') {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(svg(symbol, 12));
  return button;
}

async function copyCallText(text, button, successText) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    $('liveStatus').textContent = successText;
    if (!button) return;
    button.classList.add('copied');
    button.replaceChildren(svg('i-check', 12));
    button.title = successText;
    button.setAttribute('aria-label', successText);
    setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('copied');
      button.replaceChildren(svg('i-copy', 12));
      button.title = button.dataset.copyLabel || t('common.copy');
      button.setAttribute('aria-label', button.dataset.copyLabel || t('common.copy'));
    }, 1500);
  } catch {
    $('liveStatus').textContent = t('status.clipboardUnavailable');
  }
}

function copyButton(text, label, successText, focusKey = '') {
  const button = iconButton('i-copy', label, 'chat-icon-btn copy-btn');
  button.dataset.copyLabel = label;
  if (focusKey) button.dataset.focusKey = focusKey;
  button.addEventListener('click', () => copyCallText(text, button, successText));
  return button;
}

function callDisclosure(label, id, expanded, onToggle, action = null) {
  const section = el('section', 'call-disclosure');
  const head = el('div', 'call-disclosure-head');
  const trigger = el('button', 'call-disclosure-trigger');
  trigger.type = 'button';
  trigger.dataset.focusKey = `disclosure:${id}`;
  trigger.title = expanded ? t('detail.collapseLabel', { label }) : t('detail.expandLabel', { label });
  trigger.setAttribute('aria-label', expanded ? t('detail.collapseLabel', { label }) : t('detail.expandLabel', { label }));
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-controls', id);
  trigger.appendChild(svg('i-chevron', 11));
  trigger.appendChild(el('span', '', label));
  trigger.addEventListener('click', onToggle);
  head.appendChild(trigger);
  if (action) head.appendChild(action);
  section.appendChild(head);
  const panel = el('div', 'call-disclosure-panel');
  panel.id = id;
  panel.hidden = !expanded;
  section.appendChild(panel);
  return { section, panel };
}

function renderCallSummary(call, running) {
  const summary = el('section', 'call-live-summary');
  const lead = el('div', 'call-live-lead');
  const dot = el('span', `call-live-dot${running ? ' pulse' : ''}`);
  dot.style.setProperty('--c', running ? 'var(--ok)' : callStatus(call) === 'error' ? 'var(--danger)' : 'var(--info)');
  lead.appendChild(dot);
  lead.appendChild(el('strong', '', running ? 'LIVE' : callStatusLabel(call).toUpperCase()));
  summary.appendChild(lead);
  const facts = el('div', 'call-live-facts');
  for (const value of [call.model || t('calls.defaultModel'), call.mode || 'default', fmtAgo(call.lastActivityMs ? new Date(Number(call.lastActivityMs)).toISOString() : call.startedAt)]) {
    facts.appendChild(el('span', '', value));
  }
  summary.appendChild(facts);
  summary.appendChild(el('span', `bd ${callStatusClass(call)}`, callStatusLabel(call)));
  return summary;
}

function formatCallConversation(entries) {
  return entries.map((entry) => {
    const time = entry.timestamp ? fmtFull(entry.timestamp) : t('calls.noTime');
    return `[${time}] ${callEntryRole(entry)}\n${String(callEntryText(entry))}`;
  }).join('\n\n');
}

function isLongCallMessage(content) {
  return content.length > LONG_MESSAGE_CHARS || content.split('\n').length > LONG_MESSAGE_LINES;
}

function callMessagePreview(content) {
  const linePreview = content.split('\n').slice(0, LONG_MESSAGE_LINES).join('\n');
  const preview = linePreview.slice(0, 760).trimEnd();
  return preview === content ? content : `${preview}…`;
}

function renderAuxiliaryCallEntry(entry, key, state, q) {
  const kind = callEntryKind(entry);
  const content = String(callEntryText(entry));
  const expanded = Boolean(q) || state.auxiliaryExpanded.has(key);
  const item = el('article', `chat-event ${kind}`);
  const head = el('div', 'chat-event-head');
  const trigger = el('button', 'chat-event-trigger');
  const bodyId = `call-entry-${safeDomId(key)}`;
  trigger.type = 'button';
  trigger.dataset.focusKey = `event:${key}`;
  trigger.title = expanded ? t('detail.collapseLabel', { label: callEntryRole(entry) }) : t('detail.expandLabel', { label: callEntryRole(entry) });
  trigger.setAttribute('aria-label', expanded ? t('detail.collapseLabel', { label: callEntryRole(entry) }) : t('detail.expandLabel', { label: callEntryRole(entry) }));
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-controls', bodyId);
  trigger.appendChild(svg('i-chevron', 10));
  trigger.appendChild(el('span', 'chat-event-role', callEntryRole(entry)));
  trigger.appendChild(el('span', 'chat-event-summary', content.split('\n')[0] || t('calls.noContent')));
  if (entry.timestamp) trigger.appendChild(el('time', 'chat-event-time', fmtClock2(entry.timestamp)));
  trigger.addEventListener('click', () => {
    if (state.auxiliaryExpanded.has(key)) state.auxiliaryExpanded.delete(key);
    else state.auxiliaryExpanded.add(key);
    renderWithFocus();
  });
  head.appendChild(trigger);
  head.appendChild(copyButton(content, t('calls.copyRole', { role: callEntryRole(entry) }), t('calls.copiedRole', { role: callEntryRole(entry) }), `copy:${key}`));
  item.appendChild(head);
  const panel = el('div', 'chat-event-panel');
  panel.id = bodyId;
  panel.hidden = !expanded;
  const contentDiv = el('div', 'chat-content');
  contentDiv.appendChild(highlightText(content, q));
  panel.appendChild(contentDiv);
  item.appendChild(panel);
  return item;
}

function renderPrimaryCallEntry(entry, key, state, q) {
  const kind = callEntryKind(entry);
  const content = String(callEntryText(entry));
  const isLong = isLongCallMessage(content);
  const expanded = Boolean(q) || !isLong || state.longExpanded.has(key);
  const bubble = el('article', `chat-bubble ${kind}`);
  const head = el('header', 'chat-message-head');
  const role = el('div', 'chat-role', callEntryRole(entry));
  if (entry.type === 'assistant_message' && entry.partial) role.appendChild(el('span', 'chat-stream-label', t('calls.generating')));
  head.appendChild(role);
  if (entry.timestamp) head.appendChild(el('time', 'chat-time', fmtClock2(entry.timestamp)));
  head.appendChild(copyButton(content, t('calls.copyMessage', { role: callEntryRole(entry) }), t('calls.copiedMessage', { role: callEntryRole(entry) }), `copy:${key}`));
  bubble.appendChild(head);
  const contentId = `call-message-${safeDomId(key)}`;
  const contentDiv = el('div', `chat-content${isLong && !expanded ? ' clipped' : ''}`);
  contentDiv.id = contentId;
  contentDiv.appendChild(highlightText(expanded ? content : callMessagePreview(content), q));
  if (entry.type === 'assistant_message' && entry.partial) contentDiv.appendChild(el('span', 'chat-cursor'));
  bubble.appendChild(contentDiv);
  if (isLong && !q) {
    const more = el('button', 'chat-expand-text', expanded ? t('calls.collapseText') : t('calls.expandFull'));
    more.type = 'button';
    more.dataset.focusKey = `expand:${key}`;
    more.setAttribute('aria-expanded', String(expanded));
    more.setAttribute('aria-controls', contentId);
    const roleMessage = t('calls.roleMessage', { role: callEntryRole(entry) });
    more.setAttribute('aria-label', expanded
      ? t('detail.collapseLabel', { label: roleMessage })
      : t('detail.expandLabel', { label: roleMessage }));
    more.addEventListener('click', () => {
      if (expanded) state.longExpanded.delete(key);
      else state.longExpanded.add(key);
      renderWithFocus();
    });
    bubble.appendChild(more);
  }
  return bubble;
}

function restoreCallDetailViewport(scroll, state, running, q) {
  requestAnimationFrame(() => {
    if (!scroll.isConnected) return;
    if (!state.initialized) {
      scroll.scrollTop = running && !q ? scroll.scrollHeight : 0;
      state.initialized = true;
    } else if (!q && state.followLive) {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      scroll.scrollTop = Math.min(state.scrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    }
    const distance = Math.max(0, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
    state.scrollTop = scroll.scrollTop;
    state.bottomDistance = distance;
    if (!q) state.followLive = distance <= CHAT_FOLLOW_THRESHOLD;
  });
}

function renderCallDetail() {
  const call = detail?.call || {};
  const existingState = callDetailUiState.get(String(call.execId || view?.id || 'unknown'));
  if (existingState?.skipNextCapture) existingState.skipNextCapture = false;
  else captureCallDetailViewport(call.execId || view?.id);
  if (!renderDetailState(t('sections.calls'))) return;
  const body = $('detailBody');
  body.classList.add('call-detail-body');
  const q = detailSearch;
  const running = callStatus(call) === 'running';
  const state = getCallDetailUi(call);
  $('detailTitle').textContent = TOOL_LABEL[call.tool] || call.tool || t('calls.details');

  body.appendChild(renderCallSummary(call, running));

  const contextStack = el('div', 'call-context-stack');
  const metaId = `call-meta-${safeDomId(call.execId || 'current')}`;
  const meta = callDisclosure(t('calls.executionInfo'), metaId, state.metaExpanded, () => {
    state.metaExpanded = !state.metaExpanded;
    state.metaTouched = true;
    renderWithFocus();
  });
  meta.panel.appendChild(detailRow(t('calls.model'), call.model));
  meta.panel.appendChild(detailRow(t('calls.mode'), call.mode));
  meta.panel.appendChild(detailRow(t('calls.state'), callStatusLabel(call)));
  meta.panel.appendChild(detailRow(t('calls.workdir'), call.workDir));
  meta.panel.appendChild(detailRow(t('calls.started'), fmtFull(call.startedAt)));
  meta.panel.appendChild(detailRow(t('calls.ended'), fmtFull(call.completedAt)));
  if (call.exitCode !== null && call.exitCode !== undefined) meta.panel.appendChild(detailRow(t('calls.exitCode'), String(call.exitCode)));
  if (call.delegateStatus) meta.panel.appendChild(detailRow(t('calls.delegateStatus'), call.delegateStatus));
  if (call.inputTokens || call.outputTokens) {
    meta.panel.appendChild(detailRow('Token', `${fmtTokens(call.inputTokens)} in / ${fmtTokens(call.outputTokens)} out`));
  }
  contextStack.appendChild(meta.section);

  const promptText = String(call.prompt || '');
  const promptMatch = !q || promptText.toLowerCase().includes(q);
  if (promptText && promptMatch) {
    const promptId = `call-prompt-${safeDomId(call.execId || 'current')}`;
    const promptExpanded = Boolean(q) || state.promptExpanded;
    const prompt = callDisclosure(t('calls.fullPrompt'), promptId, promptExpanded, () => {
      state.promptExpanded = !state.promptExpanded;
      renderWithFocus();
    }, copyButton(promptText, t('calls.copyPrompt'), t('calls.copiedPrompt'), `copy:${promptId}`));
    const pre = el('pre', 'd-prompt call-prompt');
    pre.appendChild(highlightText(promptText, q));
    prompt.panel.appendChild(pre);
    contextStack.appendChild(prompt.section);
  }
  body.appendChild(contextStack);

  const allEntries = normalizeCallEntries(detail.entries, running);
  const entries = q ? allEntries.filter((entry) => callEntryText(entry).toLowerCase().includes(q)) : allEntries;
  setSearchCount(entries.length, allEntries.length);
  const lastEntry = allEntries[allEntries.length - 1];
  const signature = [
    call.streamBytes || 0,
    allEntries.length,
    lastEntry ? callEntryKey(lastEntry, allEntries.length - 1) : '',
    lastEntry ? String(callEntryText(lastEntry)).length : 0,
  ].join(':');
  if (state.initialized && state.lastSignature && signature !== state.lastSignature && !state.followLive && !q) {
    state.newActivityCount += Math.max(1, allEntries.length - state.lastEntryCount);
  }
  state.lastSignature = signature;
  state.lastEntryCount = allEntries.length;

  const chat = el('section', 'call-chat-workspace');
  const toolbar = el('div', 'call-chat-toolbar');
  const title = el('div', 'call-chat-title');
  title.appendChild(el('strong', '', t('calls.conversation')));
  title.appendChild(el('span', '', t('calls.itemsCount', { count: `${entries.length}${q ? ` / ${allEntries.length}` : ''}` })));
  if (running) title.appendChild(el('span', 'call-chat-live', t('calls.live')));
  toolbar.appendChild(title);

  const auxiliaryEntries = entries
    .map((entry, index) => ({ entry, key: callEntryKey(entry, index) }))
    .filter(({ entry }) => AUXILIARY_CALL_ENTRY_TYPES.has(entry.type));
  if (auxiliaryEntries.length) {
    const allAuxExpanded = auxiliaryEntries.every(({ key }) => state.auxiliaryExpanded.has(key));
    const toggleAux = el('button', 'call-toolbar-command', allAuxExpanded ? t('calls.collapseEvents') : t('calls.expandEvents'));
    toggleAux.type = 'button';
    toggleAux.dataset.focusKey = 'toggle-auxiliary-events';
    toggleAux.disabled = Boolean(q);
    toggleAux.setAttribute('aria-label', allAuxExpanded ? t('calls.collapseAllEvents') : t('calls.expandAllEvents'));
    toggleAux.title = q ? t('calls.searchExpandsEvents') : (allAuxExpanded ? t('calls.collapseAllEvents') : t('calls.expandAllEvents'));
    toggleAux.addEventListener('click', () => {
      for (const { key } of auxiliaryEntries) {
        if (allAuxExpanded) state.auxiliaryExpanded.delete(key);
        else state.auxiliaryExpanded.add(key);
      }
      renderWithFocus();
    });
    toolbar.appendChild(toggleAux);
  }
  const conversationCopy = copyButton(
    formatCallConversation(entries),
    q ? t('calls.copySearchResults') : t('calls.copyConversation'),
    q ? t('calls.copiedSearchResults') : t('calls.copiedConversation'),
    'copy:conversation',
  );
  conversationCopy.disabled = !entries.length;
  toolbar.appendChild(conversationCopy);
  chat.appendChild(toolbar);

  const scroll = el('div', 'chat-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'log');
  scroll.setAttribute('aria-label', t('calls.conversationAria'));
  scroll.setAttribute('aria-live', 'polite');
  scroll.setAttribute('aria-relevant', 'additions text');
  scroll.setAttribute('aria-busy', String(running));
  if (!allEntries.length) {
    scroll.appendChild(el('div', 'detail-empty', running ? t('calls.waitingOutput') : t('calls.noConversation')));
  } else if (q && !entries.length) {
    scroll.appendChild(emptySearchResult(promptMatch ? t('calls.noConversationMatch') : undefined));
  } else {
    const flow = el('div', 'chat-flow');
    entries.forEach((entry, index) => {
      const key = callEntryKey(entry, index);
      flow.appendChild(AUXILIARY_CALL_ENTRY_TYPES.has(entry.type)
        ? renderAuxiliaryCallEntry(entry, key, state, q)
        : renderPrimaryCallEntry(entry, key, state, q));
    });
    scroll.appendChild(flow);
  }
  const jump = el('button', 'chat-jump-latest');
  jump.appendChild(svg('i-arrow-down', 12));
  jump.appendChild(el('span', '', t('calls.newActivity', { count: state.newActivityCount })));
  jump.type = 'button';
  jump.dataset.focusKey = 'jump-to-latest';
  jump.hidden = !state.newActivityCount;
  jump.setAttribute('aria-label', t('calls.jumpLatest', { count: state.newActivityCount }));
  jump.addEventListener('click', () => {
    state.followLive = true;
    state.newActivityCount = 0;
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    jump.hidden = true;
  });
  scroll.addEventListener('scroll', () => {
    const distance = Math.max(0, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
    state.scrollTop = scroll.scrollTop;
    state.bottomDistance = distance;
    if (!q) state.followLive = distance <= CHAT_FOLLOW_THRESHOLD;
    if (state.followLive) {
      state.newActivityCount = 0;
      jump.hidden = true;
    }
  }, { passive: true });
  chat.appendChild(scroll);
  chat.appendChild(jump);
  body.appendChild(chat);
  restoreCallDetailViewport(scroll, state, running, q);
}

/** 全部 Agent 调用详情视图（含搜索） */
function renderCallsListDetail() {
  if (!renderDetailState(t('sections.calls'))) return;
  const body = $('detailBody');
  const q = detailSearch;
  const calls = snapshot.calls || [];
  const matched = q ? calls.filter((c) => matchCall(c, q)) : calls;
  $('detailTitle').textContent = t('calls.allTitle');
  $('detailKind').textContent = 'AGENT';
  setSearchCount(matched.length, calls.length);
  if (!calls.length) {
    body.appendChild(el('div', 'detail-empty', t('calls.noRecords')));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult(t('search.noMatchingCalls')));
    return;
  }
  const rows = el('div', 'rows');
  for (const call of matched) rows.appendChild(callRowEl(call, q));
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', t('calls.openHint')));
  // Token 聚合：总计 + 按工具汇总（仅当前快照视窗内的记录）
  const totals = { input: 0, output: 0 };
  const byTool = new Map();
  for (const c of calls) {
    totals.input += c.inputTokens || 0;
    totals.output += c.outputTokens || 0;
    if (!(c.inputTokens || c.outputTokens)) continue;
    const key = TOOL_LABEL[c.tool] || c.tool || 'Agent';
    const t = byTool.get(key) || { input: 0, output: 0, n: 0 };
    t.input += c.inputTokens || 0;
    t.output += c.outputTokens || 0;
    t.n += 1;
    byTool.set(key, t);
  }
  if (totals.input || totals.output) {
    const card = el('section', 'detail-card token-totals');
    card.appendChild(el('h2', 'd-sec-title', t('calls.tokenTitle', { count: calls.length })));
    card.appendChild(detailRow(t('calls.total'), `${fmtTokens(totals.input)} in / ${fmtTokens(totals.output)} out`));
    for (const [tool, toolTotals] of byTool) {
      card.appendChild(detailRow(tool, `${fmtTokens(toolTotals.input)} in / ${fmtTokens(toolTotals.output)} out · ${t('calls.times', { count: toolTotals.n })}`));
    }
    body.appendChild(card);
  }
}

/** 友好 token 数字：≥1000 显示 k */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(v);
}

/** 全部会话详情视图（含搜索，行内可展开 Run 时间线） */
function renderSessionsListDetail() {
  if (!renderDetailState('SESSION · RUN')) return;
  const body = $('detailBody');
  const q = detailSearch;
  const sessions = snapshot.sessions || [];
  const matched = q ? sessions.filter((s) => matchSession(s, q)) : sessions;
  $('detailTitle').textContent = t('sessions.allTitle');
  $('detailKind').textContent = 'SESSIONS';
  setSearchCount(matched.length, sessions.length);
  if (!sessions.length) {
    body.appendChild(el('div', 'detail-empty', t('sessions.noRecords')));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult(t('search.noMatchingSessions')));
    return;
  }
  const active = findActiveSession(snapshot);
  const ordered = matched.slice().sort((a, b) => Number(b === active) - Number(a === active));
  const rows = el('div', 'rows');
  for (const s of ordered) rows.appendChild(sessionRowEl(s, s === active));
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', t('sessions.openHint')));
}

function textArray(value) {
  if (!Array.isArray(value)) return value ? [String(value)] : [];
  return value.filter((item) => item !== null && item !== undefined).map((item) => {
    if (typeof item === 'string') return item;
    return item.text || item.title || item.id || JSON.stringify(item);
  });
}

function appendContractBlock(parent, label, value, wide = false) {
  const block = el('div', `contract-block${wide ? ' wide' : ''}`);
  block.appendChild(el('div', 'contract-label', label));
  const values = textArray(value);
  if (!values.length) {
    block.appendChild(el('div', 'contract-empty', t('sessions.undeclared')));
  } else {
    const list = el('ul', 'contract-list');
    for (const item of values) list.appendChild(el('li', '', item));
    block.appendChild(list);
  }
  parent.appendChild(block);
}

function chainStepState(step, session, index, position) {
  const activeRunIds = new Set(sessionActiveRunIds(session));
  const stepRunIds = Array.isArray(step.run_ids) ? step.run_ids : [step.run_id].filter(Boolean);
  if (stepRunIds.some((runId) => activeRunIds.has(String(runId)))) return 'current';
  if (String(step.status || '').toLowerCase() === 'running') return 'current';
  if (Number.isInteger(position) && index === position) return 'current';
  if (typeof position === 'string' && (position === step.step_id || position === step.command || position === step.stage)) return 'current';
  const status = String(step.status || '').toLowerCase();
  if (['sealed', 'completed', 'done'].includes(status)) return 'done';
  if (['failed', 'blocked', 'error'].includes(status)) return 'failed';
  return 'pending';
}

function decisionDisplay(item) {
  if (typeof item === 'string') return { text: item, status: '', id: '' };
  if (!item || typeof item !== 'object') return { text: String(item || ''), status: '', id: '' };
  return {
    text: item.text || item.title || item.summary || item.id || JSON.stringify(item),
    status: item.status || '',
    id: item.id || '',
  };
}

function appendRunDetailSection(parent, label, items, tone) {
  if (!Array.isArray(items) || !items.length) return;
  const section = el('section', `run-detail-section ${tone}`);
  section.appendChild(el('div', 'run-detail-title', label));
  for (const raw of items) {
    const item = tone === 'decision' ? decisionDisplay(raw) : { text: String(raw), status: '', id: '' };
    const row = el('div', `run-detail-item${tone === 'gate' ? ' gate-id' : ''}`);
    if (item.status) row.appendChild(el('span', 'decision-status', item.status));
    row.appendChild(document.createTextNode([item.id, item.text].filter(Boolean).join(' · ')));
    section.appendChild(row);
  }
  parent.appendChild(section);
}

function renderRunEntry(run, session, q, gates) {
  const key = `${sessionObjectKey(session)}::${run.run_id}`;
  const verdict = normalizeRunSignal(run.verdict || run.status || 'unknown');
  const attention = ['blocked', 'failed', 'needs_retry', 'done_with_concerns'].includes(verdict) || (run.concerns || []).length > 0;
  const current = isRunActive(run, session) || String(run.status).toLowerCase() === 'running';
  if (!runDisclosureState.has(key)) runDisclosureState.set(key, current || attention);
  const expanded = runDisclosureState.get(key);
  const detailId = `run-detail-${safeDomId(key)}`;
  const entry = el('article', `run-entry${attention ? ' attention' : ''}${current ? ' current' : ''}`);
  entry.style.setProperty('--run-color', VERDICT_COLOR[verdict]
    || (current ? 'var(--ok)' : 'var(--text-dim)'));
  const trigger = el('button', 'run-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-controls', detailId);
  trigger.appendChild(el('span', 'run-seq', run.sequence !== null && run.sequence !== undefined ? `#${run.sequence}` : '—'));

  const main = el('div', 'run-main');
  const primary = el('div', 'run-primary');
  const cmd = el('span', 'run-cmd');
  cmd.appendChild(highlightText(run.command || 'run', q));
  primary.appendChild(cmd);
  const executor = runExecutorLabel(run);
  if (executor) primary.appendChild(el('span', 'run-platform', executor));
  if (Number.isInteger(run.attempt)) primary.appendChild(el('span', 'run-platform', t('runs.attempt', { value: run.attempt })));
  if (Number.isInteger(run.revision)) primary.appendChild(el('span', 'run-platform', t('runs.revision', { value: run.revision })));
  const rid = el('span', 'run-runid', run.run_id || '—');
  primary.appendChild(rid);
  main.appendChild(primary);
  if (run.handoff_summary) {
    const hs = el('div', 'run-handoff');
    hs.appendChild(highlightText(oneLine(run.handoff_summary), q));
    main.appendChild(hs);
  }
  const signals = el('div', 'run-signals');
  const decisions = Array.isArray(run.decisions) ? run.decisions.length : 0;
  const concerns = Array.isArray(run.concerns) ? run.concerns.length : 0;
  const gateCount = Array.isArray(run.gate_ids) ? run.gate_ids.length : 0;
  if (decisions) signals.appendChild(el('span', 'signal-chip decision', t('runs.decisions', { count: decisions })));
  if (concerns) signals.appendChild(el('span', 'signal-chip concern', t('runs.concerns', { count: concerns })));
  if (gateCount) signals.appendChild(el('span', 'signal-chip gate', t('runs.gates', { count: gateCount })));
  if (signals.children.length) main.appendChild(signals);
  trigger.appendChild(main);

  const side = el('div', 'run-side');
  const vBadge = el('span', `run-verdict ${verdictClass(verdict)}`, verdictLabel(verdict));
  vBadge.title = run.verdict || run.status || 'unknown';
  side.appendChild(vBadge);
  const time = [fmtClock2(runDisplayTime(run)), run.duration_secs !== null && run.duration_secs !== undefined ? `${run.duration_secs}s` : ''].filter(Boolean).join(' · ');
  if (time) side.appendChild(el('span', 'tl-time', time));
  side.appendChild(svg('i-chevron', 11));
  side.lastChild.setAttribute('class', 'lucide run-chevron');
  trigger.appendChild(side);
  entry.appendChild(trigger);

  const details = el('div', 'run-detail');
  details.id = detailId;
  details.hidden = !expanded;
  if (run.handoff_summary) {
    const handoff = el('section', 'run-detail-section');
    handoff.appendChild(el('div', 'run-detail-title', t('runs.handoff')));
    handoff.appendChild(el('div', 'run-detail-item', String(run.handoff_summary)));
    details.appendChild(handoff);
  }
  appendRunDetailSection(details, t('runs.decisionsTitle'), run.decisions, 'decision');
  appendRunDetailSection(details, t('runs.concernsTitle'), run.concerns, 'concern');
  renderGateList(details, run.gate_ids, gates);
  // 产出物（懒加载：展开时拉取，按 run 缓存）
  const artKey = key;
  const artState = runArtifactsCache.get(artKey) || { status: 'idle', data: null };
  if (expanded && artState.status === 'idle') {
    loadRunArtifacts(session.session_id, run.run_id, session.project_path);
  }
  if (expanded) {
    if (artState.status === 'loading') {
      const sec = el('section', 'run-detail-section');
      sec.appendChild(el('div', 'run-detail-title', t('runs.artifacts')));
      sec.appendChild(el('div', 'run-detail-item', t('runs.loadingArtifacts')));
      details.appendChild(sec);
    } else if (artState.status === 'error' || (artState.status === 'ready' && !artState.data)) {
      const sec = el('section', 'run-detail-section');
      sec.appendChild(el('div', 'run-detail-title', t('runs.artifacts')));
      sec.appendChild(el('div', 'run-detail-item', t('runs.noArtifacts')));
      details.appendChild(sec);
    } else if (artState.status === 'ready') {
      renderRunArtifactsSection(
        details, artState.data, session.session_id, run.run_id, session.project_path,
      );
    }
  }
  entry.appendChild(details);

  trigger.addEventListener('click', () => {
    runDisclosureState.set(key, !runDisclosureState.get(key));
    renderSessionDetail();
    requestAnimationFrame(() => document.querySelector(`[aria-controls="${detailId}"]`)?.focus());
  });
  return entry;
}

/** Canonical session/3.0 decision status. */
function decisionStatusMeta(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'resolved') return ['st-done', t('common.resolved')];
  if (s === 'escalated') return ['st-error', t('common.escalated')];
  return ['st-cancel', t('common.open')];
}

/** 门禁状态徽章（gates.json status） */
function gateStatusMeta(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'passed' || s === 'done') return ['st-done', t('runs.passed')];
  if (s === 'failed' || s === 'blocked' || s === 'error') return ['st-error', t('common.failed')];
  if (s === 'waived') return ['st-unknown', t('runs.waived')];
  if (s === 'skipped') return ['st-unknown', t('runs.skipped')];
  return ['st-cancel', s || t('runs.pendingReview')];
}

/** run 的门禁列表：id + 状态 + 标题（gates.json 查表） */
function renderGateList(parent, gateIds, gates) {
  if (!Array.isArray(gateIds) || !gateIds.length) return;
  const section = el('section', 'run-detail-section');
  section.appendChild(el('div', 'run-detail-title', t('runs.gateReview')));
  const map = new Map((gates || []).map((g) => [g.key, g]));
  for (const id of gateIds) {
    const g = map.get(id) || {};
    const [cls, label] = gateStatusMeta(g.status);
    const row = el('div', 'run-detail-item gate-id');
    row.appendChild(el('span', `bd ${cls}`, label));
    row.appendChild(document.createTextNode(` ${id}`));
    if (g.title) row.appendChild(document.createTextNode(` · ${g.title}`));
    const marks = [];
    if (g.required) marks.push(t('runs.required'));
    if (g.blocking) marks.push(t('runs.blocking'));
    if (g.waiver) marks.push(t('runs.waived'));
    if (marks.length) row.appendChild(el('span', 'bd bd-dim', marks.join('/')));
    section.appendChild(row);
  }
  parent.appendChild(section);
}

/** run 产出物缓存（按 session:run 键） */
const runArtifactsCache = new Map();

async function loadRunArtifacts(sessionId, runId, projectPath = null) {
  const key = `${sessionLocatorKey(sessionId, projectPath || '')}::${runId}`;
  if (runArtifactsCache.has(key)) return;
  runArtifactsCache.set(key, { status: 'loading', data: null });
  try {
    const data = await invoke('get_run_artifacts', { sessionId, runId, projectPath });
    runArtifactsCache.set(key, { status: data ? 'ready' : 'error', data });
  } catch {
    runArtifactsCache.set(key, { status: 'error', data: null });
  }
  renderWithFocus();
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${v}B`;
}

function renderRunArtifactsSection(parent, art, sessionId, runId, projectPath = null) {
  const section = el('section', 'run-detail-section');
  section.appendChild(el('div', 'run-detail-title', t('runs.artifacts')));
  const meta = [];
  if (art.evidence_records) meta.push(t('runs.evidence', { count: art.evidence_records }));
  if (art.artifacts_count) meta.push(t('runs.artifactCount', { count: art.artifacts_count }));
  if (meta.length) section.appendChild(el('div', 'art-meta', meta.join(' · ')));
  if (art.report_md) {
    const rep = el('details', 'art-report');
    rep.appendChild(el('summary', 'art-summary', 'report.md'));
    const pre = el('pre', 'art-pre');
    pre.textContent = art.report_md;
    rep.appendChild(pre);
    section.appendChild(rep);
  }
  const outputs = Array.isArray(art.outputs) ? art.outputs : [];
  for (const f of outputs) {
    const row = el('div', 'art-file');
    const name = el('button', 'art-file-name', f.name);
    name.type = 'button';
    name.title = t('runs.viewFull');
    name.addEventListener('click', () => openRunOutputModal(
      sessionId, runId, f.name, projectPath,
    ));
    row.appendChild(name);
    if (f.preview) row.appendChild(el('div', 'art-file-preview', oneLine(f.preview)));
    row.appendChild(el('span', 'rt', fmtBytes(f.size)));
    section.appendChild(row);
  }
  parent.appendChild(section);
}

/** output 文件全文 modal */
async function openRunOutputModal(sessionId, runId, name, projectPath = null) {
  const opener = document.activeElement;
  const overlay = el('div', 'md-preview-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('runs.artifactAria', { name }));
  const box = el('div', 'md-preview-box');
  const head = el('div', 'md-preview-head');
  const h = el('div', 'md-preview-title', name);
  h.title = `${sessionId} · ${runId}`;
  head.appendChild(h);
  const close = el('button', 'chat-icon-btn', '');
  close.type = 'button';
  close.title = t('runs.closeEsc');
  close.setAttribute('aria-label', t('common.close'));
  close.appendChild(svg('i-x', 13));
  const dismiss = () => {
    overlay.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  };
  close.addEventListener('click', dismiss);
  head.appendChild(close);
  const body = el('pre', 'md-preview-body art-content');
  body.textContent = t('runs.loadingContent');
  body.setAttribute('aria-busy', 'true');
  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); dismiss(); return; }
    if (e.key === 'Tab') trapTab(e, overlay);
  });
  document.body.appendChild(overlay);
  close.focus();
  try {
    const content = await invoke('get_run_artifact_content', {
      sessionId, runId, name, projectPath,
    });
    if (overlay.isConnected) body.textContent = content || t('runs.emptyFile');
  } catch {
    if (overlay.isConnected) body.textContent = t('runs.readFailed');
  }
  body.removeAttribute('aria-busy');
}

function renderSessionDetail() {
  if (!renderDetailState('SESSION · RUN')) return;
  const body = $('detailBody');
  const session = detail.session || {};
  const q = detailSearch;
  $('detailTitle').textContent = session.session_id || t('sessions.details');

  const resume = el('section', 'resume-strip');
  resume.appendChild(el('div', 'resume-intent', session.intent || t('sessions.undeclaredIntent')));
  const activeRunIds = sessionActiveRunIds(session);
  const resumeMeta = el('div', 'resume-meta');
  resumeMeta.appendChild(el('span', `badge ${statusClass(session.status)}`, sessionStatusMeta(session.status, activeRunIds.length)[1]));
  resumeMeta.appendChild(el('span', 'resume-stat', `${session.run_count || 0} Runs`));
  if (activeRunIds.length) {
    const active = el('span', 'resume-stat');
    active.appendChild(document.createTextNode(t('sessions.activeRuns', { count: activeRunIds.length })));
    activeRunIds.forEach((runId, index) => {
      if (index) active.appendChild(document.createTextNode(', '));
      active.appendChild(el('code', '', runId));
    });
    resumeMeta.appendChild(active);
  } else if (session.latest_completed_run_id) {
    const latest = el('span', 'resume-stat');
    latest.appendChild(document.createTextNode(t('sessions.latestCompleted')));
    latest.appendChild(el('code', '', session.latest_completed_run_id));
    resumeMeta.appendChild(latest);
  }
  if (Number.isInteger(session.orchestration_revision)) {
    resumeMeta.appendChild(el('span', 'resume-stat', t('sessions.orchestrationRevision', { value: session.orchestration_revision })));
  }
  if (Number.isInteger(session.activity_revision)) {
    resumeMeta.appendChild(el('span', 'resume-stat', t('sessions.activityRevision', { value: session.activity_revision })));
  }
  resume.appendChild(resumeMeta);
  body.appendChild(resume);

  // 知识沉淀收据：promoted ids / seal 信息 / 派生来源（A3）
  const lifecycle = detail.lifecycle && typeof detail.lifecycle === 'object' ? detail.lifecycle : {};
  const promotedSpecs = Array.isArray(lifecycle.promoted_spec_ids) ? lifecycle.promoted_spec_ids : [];
  const promotedKnowhow = Array.isArray(lifecycle.promoted_knowhow_ids) ? lifecycle.promoted_knowhow_ids : [];
  const hasReceipt = promotedSpecs.length || promotedKnowhow.length
    || lifecycle.seal_summary || lifecycle.sealed_at || lifecycle.forked_from;
  if (hasReceipt) {
    const kSection = el('section', 'detail-section receipt-section');
    kSection.appendChild(el('h2', 'section-title', t('sessions.receiptTitle')));
    const promoteRow = (label, ids, kind) => {
      const row = el('div', 'receipt-row');
      row.appendChild(el('span', 'receipt-label', label));
      const wrap = el('div', 'receipt-ids');
      if (!ids.length) {
        wrap.appendChild(el('span', 'receipt-empty', t('common.none')));
      } else {
        for (const id of ids) {
          const chip = el('button', 'receipt-chip', id);
          chip.type = 'button';
          chip.title = t('sessions.openKnowledge', { id });
          chip.addEventListener('click', () => openDetail('knowledge-item', `${kind}::${id}`, chip));
          wrap.appendChild(chip);
        }
      }
      row.appendChild(wrap);
      kSection.appendChild(row);
    };
    promoteRow(t('sessions.promotedSpecs'), promotedSpecs, 'specs');
    promoteRow(t('sessions.promotedKnowhow'), promotedKnowhow, 'knowhow');
    if (lifecycle.seal_summary) kSection.appendChild(el('div', 'receipt-note', t('sessions.sealSummary', { value: lifecycle.seal_summary })));
    if (lifecycle.sealed_at) kSection.appendChild(el('div', 'receipt-note', t('sessions.sealedAt', { value: fmtFull(lifecycle.sealed_at) })));
    if (lifecycle.forked_from) kSection.appendChild(el('div', 'receipt-note', t('sessions.forkedFrom', { value: lifecycle.forked_from })));
    body.appendChild(kSection);
  }

  const boundary = detail.boundary_contract && typeof detail.boundary_contract === 'object' ? detail.boundary_contract : {};
  const boundarySection = el('section', 'detail-section boundary-section');
  boundarySection.appendChild(el('h2', 'section-title', t('sessions.boundaryTitle')));
  const dod = el('div', 'contract-dod');
  dod.appendChild(el('div', 'contract-label', 'Definition of Done'));
  dod.appendChild(el('div', 'contract-value', boundary.definition_of_done || t('sessions.undeclared')));
  boundarySection.appendChild(dod);
  const contractGrid = el('div', 'contract-grid');
  appendContractBlock(contractGrid, 'In Scope', boundary.in_scope);
  appendContractBlock(contractGrid, 'Constraints', boundary.constraints);
  if (textArray(boundary.out_of_scope).length) appendContractBlock(contractGrid, 'Out of Scope', boundary.out_of_scope, true);
  boundarySection.appendChild(contractGrid);
  body.appendChild(boundarySection);

  const decisions = Array.isArray(detail.decisions) ? detail.decisions : [];
  if (decisions.length) {
    const decisionSection = el('section', 'detail-section gates-section');
    decisionSection.appendChild(el('h2', 'section-title', t('sessions.decisionsTitle')));
    const ledger = el('div', 'run-ledger');
    for (const decision of decisions) {
      const [cls, label] = decisionStatusMeta(decision.status);
      const row = el('div', 'gate-row');
      row.appendChild(el('span', `bd ${cls}`, label));
      const copy = el('div', 'gate-copy');
      copy.appendChild(el('div', 'gate-title', decision.decision_id || t('common.unknown')));
      const meta = [
        decision.after_step_id ? t('sessions.afterStep', { id: decision.after_step_id }) : '',
        Array.isArray(decision.evidence_refs) && decision.evidence_refs.length
          ? t('sessions.decisionEvidence', { count: decision.evidence_refs.length })
          : '',
      ].filter(Boolean).join(' · ');
      if (meta) copy.appendChild(el('div', 'gate-meta', meta));
      row.appendChild(copy);
      ledger.appendChild(row);
    }
    decisionSection.appendChild(ledger);
    body.appendChild(decisionSection);
  }

  const gates = Array.isArray(detail.gates) ? detail.gates : [];
  if (gates.length || !decisions.length) {
    const gatesSection = el('section', 'detail-section gates-section');
    gatesSection.appendChild(el('h2', 'section-title', t('sessions.gatesTitle')));
    if (!gates.length) {
      gatesSection.appendChild(el('div', 'detail-empty', t('sessions.noGates')));
    } else {
      const ledger = el('div', 'run-ledger');
      for (const g of gates) {
        const [cls, label] = gateStatusMeta(g.status);
        const row = el('div', 'gate-row');
        row.appendChild(el('span', `bd ${cls}`, label));
        const txt = el('div', 'gate-copy');
        const gateTitle = el('div', 'gate-title', g.title || g.key);
        gateTitle.title = `${g.key} · ${g.scope || ''}`;
        txt.appendChild(gateTitle);
        const meta = [g.key, g.scope, g.run_id].filter(Boolean).join(' · ');
        if (meta) txt.appendChild(el('div', 'gate-meta', meta));
        row.appendChild(txt);
        const marks = [];
        if (g.required) marks.push(t('runs.required'));
        if (g.blocking) marks.push(t('runs.blocking'));
        if (g.waiver) marks.push(t('runs.waived'));
        if (marks.length) row.appendChild(el('span', 'gate-marks', marks.join(' / ')));
        ledger.appendChild(row);
      }
      gatesSection.appendChild(ledger);
    }
    body.appendChild(gatesSection);
  }

  const orchestration = detail.orchestration && typeof detail.orchestration === 'object' ? detail.orchestration : {};
  const chain = Array.isArray(orchestration.chain) ? orchestration.chain.filter((step) => step && typeof step === 'object') : [];
  const stepMatches = (step) => {
    if (!q) return true;
    return [
      step.command, step.step_id, step.stage, step.goal_ref, step.run_id, step.status,
      ...(Array.isArray(step.run_ids) ? step.run_ids : []),
      step.decision_ref, ...(Array.isArray(step.decision_refs) ? step.decision_refs : []),
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };
  const steps = chain.filter(stepMatches);
  const chainSection = el('section', 'detail-section chain-section');
  chainSection.appendChild(el('h2', 'section-title', t('sessions.orchestrationTitle')));
  const summary = el('div', 'chain-summary');
  if (orchestration.engine) {
    summary.appendChild(document.createTextNode(t('sessions.engine')));
    summary.appendChild(el('strong', '', orchestration.engine));
  }
  if (orchestration.quality_mode) {
    summary.appendChild(document.createTextNode(t('sessions.quality')));
    summary.appendChild(el('strong', '', orchestration.quality_mode));
  }
  const orchestrationRevision = orchestration.orchestration_revision ?? session.orchestration_revision;
  if (Number.isInteger(orchestrationRevision)) {
    summary.appendChild(el('span', '', t('sessions.orchestrationRevision', { value: orchestrationRevision })));
  }
  if (chain.length) summary.appendChild(el('span', '', `${chain.length} steps`));
  chainSection.appendChild(summary);
  if (!chain.length) {
    chainSection.appendChild(el('div', 'detail-empty', t('sessions.noSteps')));
  } else if (q && !steps.length) {
    chainSection.appendChild(el('div', 'detail-empty', t('sessions.noMatchingSteps')));
  } else {
    const rail = el('ol', 'chain-rail');
    chain.forEach((step, index) => {
      if (q && !stepMatches(step)) return;
      const state = chainStepState(step, session, index, orchestration.position);
      const row = el('li', `chain-step ${state}`);
      row.appendChild(el('span', 'chain-node'));
      const copy = el('div', 'chain-copy');
      const cmd = el('div', 'chain-cmd');
      cmd.appendChild(highlightText(step.command || step.step_id || `step ${index + 1}`, q));
      copy.appendChild(cmd);
      const id = el('div', 'chain-id');
      id.appendChild(highlightText([
        step.step_id, step.stage, step.goal_ref, step.decision_ref,
      ].filter(Boolean).join(' · '), q));
      copy.appendChild(id);
      row.appendChild(copy);
      const runIds = Array.isArray(step.run_ids) ? step.run_ids.filter(Boolean) : [step.run_id].filter(Boolean);
      const latestRunId = step.run_id || runIds.at(-1);
      const runLabel = runIds.length > 1
        ? t('sessions.runAttempts', { run: latestRunId, count: runIds.length })
        : (latestRunId || step.status || 'pending');
      const runBadge = el('span', 'chain-run', runLabel);
      if (runIds.length) runBadge.title = runIds.join('\n');
      row.appendChild(runBadge);
      rail.appendChild(row);
    });
    chainSection.appendChild(rail);
  }
  body.appendChild(chainSection);

  const allRuns = Array.isArray(detail.runs) ? detail.runs : [];
  const runs = allRuns.length > 50 ? allRuns.slice(-50) : allRuns;
  const visibleRuns = q ? runs.filter((r) => runMatches(r || {}, q)) : runs;
  setSearchCount(visibleRuns.length + steps.length, runs.length + chain.length);
  const runSection = el('section', 'detail-section runs-section');
  runSection.appendChild(el('h2', 'section-title', t('sessions.timelineTitle', {
    visible: visibleRuns.length,
    total: q ? ` / ${runs.length}` : '',
  })));
  if (allRuns.length > runs.length) runSection.appendChild(el('div', 'timeline-limit', t('sessions.timelineLimit', { count: runs.length })));
  if (!runs.length) {
    runSection.appendChild(el('div', 'detail-empty', t('sessions.noRuns')));
  } else if (q && !visibleRuns.length && !steps.length) {
    runSection.appendChild(emptySearchResult(t('sessions.noMatchingRuns')));
  } else {
    const ledger = el('div', 'run-ledger');
    for (const run of visibleRuns) ledger.appendChild(renderRunEntry(run || {}, session, q, gates));
    runSection.appendChild(ledger);
  }
  body.appendChild(runSection);
}

/** 待处置知识候选（A1+A2）：KDC 列表 + 处置命令复制 */
function renderPendingDetail() {
  if (!renderDetailState(t('knowledge.pendingLabel'))) return;
  const body = $('detailBody');
  const pc = snapshot.pending_candidates || { total: 0, items: [] };
  const items = Array.isArray(pc.items) ? pc.items : [];
  const q = detailSearch;
  const matched = q
    ? items.filter((it) =>
        [it.title, it.summary, it.candidate_id, it.session_id, it.run_id, it.target, it.action]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)))
    : items;
  $('detailTitle').textContent = t('knowledge.pendingDetailTitle', { count: pc.total });
  $('detailKind').textContent = 'PENDING';
  setSearchCount(matched.length, items.length);
  const sub = el('div', 'kb-sub');
  sub.textContent = t('knowledge.pendingSubtitle');
  body.appendChild(sub);
  if (!items.length) {
    body.appendChild(el('div', 'detail-empty', t('knowledge.noPending')));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult(t('search.noMatchingCandidate')));
    return;
  }
  const rows = el('div', 'rows');
  for (const it of matched) {
    const row = el('article', 'pend-item');
    const dot = el('i', 'lg-dot');
    dot.style.setProperty('--c', it.target === 'knowhow' ? 'var(--ok)' : 'var(--accent)');
    row.appendChild(dot);
    const main = el('div', 'pend-main');
    const head = el('div', 'pend-head');
    const titleNode = el('span', 'pend-title');
    titleNode.appendChild(highlightText(it.title || it.candidate_id, q));
    head.appendChild(titleNode);
    head.appendChild(el('span', 'bd bd-dim', it.target || '—'));
    head.appendChild(el('span', 'bd bd-dim', it.action || '—'));
    main.appendChild(head);
    if (it.summary) {
      const s = el('div', 'pend-sum');
      s.appendChild(highlightText(oneLine(it.summary), q));
      main.appendChild(s);
    }
    const meta = el('div', 'pend-meta');
    meta.appendChild(el('code', '', it.candidate_id));
    meta.appendChild(el('span', '', it.session_id));
    if (it.run_id) meta.appendChild(el('span', '', it.run_id));
    if (it.updated_at) meta.appendChild(el('span', 'rt', fmtAgo(it.updated_at)));
    main.appendChild(meta);
    row.appendChild(main);
    const actions = el('div', 'pend-actions');
    const promoteCmd = `maestro knowledge promote ${it.session_id} --candidate ${it.candidate_id}`;
    const copy = copyButton(promoteCmd, t('knowledge.copyPromote'), t('knowledge.copiedPromote'));
    copy.title = promoteCmd;
    actions.appendChild(copy);
    const open = el('button', 'chat-icon-btn', '');
    open.type = 'button';
    open.title = t('knowledge.openSession');
    open.setAttribute('aria-label', t('knowledge.openSession'));
    open.appendChild(svg('i-session', 12));
    open.addEventListener('click', () => openDetail(
      'session', it.session_id, open, false, it.project_path || null,
    ));
    actions.appendChild(open);
    row.appendChild(actions);
    rows.appendChild(row);
  }
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', t('knowledge.pendingHint')));
}

// ---------------------------------------------------------------------------
// 胶囊
// ---------------------------------------------------------------------------

// Agent 完成驻留：running→无 running 的瞬间保留 Agent 面板 ~1.5s，让「刚刚完成」可感知
let capLastRunning = false;
let capDwellUntil = 0;
let capDwellTimer = null;

function renderCapsule() {
  const sessions = snapshot.sessions || [];
  const calls = snapshot.calls || [];
  const active = findActiveSession(snapshot);
  const runningCalls = calls.filter((call) => callStatus(call) === 'running');
  const selectedCall = runningCalls[0] || calls[0] || null;
  const hasRunningAgent = runningCalls.length > 0;
  const now = Date.now();
  if (capLastRunning && !hasRunningAgent) {
    capDwellUntil = now + 1500;
    clearTimeout(capDwellTimer);
    capDwellTimer = setTimeout(() => renderCapsule(), 1600);
  }
  capLastRunning = hasRunningAgent;
  const dwelling = !hasRunningAgent && now < capDwellUntil && Boolean(selectedCall);
  const capsule = $('capsule');
  const sub = $('capSub');
  const sessionDot = sub.querySelector('.dot');
  const progressBar = $('capProgressBar');

  let sessionSignal = 'idle';
  let sessionColor = 'var(--text-dim)';
  let sessionContextMeta = t('common.idle');
  if (active) {
    const run = active.latest_run || null;
    const activeRunCount = sessionActiveRunIds(active).length;
    const running = activeRunCount > 0 || String(run?.status || '').toLowerCase() === 'running';
    sessionSignal = normalizeRunSignal(run?.verdict || run?.status || active.status || 'unknown');
    sessionColor = VERDICT_COLOR[sessionSignal]
      || (running ? 'var(--ok)' : null)
      || (['sealed', 'completed'].includes(sessionSignal) ? 'var(--info)' : null)
      || (['paused'].includes(sessionSignal) ? 'var(--warn)' : null)
      || (['failed', 'blocked', 'error'].includes(sessionSignal) ? 'var(--danger)' : 'var(--text-dim)')
      || 'var(--text-dim)';
    $('capTitle').textContent = active.intent ? oneLine(active.intent) : active.session_id;
    const sm = sessionStatusMeta(active.status, activeRunCount);
    $('capStatus').className = `bd ${sm[0]} cap-status`;
    $('capStatus').textContent = sm[1];
    sessionDot.style.setProperty('--c', sessionColor);
    sessionDot.classList.toggle('pulse', running);
    const executor = runExecutorLabel(run);
    $('capSessionAgent').textContent = executor || 'Session';
    const step = run && run.sequence != null && active.run_count
      ? `${run.sequence}/${active.run_count}`
      : `#${run?.sequence ?? '—'}`;
    sessionContextMeta = run ? `${step} · ${sm[1]}` : sm[1];
    $('capSubT').textContent = run ? `${step} · ${run.command || 'run'}` : t('capsule.waitingRun');
    $('capAgo').textContent = run ? fmtAgo(runDisplayTime(run)) : '';
    if (run && run.sequence != null && active.run_count) {
      $('capProgress').hidden = false;
      progressBar.style.width = `${Math.min(100, Math.round((run.sequence / active.run_count) * 100))}%`;
    } else {
      $('capProgress').hidden = true;
      progressBar.style.width = '0%';
    }
    $('capSessionPanel').setAttribute('aria-label', t('capsule.sessionAria', { title: $('capTitle').textContent, status: sm[1] }));
  } else {
    $('capTitle').textContent = snapshot.workspace || 'Maestro';
    $('capStatus').className = 'bd bd-dim cap-status';
    $('capStatus').textContent = t('common.idle');
    sessionDot.style.setProperty('--c', 'var(--text-dim)');
    sessionDot.classList.remove('pulse');
    $('capSessionAgent').textContent = 'Session';
    $('capSubT').textContent = t('capsule.noActiveSession');
    $('capAgo').textContent = '';
    $('capProgress').hidden = true;
    progressBar.style.width = '0%';
    $('capSessionPanel').setAttribute('aria-label', t('capsule.noActiveSessionAria'));
  }

  if (selectedCall) {
    const running = callStatus(selectedCall) === 'running';
    const toolColor = TOOL_COLORS[selectedCall.tool] || 'var(--text-dim)';
    const toolLabel = TOOL_LABEL[selectedCall.tool] || selectedCall.tool || 'Agent';
    $('capAgentDot').classList.toggle('pulse', running);
    $('capAgentDot').style.setProperty('--c', toolColor);
    $('capAgentCli').textContent = `${toolLabel} CLI`;
    $('capAgentModel').textContent = selectedCall.model || t('calls.defaultModel');
    $('capAgentStatus').className = `bd ${callStatusClass(selectedCall)}`;
    $('capAgentStatus').textContent = callStatusLabel(selectedCall);
    const activityMs = Number(selectedCall.lastActivityMs);
    const activityAt = Number.isFinite(activityMs) && activityMs > 0
      ? new Date(activityMs).toISOString()
      : selectedCall.completedAt || selectedCall.startedAt;
    $('capAgentTime').textContent = fmtAgo(activityAt);
    $('capAgentBar').style.width = running ? '100%' : '0%';
    $('capAgentBar').style.background = toolColor;
    $('capAgentPanel').setAttribute('aria-label', t('capsule.agentAria', {
      tool: toolLabel,
      model: selectedCall.model || t('calls.defaultModel'),
      status: callStatusLabel(selectedCall),
    }));
  } else {
    $('capAgentDot').classList.remove('pulse');
    $('capAgentDot').style.setProperty('--c', 'var(--text-dim)');
    $('capAgentCli').textContent = 'Maestro CLI';
    $('capAgentModel').textContent = t('capsule.waitingAgent');
    $('capAgentStatus').className = 'bd bd-dim';
    $('capAgentStatus').textContent = t('common.idle');
    $('capAgentTime').textContent = '—';
    $('capAgentBar').style.width = '0%';
    $('capAgentPanel').setAttribute('aria-label', t('capsule.noAgentActivity'));
  }

  if (hasRunningAgent || dwelling) {
    setCapsulePane('agent');
    $('capContextLabel').textContent = 'AGENT';
    $('capContextMeta').textContent = hasRunningAgent ? t('capsule.runningCount', { count: runningCalls.length }) : t('capsule.justCompleted');
    $('capContextDot').style.setProperty('--c', selectedCall ? (TOOL_COLORS[selectedCall.tool] || 'var(--ok)') : 'var(--ok)');
    $('capContextDot').classList.toggle('pulse', hasRunningAgent);
  } else {
    setCapsulePane('session');
    $('capContextLabel').textContent = 'SESSION';
    $('capContextMeta').textContent = sessionContextMeta;
    $('capContextDot').style.setProperty('--c', sessionColor);
    $('capContextDot').classList.toggle('pulse', ['running', 'active', 'executing'].includes(sessionSignal));
  }

  const visibleCall = (hasRunningAgent || dwelling) ? selectedCall : null;
  const visualKind = visibleCall ? callStatus(visibleCall) : sessionSignal;
  const visualColor = visibleCall
    ? (TOOL_COLORS[visibleCall.tool] || 'var(--text-dim)')
    : sessionColor;
  capsule.dataset.kind = visualKind;
  capsule.style.setProperty('--cap-color', visualColor);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 独立编辑器窗口（多 tab，由 Rust 预创建复用，主窗口仅转发）
// ---------------------------------------------------------------------------

/** 打开独立编辑器窗口并添加/激活条目 tab */
async function openEditor(kind, id) {
  try {
    await invoke('open_editor_tab', { kind, id });
    $('liveStatus').textContent = t('status.editorOpened');
  } catch (err) {
    $('liveStatus').textContent = t('status.editorOpenFailed', { error: err && err.message ? err.message : err });
  }
}

/** 新建 md 知识条目（创建后直接打开到编辑器窗口） */
async function createKnowledgeItem() {
  const kind = window.prompt(t('editor.kindPrompt'), 'specs');
  if (!kind || !['specs', 'memory', 'knowhow'].includes(kind)) return;
  const title = window.prompt(t('editor.titlePrompt'));
  if (!title) return;
  try {
    const id = await invoke('create_knowledge_item', { kind, title, content: '' });
    kbItemsPromise = null; // 条目列表失效，下次拉取
    delete detailCache['knowledge::all'];
    $('liveStatus').textContent = t('status.created', { id });
    await openEditor(kind, id);
  } catch (err) {
    $('liveStatus').textContent = t('status.createFailed', { error: err && err.message ? err.message : err });
  }
}

// ---------------------------------------------------------------------------
// Markdown 预览 modal（详情页内渲染，md.js 共享渲染器）
// ---------------------------------------------------------------------------

let mdPreviewEl = null;
let mdPreviewOpener = null;

/** modal 焦点陷阱：Tab 在 overlay 内循环 */
function trapTab(e, root) {
  const focusables = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) { e.preventDefault(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openMdPreview(content, title) {
  closeMdPreview();
  const overlay = el('div', 'md-preview-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${t('common.preview')}: ${title || 'Markdown'}`);
  const box = el('div', 'md-preview-box');
  const head = el('div', 'md-preview-head');
  const h = el('div', 'md-preview-title', title || `${t('common.preview')} Markdown`);
  h.title = title || '';
  head.appendChild(h);
  const close = el('button', 'chat-icon-btn md-preview-close', '');
  close.type = 'button';
  close.title = `${t('common.close')} ${t('common.preview')} (Esc)`;
  close.setAttribute('aria-label', `${t('common.close')} ${t('common.preview')}`);
  close.appendChild(svg('i-x', 13));
  close.addEventListener('click', closeMdPreview);
  head.appendChild(close);
  const body = el('div', 'md-preview-body');
  if (typeof renderMd === 'function') {
    body.innerHTML = renderMd(content);
  } else {
    // 降级分支必须走 textContent，原文不可未转义注入
    body.appendChild(el('pre', '', String(content || '')));
  }
  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeMdPreview();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') trapTab(e, overlay);
  });
  document.body.appendChild(overlay);
  mdPreviewEl = overlay;
  mdPreviewOpener = document.activeElement === document.body ? null : document.activeElement;
  close.focus();
}

function closeMdPreview() {
  if (mdPreviewEl) {
    mdPreviewEl.remove();
    mdPreviewEl = null;
    if (mdPreviewOpener && mdPreviewOpener.isConnected && typeof mdPreviewOpener.focus === 'function') {
      mdPreviewOpener.focus();
    }
    mdPreviewOpener = null;
  }
}

// Esc 关闭预览（在既有 Esc 处理前优先拦截）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mdPreviewEl) {
    e.stopImmediatePropagation();
    closeMdPreview();
  }
}, true);

// ---------------------------------------------------------------------------
// 全局搜索（Ctrl/⌘+K）：跨 调用/会话/知识 的统一面板（业务需求 E5）
// ---------------------------------------------------------------------------
let gkEl = null;
let gkOpener = null;
let globalSearchReqId = 0;

function openGlobalSearch() {
  if (gkEl) { gkEl.querySelector('input')?.focus(); return; }
  gkOpener = document.activeElement === document.body ? null : document.activeElement;
  const overlay = el('div', 'md-preview-overlay gk-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('search.global'));
  const box = el('div', 'gk-box');
  const head = el('div', 'gk-head');
  head.appendChild(svg('i-search', 13));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t('search.globalPlaceholder');
  input.setAttribute('aria-label', t('search.global'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  head.appendChild(input);
  head.appendChild(el('span', 'gk-hint', t('search.globalHint')));
  const body = el('div', 'gk-body');
  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeGlobalSearch(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeGlobalSearch(); return; }
    if (e.key === 'Tab') { trapTab(e, overlay); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(body.querySelectorAll('.gk-item'));
      if (!items.length) return;
      const cur = items.findIndex((n) => n.classList.contains('sel'));
      const next = e.key === 'ArrowDown'
        ? (cur >= items.length - 1 ? 0 : cur + 1)
        : (cur <= 0 ? items.length - 1 : cur - 1);
      if (cur >= 0) items[cur].classList.remove('sel');
      items[next].classList.add('sel');
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      body.querySelector('.gk-item.sel')?.click();
    }
  });
  let gkTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(gkTimer);
    gkTimer = setTimeout(() => { void renderGlobalSearch(body, input.value.trim()); }, 120);
  });
  document.body.appendChild(overlay);
  gkEl = overlay;
  void renderGlobalSearch(body, '');
  input.focus();
}

function closeGlobalSearch() {
  globalSearchReqId += 1;
  if (!gkEl) return;
  gkEl.remove();
  gkEl = null;
  if (gkOpener && gkOpener.isConnected && typeof gkOpener.focus === 'function') gkOpener.focus();
  gkOpener = null;
}

async function renderGlobalSearch(body, rawQ) {
  const requestId = ++globalSearchReqId;
  const q = rawQ.toLowerCase();
  const mkItem = (title, meta, onOpen) => {
    const b = el('button', 'gk-item');
    b.type = 'button';
    b.appendChild(el('span', 'gk-t', title));
    if (meta) b.appendChild(el('span', 'gk-m', meta));
    b.addEventListener('click', () => { closeGlobalSearch(); onOpen(); });
    return b;
  };
  const groups = [];
  const calls = (snapshot?.calls || []).filter((c) => matchCall(c, q)).slice(0, 6)
    .map((c) => mkItem(oneLine(c.prompt || c.execId), `${TOOL_LABEL[c.tool] || c.tool || 'Agent'} · ${callStatusLabel(c)}`, () => openDetail('call', c.execId)));
  if (calls.length) groups.push([t('sections.calls'), calls]);
  const sess = (snapshot?.sessions || []).filter((s) => matchSession(s, q)).slice(0, 6)
    .map((s) => mkItem(
      oneLine(s.intent || s.session_id),
      `${s.session_id}${s.status ? ' · ' + s.status : ''}`,
      () => openDetail('session', s.session_id, null, false, s.project_path),
    ));
  if (sess.length) groups.push(['Session · Run', sess]);
  if (q) {
    const items = (await getKbItems() || []).filter((k) => matchKbItem(k, q)).slice(0, 6)
      .map((k) => mkItem(k.title || k.id, k.kind || '', () => openDetail('knowledge-item', `${k.kind}::${k.id}`)));
    if (items.length) groups.push([t('knowledge.knowledge'), items]);
  }
  // 异步返回后面板可能已关闭或查询已变化
  if (!body.isConnected || requestId !== globalSearchReqId) return;
  body.innerHTML = '';
  for (const [label, items] of groups) {
    body.appendChild(el('div', 'gk-group', label));
    for (const item of items) body.appendChild(item);
  }
  if (!groups.length) body.appendChild(el('div', 'gk-empty', q ? t('search.noResults') : t('search.noData')));
  body.querySelector('.gk-item')?.classList.add('sel');
}

function svg(symbol, size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'lucide');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `icons.svg#${symbol}`);
  s.appendChild(use);
  return s;
}

function oneLine(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function fmtAgo(iso) {
  if (!iso) return '—';
  return i18n.formatRelative(iso) || '—';
}

function fmtClock(epochSeconds) {
  if (!epochSeconds) return '—';
  return i18n.formatTime(epochSeconds) || '—';
}

function fmtClock2(iso) {
  if (!iso) return '';
  return i18n.formatTime(iso);
}

function fmtFull(iso) {
  if (!iso) return '';
  return i18n.formatDateTime(iso);
}

/** 内容区底部渐隐（参考稿 #fade） */
function updateFade() {
  const c = $('content');
  const f = $('fade');
  if (!c || !f) return;
  const can = c.scrollHeight - c.clientHeight > 24;
  const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 16;
  f.style.opacity = can && !atBottom ? '1' : '0';
}
function scheduleFade() { setTimeout(updateFade, 60); }

/** 内容自适应窗口高度（卡片模式，列表视图）：测真实内容而非视口；详情视图保持窗口高度内部滚动 */
let fitTimer = null;
function fitWindow() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    if (document.body.dataset.mode !== 'card' || dockedEdge) return;
    if (view) return; // 详情视图：不随内容拉高窗口，由 .content 内部滚动
    const content = document.querySelector('.content');
    const h = content ? content.scrollHeight + 46 + 32 + 22 : document.documentElement.scrollHeight;
    invoke('fit_window_height', { height: h }).catch(() => {});
  }, 120);
}

init().catch((err) => {
  showBootError(`init failed: ${err && err.message ? err.message : String(err)}`);
});

