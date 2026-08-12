// ===========================================================================
// Maestro Sidebar — 前端逻辑
// 数据流：Rust 后端快照（get_snapshot / snapshot-changed 事件）→ 渲染三区块
// 详情：点击 Agent 调用 / 会话 → 详情视图（调用对话 / Session·Run 时间线）
// ===========================================================================

'use strict';

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
if (!TAURI) {
  showBootError('window.__TAURI__ 不存在：应用未在 Tauri 容器中运行，或 withGlobalTauri 未生效');
}
const { invoke } = TAURI?.core ?? {};
const { listen } = TAURI?.event ?? {};
const { open: dialogOpen } = TAURI?.dialog ?? {};
const appWindow = TAURI?.window?.getCurrentWindow?.() ?? null;
if (!invoke) showBootError('__TAURI__.core 缺失：Tauri API 未注入');

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
const CALLS_LIMIT = 8;
const SESSIONS_LIMIT = 8;
let callsExpanded = false;
let sessionsListExpanded = false;
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
// 高频知识缓存（30s TTL）
let topKbCache = { ts: 0, items: null };
const TOP_KB_TTL = 30 * 1000;
const TOP_KB_LIMIT = 5;
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
  ready: 'var(--ok)', done: 'var(--ok)',
  blocked: 'var(--danger)', failed: 'var(--danger)',
  'needs-retry': 'var(--warn)', done_with_concerns: 'var(--warn)', ready_with_concerns: 'var(--warn)',
};
// verdict 中文语义（层次分明的状态语言）；原始英文保留在 title 中供技术读者查看
const VERDICT_LABEL = {
  ready: '就绪', done: '完成',
  blocked: '卡住', failed: '失败',
  'needs-retry': '需重试', done_with_concerns: '有疑虑', ready_with_concerns: '有疑虑',
};
function verdictLabel(v) {
  const s = String(v || '').toLowerCase();
  return VERDICT_LABEL[s] || s || '未知';
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
  applyTheme();
  await bindEvents();
  try {
    config = await invoke('get_config');
  } catch { config = { configured: false, roots: [], always_on_top: false }; }
  applyTop(config.always_on_top);
  applyWallpaper(config);

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
      snapshot = cached.snapshot;
      render();
      $('liveStatus').textContent = `缓存 · ${fmtClock2(new Date(cached.ts).toISOString())}`;
    }
  } catch { /* 缓存损坏忽略 */ }

  // 首帧骨架：无缓存时快照到达前不闪空态
  if (!snapshot) {
    $('liveStatus').textContent = '正在加载…';
    renderSkeleton();
  }
  try {
    snapshot = await invoke('get_snapshot');
    cacheSnapshot(snapshot);
  } catch (err) {
    snapshot = { workspace: '未连接', active_session_id: null, sessions: [], calls: [], knowledge: { total: 0 } };
    $('liveStatus').textContent = '连接中断';
    $('liveDot').classList.add('stale');
    showBootError(`首次快照失败：${String(err && err.message ? err.message : err)}`);
  }
  render();

  // 后端推送：快照变化即重渲染（指纹去重在 Rust 端）；菜单打开或焦点在行内时保留焦点
  try {
    await listen('snapshot-changed', (event) => {
      snapshot = event.payload;
      cacheSnapshot(snapshot);
      scheduleLiveCallDetailRefresh();
      if (!$('menuPop').hidden) return;
      $('liveStatus').textContent = '实时监听';
      renderWithFocus();
    });
    await listen('knowledge-updated', (event) => {
      void refreshKnowledgeCaches(event.payload || {});
    });
    $('liveStatus').textContent = '实时监听';
  } catch {
    $('liveStatus').textContent = '轮询模式';
    $('liveDot').classList.add('stale');
  }

  // 15s 兜底轮询
  setInterval(async () => {
    try {
      const s = await invoke('get_snapshot');
      if (JSON.stringify(s) !== JSON.stringify(snapshot)) {
        snapshot = s;
        cacheSnapshot(snapshot);
        scheduleLiveCallDetailRefresh();
        if (!$('menuPop').hidden) return;
        renderWithFocus();
      }
    } catch {
      $('liveStatus').textContent = '连接中断';
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
      $('liveStatus').textContent = '窗口拖动不可用';
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
  $('detailSearchClear').addEventListener('click', () => {
    $('detailSearch').value = '';
    onDetailSearchInput();
    $('detailSearch').focus();
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

  // 底部渐隐与时钟
  $('content').addEventListener('scroll', updateFade);
  const tickClock = () => { $('clk').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); };
  setInterval(tickClock, 1000);
  tickClock();

  // 刷新
  $('btnRefresh').addEventListener('click', async () => {
    const btn = $('btnRefresh');
    btn.classList.add('rotating');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    $('liveStatus').textContent = '正在刷新';
    try {
      snapshot = await invoke('get_snapshot');
      cacheSnapshot(snapshot);
      renderWithFocus();
      // 高频知识同步强刷
      await loadTopKnowledge(true);
      if (!view) renderOverview();
      $('liveStatus').textContent = `已更新 ${fmtClock2(new Date().toISOString())}`;
    } catch (err) {
      $('liveStatus').textContent = `刷新失败${err && err.message ? ' · ' + err.message : ''}`;
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
      $('liveStatus').textContent = '置顶设置失败';
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
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
      $('liveStatus').textContent = `已添加工程 ${(config.roots || []).length} 个`;
    } catch {
      $('liveStatus').textContent = '目录无效，请重试';
    } finally {
      btn.disabled = false;
    }
  });
  // 底部工作空间选择按钮
  $('btnWs').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWsPop();
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

  // 主题（点击 + radiogroup 方向键，roving tabindex）
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
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (!path) return;
    try {
      config = await invoke('set_wallpaper', { path });
      applyWallpaper(config);
      updateWallpaperUI();
      $('liveStatus').textContent = '壁纸已应用';
    } catch {
      $('liveStatus').textContent = '壁纸文件不可用';
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
      } catch { /* 保留当前预览 */ }
    }, 80);
  });
  $('btnWallpaperClear').addEventListener('click', async () => {
    try {
      config = await invoke('clear_wallpaper');
      applyWallpaper(config);
      updateWallpaperUI();
      $('liveStatus').textContent = '壁纸已清除';
    } catch {
      $('liveStatus').textContent = '清除失败';
    }
  });

  // 胶囊 → 卡片
  $('capSessionPanel').title = '切回完整窗口';

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
      const focusables = Array.from($('menuPop').querySelectorAll('button:not([disabled]), input[type="range"]')).filter((n) => !n.hidden);
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
  $('btnTop').querySelector('i').textContent = flag ? '开' : '关';
  $('btnCapTop').setAttribute('aria-checked', String(flag));
  $('btnCapTop').querySelector('i').textContent = flag ? '开' : '关';
}

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
    $('liveStatus').textContent = '壁纸文件不存在，已回退主题';
  };
  probe.src = url;
}

function renderRootList() {
  const box = $('rootList');
  box.innerHTML = '';
  if (!workspaces.length) {
    box.appendChild(el('div', 'mp-label', '未发现工作空间'));
    return;
  }
  for (const ws of workspaces) {
    const row = el('button', `mp-row${ws.active ? ' active-ws' : ''}`);
    row.type = 'button';
    row.title = ws.active ? `${ws.name}（当前）` : `切换到 ${ws.name}`;
    row.setAttribute('aria-label', `工作空间：${ws.name}${ws.active ? '（当前）' : ''}`);
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
        $('liveStatus').textContent = `已切换：${ws.name}`;
        fitWindow();
      } catch {
        $('liveStatus').textContent = '切换失败';
      }
    });
    // 删除（仅 root 来源）
    if (ws.source === 'root' && config?.roots?.includes(ws.path)) {
      const trash = el('span', 'ws-trash', '');
      trash.title = '移除工程目录';
      trash.setAttribute('role', 'button');
      trash.setAttribute('aria-label', `移除工程目录：${ws.name}`);
      trash.appendChild(svg('i-trash', 11));
      trash.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(`从侧边栏移除工程目录？\n${ws.path}`)) return;
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
    row.appendChild(el('span', 'ws-item-src', ws.source === 'root' ? '根' : '自动'));
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
        $('liveStatus').textContent = `已切换：${ws.name}`;
        fitWindow();
      } catch {
        $('liveStatus').textContent = '切换失败';
      }
    });
    list.appendChild(row);
  }
}

/** 切换到下一个工作空间（胶囊 chip 循环） */
async function cycleWorkspace() {
  if (workspaces.length < 2) {
    $('liveStatus').textContent = workspaces.length === 1 ? '仅一个工作空间' : '无可用工作空间';
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
    $('liveStatus').textContent = `已切换：${next.name}`;
    fitWindow();
  } catch {
    $('liveStatus').textContent = '切换失败';
  }
}

// ---------------------------------------------------------------------------
// 渲染主入口
// ---------------------------------------------------------------------------

function render() {
  if (!snapshot) return;
  $('wsChip').textContent = snapshot.workspace || '未连接';
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
  d.appendChild(el('div', '', text || '未找到匹配内容'));
  d.appendChild(el('div', 'empty-hint', '换个关键词试试，或清除搜索'));
  return d;
}

/** 调用匹配：提示词 / 模型 / 工具 / execId / 模式 / 目录 */
function matchCall(c, q) {
  if (!q) return true;
  return [c.prompt, c.lastOutputPreview, c.model, c.tool, c.execId, c.mode, c.workDir]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

/** 会话匹配：ID / 意图 / 工程 / 状态 / 最新 Run */
function matchSession(s, q) {
  if (!q) return true;
  const run = s.latest_run || {};
  const hay = [s.session_id, s.intent, s.project, s.status, run.command, run.verdict, run.status, run.run_id, run.handoff_summary]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
  return hay;
}

/** Run 匹配：序号 / 命令 / run_id / verdict / 交接 / 决策 / 疑虑 / 门禁 */
function runMatches(run, q) {
  if (!q) return true;
  const parts = [
    run.sequence, run.command, run.platform, run.run_id, run.verdict, run.status,
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
    { label: '运行中', value: runningTotal, tone: 'live' },
    { label: '异常', value: failedSessions + failedCalls, tone: failedSessions + failedCalls ? 'warn' : '' },
  ]);
  const knowledge = snapshot.knowledge || {};
  $('ovTopKbCount').textContent = String(knowledge.total || 0);
  renderOverviewStats($('ovTopKbStats'), [
    { label: '规格', value: knowledge.specs || 0 },
    { label: '记忆', value: knowledge.memory || 0 },
    { label: 'Know-how', value: knowledge.knowhow || 0 },
    { label: 'Learning', value: knowledge.learning_rows || 0 },
  ]);
  const rBody = $('ovRunningBody');
  rBody.innerHTML = '';
  if (!runningSessions.length && !runningCalls.length) {
    rBody.appendChild(el('div', 'ov-empty', '当前无运行中的 Agent / 会话'));
  } else {
    for (const s of runningSessions.slice(0, 2)) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = `打开会话 ${s.session_id}`;
      const dot = el('span', 'dot pulse');
      dot.style.setProperty('--c', 'var(--ok)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', '会话'));
      txt.appendChild(el('span', 'ov-row-b', oneLine(s.intent) || s.session_id));
      row.appendChild(txt);
      row.addEventListener('click', () => openDetail('session', s.session_id, row));
      rBody.appendChild(row);
    }
    for (const c of runningCalls.slice(0, 2)) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = `打开调用 ${c.execId}`;
      const dot = el('span', 'dot pulse');
      dot.style.setProperty('--c', TOOL_COLORS[c.tool] || 'var(--ok)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', TOOL_LABEL[c.tool] || c.tool || 'Agent'));
      txt.appendChild(el('span', 'ov-row-b', oneLine(c.prompt) || '无提示词'));
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
    kbBody.appendChild(el('div', 'ov-empty', '暂无高频知识沉淀'));
  } else {
    for (const item of kb) {
      const row = el('button', 'ov-row');
      row.type = 'button';
      row.title = `打开知识条目 ${item.id}（使用 ${item.frequency} 次）`;
      const dot = el('span', 'lg-dot');
      dot.style.setProperty('--c', 'var(--accent)');
      row.appendChild(dot);
      const txt = el('div', 'ov-row-t');
      txt.appendChild(el('span', 'ov-row-a', item.title || item.id));
      txt.appendChild(el('span', 'ov-row-b', item.summary ? oneLine(item.summary) : `使用 ${item.frequency} 次`));
      row.appendChild(txt);
      const freq = el('span', 'ov-freq', `×${item.frequency ?? '—'}`);
      freq.title = `调用频次 ${item.frequency}`;
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
  if (view.kind === 'call') renderCallDetail();
  else if (view.kind === 'calls') renderCallsListDetail();
  else if (view.kind === 'session') renderSessionDetail();
  else if (view.kind === 'sessions') renderSessionsListDetail();
  else if (view.kind === 'knowledge') renderKnowledgeDetail();
  else renderKnowledgeItemDetail();
  scheduleFade();
}

/** 详情搜索栏可见性 + 占位符随视图类型切换 */
function updateDetailSearchUI() {
  const row = $('detailSearchRow');
  const input = $('detailSearch');
  row.hidden = !view;
  if (!view) return;
  const ph = {
    call: '搜索对话 / 提示词…',
    calls: '搜索 Agent 调用…',
    session: '搜索 Run / 编排步骤…',
    sessions: '搜索会话 / Run…',
    knowledge: '搜索知识条目…',
    'knowledge-item': '搜索全文…',
  };
  input.placeholder = ph[view.kind] || '搜索…';
  $('detailSearchCount').hidden = !detailSearch;
}

// ---------------------------------------------------------------------------
// Agent 调用（列表）
// ---------------------------------------------------------------------------

function renderCalls() {
  const all = snapshot.calls || [];
  const q = listSearch.calls;
  const calls = q ? all.filter((c) => matchCall(c, q)) : all;
  $('callsCount').textContent = q ? `${calls.length}/${all.length}` : String(all.length);
  const searching = Boolean(q);
  $('callsEmpty').hidden = all.length > 0 && !(searching && !calls.length);
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
    hm.appendChild(document.createTextNode(`运行 ${runningCount}`));
    meta.appendChild(hm);
    $('headCalls').insertBefore(meta, $('callsCount'));
  }
  const list = $('callsList');
  list.innerHTML = '';
  const visibleCalls = searching || callsExpanded ? calls : calls.slice(0, CALLS_LIMIT);
  for (const call of visibleCalls) list.appendChild(callRowEl(call, q));
  if (!all.length) {
    const empty = $('callsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-activity', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', '暂无 Agent 调用'));
    empty.appendChild(el('div', 'empty-hint', '运行一个 Agent，这里就会亮起来'));
  } else if (searching && !calls.length) {
    const empty = $('callsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-search', 18));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', `未找到匹配的调用`));
    empty.appendChild(el('div', 'empty-hint', '换个关键词试试（提示词 / 模型 / 工具）'));
  }
  const foot = $('callsFoot');
  foot.innerHTML = '';
  if (calls.length > CALLS_LIMIT && !searching) {
    foot.hidden = false;
    const expand = el('button', 'expand-btn', callsExpanded ? '收起 ↑' : `展开全部 ${calls.length} 条 ↓`);
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

/** 单条调用行（列表视图与「全部调用」详情视图共用） */
function callRowEl(call, q) {
  const running = callStatus(call) === 'running';
  const item = el('button', 'row');
  item.type = 'button';
  item.title = oneLine(call.prompt) || '调用';
  item.setAttribute('aria-label', `${TOOL_LABEL[call.tool] || call.tool || 'Agent'}：${oneLine(call.prompt) || '无提示词'}，${callStatusLabel(call)}`);
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
  rp.appendChild(highlightText(livePreview || oneLine(call.prompt) || '（无提示词）', q));
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
    case 'done': return '完成';
    case 'error': return '失败';
    case 'cancel': return '取消';
    case 'queued': return '排队';
    case 'unknown': return call.delegateStatus || '未知';
    default: return '运行中';
  }
}

// ---------------------------------------------------------------------------
// Session · Run（列表 + 时间线展开）
// ---------------------------------------------------------------------------

function sessionStatusMeta(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'active' || s === 'executing') return ['st-running', '运行中', true, 'var(--ok)'];
  if (s === 'sealed' || s === 'completed' || s === 'done') return ['st-queued', '已封存', false, 'var(--info)'];
  if (s === 'paused') return ['st-cancel', '已暂停', false, 'var(--warn)'];
  if (s === 'failed' || s === 'blocked' || s === 'error') return ['st-error', '失败', false, 'var(--danger)'];
  return ['st-unknown', '未知', false, 'var(--text-dim)'];
}

function miniTlNode(run) {
  const vc = VERDICT_COLOR[String(run.verdict || run.status || '').toLowerCase()] || 'var(--text-dim)';
  const running = String(run.status || '').toLowerCase() === 'running';
  const node = el('div', 'tln');
  const d = el('span', `tld${running ? ' pulse' : ''}`);
  d.style.setProperty('--c', vc);
  node.appendChild(d);
  const tlc = el('div', 'tlc');
  const tlh = el('div', 'tlh');
  const cmd = el('span', 'tlh-cmd', `#${run.sequence ?? '—'} ${run.command || 'run'}`);
  cmd.title = `${run.run_id || ''} · ${run.verdict || run.status || ''}`;
  tlh.appendChild(cmd);
  if (run.platform) tlh.appendChild(el('span', 'bd bd-dim', run.platform));
  const v = el('span', `bd ${verdictClass(run.verdict)}`, verdictLabel(run.verdict));
  v.title = run.verdict || run.status || 'unknown';
  tlh.appendChild(v);
  tlh.appendChild(el('span', 'rt', `${fmtClock2(run.started_at)}${run.duration_secs != null ? ` · ${run.duration_secs}s` : ''}`));
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
    if (['running', 'active', 'executing'].includes(st)) statusCounts.running++;
    else if (['sealed', 'completed', 'done'].includes(st)) statusCounts.sealed++;
    else if (st === 'paused') statusCounts.paused++;
    else if (['failed', 'blocked', 'error'].includes(st)) statusCounts.failed++;
  }
  const statusChips = [];
  if (statusCounts.running) statusChips.push(['run', `运行 ${statusCounts.running}`]);
  if (statusCounts.paused) statusChips.push(['', `暂停 ${statusCounts.paused}`]);
  if (statusCounts.failed) statusChips.push(['fail', `失败 ${statusCounts.failed}`]);
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
    empty.appendChild(el('div', '', '暂无会话'));
    empty.appendChild(el('div', 'empty-hint', '运行一次 Maestro 流程后，会话会出现在这里'));
  } else if (searching && !sessions.length) {
    const empty = $('sessionsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-search', 18));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', '未找到匹配的会话'));
    empty.appendChild(el('div', 'empty-hint', '换个关键词试试（ID / 意图 / Run）'));
  }
  const active = snapshot.active_session_id;
  const orderedSessions = sessions.slice().sort((a, b) => Number(b.session_id === active) - Number(a.session_id === active));
  const visibleSessions = searching || sessionsListExpanded ? orderedSessions : orderedSessions.slice(0, SESSIONS_LIMIT);

  for (const s of visibleSessions) {
    list.appendChild(sessionRowEl(s, s.session_id === active));
  }
  const foot = $('sessionsFoot');
  foot.innerHTML = '';
  if (sessions.length > SESSIONS_LIMIT && !searching) {
    foot.hidden = false;
    const expand = el('button', 'expand-btn', sessionsListExpanded ? '收起 ↑' : `展开全部 ${sessions.length} 个会话 ↓`);
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
  const expanded = expandedSessions.has(s.session_id);
  const loadState = sessionLoadState[s.session_id] || 'collapsed';
  const sm = sessionStatusMeta(s.status);
  const lr = s.latest_run || null;
  const timelineId = `session-runs-${safeDomId(s.session_id)}`;
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
    proj.title = `工程：${s.project}`;
    rl.appendChild(proj);
  }
  if (isActive) rl.appendChild(el('span', 'bd bd-accent', 'ACTIVE'));
  rl.appendChild(el('span', 'rl-spacer'));
  rl.appendChild(el('span', `bd ${sm[0]}`, sm[1]));
  toggle.appendChild(rl);
  const sl2 = el('div', 'sl2');
  sl2.appendChild(el('span', 'si', oneLine(s.intent) || '无意图'));
  toggle.appendChild(sl2);
  const sl3 = el('div', 'sl3');
  const slat = el('span', 'slat');
  if (lr) {
    const vc = VERDICT_COLOR[String(lr.verdict || lr.status || '').toLowerCase()] || 'var(--text-dim)';
    slat.append(`第 ${lr.sequence ?? '—'}/${s.run_count || '—'} 步 · ${lr.command || 'run'} · `);
    const v = el('span', 'slat-v', verdictLabel(lr.verdict));
    v.style.color = vc;
    v.title = `${lr.run_id || ''} · ${lr.verdict || lr.status || ''}`;
    slat.appendChild(v);
    slat.append(` · ${fmtAgo(lr.started_at)}${lr.duration_secs != null ? ` · ${lr.duration_secs}s` : ''}`);
  } else {
    slat.textContent = `${s.run_count || 0} runs · 无 Run 数据`;
  }
  sl3.appendChild(slat);
  const chev = el('span', 'schev');
  chev.appendChild(svg('i-chevron', 10));
  sl3.appendChild(chev);
  toggle.appendChild(sl3);
  toggle.addEventListener('click', () => toggleSessionExpand(s.session_id));
  item.appendChild(toggle);

  const sexpb = el('div', 'sexpb');
  const sbi = el('div', 'sbi');
  const sexp = el('div', 'sexp');
  const tl = el('div', 'mini-tl');
  tl.id = timelineId;
  tl.setAttribute('role', 'region');
  tl.setAttribute('aria-label', `${s.session_id} Run 时间线`);
  tl.setAttribute('aria-busy', String(loadState === 'loading'));
  const MINI_TL_CAP = 8;
  const cached = sessionRunCache[s.session_id];
  const runs = expanded && cached?.length ? cached.slice(-MINI_TL_CAP) : (lr ? [lr] : []);
  for (const run of runs) tl.appendChild(miniTlNode(run));
  if (expanded && cached && cached.length > MINI_TL_CAP) {
    tl.appendChild(el('div', 'timeline-limit', `仅展示最近 ${MINI_TL_CAP} 个 Run，共 ${cached.length} 个`));
  }
  if (loadState === 'loading') tl.appendChild(el('div', 'run-inline-status', '正在载入历史 Run…'));
  if (loadState === 'error') tl.appendChild(el('div', 'run-inline-error', '载入失败，保留最新 Run'));
  sexp.appendChild(tl);
  const sexpf = el('div', 'sexp-f');
  const engine = s.orchestration?.engine;
  if (engine) sexpf.appendChild(el('span', 'bd bd-dim', `engine · ${engine}`));
  if (loadState === 'error') {
    const retry = el('button', 'more', '重试');
    retry.type = 'button';
    retry.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSessionExpand(s.session_id, true);
    });
    sexpf.appendChild(retry);
  }
  const more = el('button', 'more', '查看详情 ›');
  more.type = 'button';
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    openDetail('session', s.session_id, more);
  });
  sexpf.appendChild(more);
  sexp.appendChild(sexpf);
  sbi.appendChild(sexp);
  sexpb.appendChild(sbi);
  item.appendChild(sexpb);
  return item;
}

async function toggleSessionExpand(sessionId, force = false) {
  if (!force && expandedSessions.has(sessionId)) {
    expandedSessions.delete(sessionId);
    sessionLoadState[sessionId] = 'collapsed';
    renderSessions();
    fitWindow();
    return;
  }
  if (!force && sessionRunCache[sessionId]?.length) {
    expandedSessions.add(sessionId);
    sessionLoadState[sessionId] = 'expanded';
    renderSessions();
    fitWindow();
    refocusSessionToggle(sessionId);
    return;
  }
  sessionLoadState[sessionId] = 'loading';
  expandedSessions.add(sessionId);
  renderSessions();
  try {
    const runs = await invoke('get_session_runs', { sessionId });
    sessionRunCache[sessionId] = Array.isArray(runs) ? runs : [];
    expandedSessions.add(sessionId);
    sessionLoadState[sessionId] = 'expanded';
  } catch {
    // 失败保留展开状态 + 行内错误（含重试），不静默折叠
    expandedSessions.add(sessionId);
    sessionLoadState[sessionId] = 'error';
  }
  renderSessions();
  fitWindow();
  refocusSessionToggle(sessionId);
}

function refocusSessionToggle(sessionId) {
  requestAnimationFrame(() => {
    const tl = document.getElementById(`session-runs-${safeDomId(sessionId)}`);
    const toggle = tl && tl.closest('.srow')?.querySelector('.sess-toggle');
    if (toggle && toggle.isConnected) toggle.focus();
  });
}

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (s === 'running' || s === 'active' || s === 'executing') return 'sb-running';
  if (s === 'sealed' || s === 'completed' || s === 'done') return 'sb-sealed';
  if (s === 'paused') return 'sb-paused';
  if (s === 'failed' || s === 'blocked' || s === 'error') return 'sb-failed';
  return 'sb-unknown';
}
function verdictClass(v) {
  if (!v) return 'default';
  const s = String(v).toLowerCase();
  if (s === 'ready' || s === 'done') return 'v-ready';
  if (s === 'blocked' || s === 'failed') return 'v-blocked';
  if (s === 'needs-retry' || s === 'done_with_concerns' || s === 'ready_with_concerns') return 'v-retry';
  return 'default';
}

// ---------------------------------------------------------------------------
// 知识积累（五类占比）
// ---------------------------------------------------------------------------

const KNOWLEDGE_ITEMS = [
  ['specs', '规范', 'var(--accent)'],
  ['memory', '记忆', 'var(--info)'],
  ['knowhow', '诀窍', 'var(--ok)'],
  ['learning', '学习', 'var(--cyan, #22d3ee)'],
  ['issues', '问题', 'var(--danger)'],
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
    const searching = el('div', 'kb-searching', `搜索 “${q}”`);
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
        empty.appendChild(el('div', '', '未找到匹配的知识条目'));
        empty.appendChild(el('div', 'empty-hint', '换个关键词试试（标题 / ID / 标签）'));
        body.appendChild(empty);
        return;
      }
      for (const item of matched.slice(0, 8)) body.appendChild(kbEntryEl(item, q));
      const foot = el('div', 'kb-foot');
      const more = el('button', 'expand-btn', `在详情中查看全部 ${matched.length} 条 ›`);
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
    empty.appendChild(el('div', '', '暂无知识积累'));
    empty.appendChild(el('div', 'empty-hint', 'specs / memory / knowhow 沉淀后展示占比'));
    body.appendChild(empty);
    return;
  }
  const kpis = el('div', 'kpis');
  const stack = el('div', 'stack');
  const legend = el('div', 'legend');
  for (const [key, label, color] of KNOWLEDGE_ITEMS) {
    const value = knowledgeValue(k, key);
    const kpi = el('button', 'kpi');
    kpi.type = 'button';
    kpi.style.setProperty('--c', color);
    kpi.title = `${key}：${value} 条 · 点击查看条目`;
    kpi.setAttribute('aria-label', `查看${label}条目`);
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
  const all = el('button', 'expand-btn', '查看全部条目 ›');
  all.type = 'button';
  all.addEventListener('click', () => openDetail('knowledge', 'all', all));
  foot.appendChild(all);
  const create = el('button', 'expand-btn', '+ 新建条目');
  create.type = 'button';
  create.addEventListener('click', createKnowledgeItem);
  foot.appendChild(create);
  body.appendChild(foot);
}

/** 知识条目行（知识详情分组 / 区块搜索共用；点击复制 ID） */
function kbEntryEl(item, q) {
  const ke = el('button', 'ke');
  ke.type = 'button';
  ke.title = `${item.id} · ${item.status || ''}`;
  ke.setAttribute('aria-label', `复制 ${item.id}`);
  const kh = el('div', 'ke-h');
  kh.appendChild(el('span', 'ke-id', item.id || ''));
  const t = el('span', 'ke-t');
  t.appendChild(highlightText(item.title || '未命名条目', q));
  kh.appendChild(t);
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
  if (item.status) kf.appendChild(el('span', `bd ${kbStatusClass(item.status)}`, item.status));
  if (item.updated) kf.appendChild(el('span', 'rt', `${fmtAgo(item.updated)} 更新`));
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
const KB_KIND_ORDER = [['specs', '规范'], ['memory', '记忆'], ['knowhow', '诀窍'], ['learning', '学习'], ['issues', '问题']];

function renderKnowledgeDetail() {
  if (!renderDetailState('知识积累')) return;
  const body = $('detailBody');
  const items = Array.isArray(detail.items) ? detail.items : [];
  const q = detailSearch;
  const matched = q ? items.filter((it) => matchKbItem(it, q)) : items;
  $('detailTitle').textContent = '知识积累';
  $('detailKind').textContent = 'KNOWLEDGE';
  setSearchCount(matched.length, items.length);
  const sub = el('div', 'kb-sub');
  sub.textContent = 'specs 规范 / memory 记忆 / knowhow 诀窍 / learning 学习 / issues 问题 · 点击条目复制 ID';
  body.appendChild(sub);
  if (!items.length) {
    body.appendChild(el('div', 'detail-empty', '暂无知识条目。'));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult('未找到匹配的知识条目'));
    return;
  }
  const colorOf = (key) => {
    const found = KNOWLEDGE_ITEMS.find(([k]) => k === key);
    return found ? found[2] : 'var(--text-dim)';
  };
  for (const [kind, label] of KB_KIND_ORDER) {
    const group = matched.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const head = el('div', 'kg-h');
    const dot = el('i', 'lg-dot');
    dot.style.setProperty('--c', colorOf(kind));
    head.appendChild(dot);
    head.appendChild(el('span', '', label));
    head.appendChild(el('span', 'pill', String(group.length)));
    body.appendChild(head);
    for (const item of group) body.appendChild(kbEntryEl(item, q));
  }
}

/** 知识条目详情：meta 卡 + 全文（点击列表条目进入） */
function renderKnowledgeItemDetail() {
  if (!renderDetailState('知识条目')) return;
  const body = $('detailBody');
  const item = (detail && detail.item) || {};
  $('detailTitle').textContent = item.title || item.id || '知识条目';
  $('detailKind').textContent = String(item.kind || '').toUpperCase();
  const meta = el('section', 'detail-card');
  meta.appendChild(el('h2', 'd-sec-title', '条目信息'));
  meta.appendChild(detailRow('ID', item.id));
  meta.appendChild(detailRow('类型', item.kind));
  meta.appendChild(detailRow('状态', item.status || '—'));
  if (item.priority) meta.appendChild(detailRow('优先级', item.priority));
  if (item.updated) meta.appendChild(detailRow('更新', fmtFull(item.updated)));
  if (Array.isArray(item.tags) && item.tags.length) meta.appendChild(detailRow('标签', item.tags.join(' / ')));
  const copyBtn = el('button', 'retry-btn', '复制 ID');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(item.id || '');
      $('liveStatus').textContent = `已复制 ${item.id}`;
    } catch { /* 剪贴板不可用 */ }
  });
  meta.appendChild(copyBtn);
  // markdown 类条目：独立预览窗口
  if (['specs', 'memory', 'knowhow'].includes(item.kind)) {
    const pv = el('button', 'retry-btn primary', '预览 Markdown');
    pv.type = 'button';
    pv.title = '在独立窗口中打开渲染后的 Markdown';
    pv.addEventListener('click', async () => {
      try {
        await invoke('open_md_preview', { kind: item.kind, id: item.id });
      } catch {
        $('liveStatus').textContent = '预览打开失败';
      }
    });
    meta.appendChild(pv);
  }
  body.appendChild(meta);
  const content = String(item.content || '');
  const q = detailSearch;
  const lines = content.split('\n');
  const matchedLines = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  setSearchCount(matchedLines.length, lines.length);
  if (!content) {
    body.appendChild(el('div', 'detail-empty', '该条目没有可展示的正文。'));
    return;
  }
  if (q && !matchedLines.length) {
    body.appendChild(emptySearchResult('未找到匹配内容'));
    return;
  }
  const card = el('section', 'detail-card full-width');
  card.appendChild(el('h2', 'd-sec-title', q ? `全文 · 命中 ${matchedLines.length} 行` : '全文'));
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
// ---------------------------------------------------------------------------
// 详情视图
// ---------------------------------------------------------------------------

async function openDetail(kind, id, trigger = null, fromStack = false) {
  teardownCallDetailSearch();
  const requestId = ++detailRequestId;
  const key = `${kind}::${id}`;
  if (trigger) detailReturnFocus = trigger;
  if (!fromStack) viewStack.push({ kind, id });
  // 重置详情搜索
  detailSearch = '';
  const dInput = $('detailSearch');
  if (dInput.value) dInput.value = '';
  $('detailSearchClear').hidden = true;
  // 快照直供视图（全部调用 / 全部会话）：无需后端拉取
  if (kind === 'calls' || kind === 'sessions') {
    view = { kind, id };
    detail = { ok: true };
    detailStatus = 'ready';
    render();
    $('content').scrollTop = 0;
    requestAnimationFrame(() => $('detailTitle').focus());
    return;
  }
  // 已缓存 → 直接展示（返回栈回退秒开）
  if (detailCache[key]) {
    view = { kind, id };
    detail = detailCache[key];
    detailStatus = 'ready';
    render();
    $('content').scrollTop = 0;
    requestAnimationFrame(() => $('detailTitle').focus());
    return;
  }
  view = { kind, id };
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
      result = await invoke('get_session_detail', { sessionId: id });
    }
    if (requestId !== detailRequestId || view?.kind !== kind || view?.id !== id) return;
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
    openDetail(prev.kind, prev.id, null, true);
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
    $('detailTitle').textContent = '正在载入';
    const loading = el('div', 'loading-state');
    loading.appendChild(el('div', 'loading-line'));
    loading.appendChild(el('div', 'loading-line short'));
    loading.appendChild(el('div', 'loading-line'));
    body.appendChild(loading);
    return false;
  }
  if (detailStatus === 'not-found') {
    $('detailTitle').textContent = view?.kind === 'session' ? 'Session 不可用' : view?.kind === 'knowledge-item' ? '知识条目不可用' : '调用记录不可用';
    const missing = el('section', 'missing-state');
    missing.appendChild(svg('i-alert', 20));
    missing.appendChild(el('h2', 'missing-title', '未找到可读取的详情记录'));
    missing.appendChild(el('p', 'missing-copy', '记录可能来自旧版索引，或对应的元数据文件已被清理。列表快照仍会保留其最后状态。'));
    missing.appendChild(el('code', 'missing-id', view?.id || 'unknown'));
    const actions = el('div', 'missing-actions');
    const back = el('button', 'retry-btn', '返回列表');
    back.type = 'button';
    back.addEventListener('click', closeDetail);
    const retry = el('button', 'retry-btn primary', '重新读取');
    retry.type = 'button';
    retry.addEventListener('click', () => openDetail(view.kind, view.id));
    actions.appendChild(back);
    actions.appendChild(retry);
    missing.appendChild(actions);
    body.appendChild(missing);
    return false;
  }
  if (detailStatus === 'error') {
    $('detailTitle').textContent = '载入失败';
    const error = el('section', 'missing-state error');
    error.appendChild(svg('i-alert', 20));
    error.appendChild(el('h2', 'missing-title', '无法载入详情'));
    error.appendChild(el('p', 'missing-copy', detail?.error || '读取本地元数据时发生错误。'));
    const actions = el('div', 'missing-actions');
    const back = el('button', 'retry-btn', '返回列表');
    back.type = 'button';
    back.addEventListener('click', closeDetail);
    const retry = el('button', 'retry-btn primary', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => openDetail(view.kind, view.id));
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
    const head = [entry.name || '工具', entry.status].filter(Boolean).join(' · ');
    return [head, entry.result].filter(Boolean).join('\n');
  }
  if (entry.type === 'error') return entry.message || entry.content || '调用失败';
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
  const labels = {
    user_message: '用户',
    assistant_message: '助手',
    thinking: '思考',
    tool_use: '工具',
    tool_result: '工具结果',
    system_message: '系统',
    status_change: '状态',
    error: '错误',
  };
  return labels[entry.type] || entry.type || '消息';
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
      button.title = button.dataset.copyLabel || '复制';
      button.setAttribute('aria-label', button.dataset.copyLabel || '复制');
    }, 1500);
  } catch {
    $('liveStatus').textContent = '剪贴板不可用';
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
  trigger.title = `${expanded ? '收起' : '展开'}${label}`;
  trigger.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${label}`);
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
  for (const value of [call.model || '默认模型', call.mode || 'default', fmtAgo(call.lastActivityMs ? new Date(Number(call.lastActivityMs)).toISOString() : call.startedAt)]) {
    facts.appendChild(el('span', '', value));
  }
  summary.appendChild(facts);
  summary.appendChild(el('span', `bd ${callStatusClass(call)}`, callStatusLabel(call)));
  return summary;
}

function formatCallConversation(entries) {
  return entries.map((entry) => {
    const time = entry.timestamp ? fmtFull(entry.timestamp) : '无时间';
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
  trigger.title = `${expanded ? '收起' : '展开'}${callEntryRole(entry)}`;
  trigger.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${callEntryRole(entry)}`);
  trigger.setAttribute('aria-expanded', String(expanded));
  trigger.setAttribute('aria-controls', bodyId);
  trigger.appendChild(svg('i-chevron', 10));
  trigger.appendChild(el('span', 'chat-event-role', callEntryRole(entry)));
  trigger.appendChild(el('span', 'chat-event-summary', content.split('\n')[0] || '无内容'));
  if (entry.timestamp) trigger.appendChild(el('time', 'chat-event-time', fmtClock2(entry.timestamp)));
  trigger.addEventListener('click', () => {
    if (state.auxiliaryExpanded.has(key)) state.auxiliaryExpanded.delete(key);
    else state.auxiliaryExpanded.add(key);
    renderWithFocus();
  });
  head.appendChild(trigger);
  head.appendChild(copyButton(content, `复制${callEntryRole(entry)}`, `已复制${callEntryRole(entry)}`, `copy:${key}`));
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
  if (entry.type === 'assistant_message' && entry.partial) role.appendChild(el('span', 'chat-stream-label', '正在生成'));
  head.appendChild(role);
  if (entry.timestamp) head.appendChild(el('time', 'chat-time', fmtClock2(entry.timestamp)));
  head.appendChild(copyButton(content, `复制${callEntryRole(entry)}消息`, `已复制${callEntryRole(entry)}消息`, `copy:${key}`));
  bubble.appendChild(head);
  const contentId = `call-message-${safeDomId(key)}`;
  const contentDiv = el('div', `chat-content${isLong && !expanded ? ' clipped' : ''}`);
  contentDiv.id = contentId;
  contentDiv.appendChild(highlightText(expanded ? content : callMessagePreview(content), q));
  if (entry.type === 'assistant_message' && entry.partial) contentDiv.appendChild(el('span', 'chat-cursor'));
  bubble.appendChild(contentDiv);
  if (isLong && !q) {
    const more = el('button', 'chat-expand-text', expanded ? '收起' : '展开全文');
    more.type = 'button';
    more.dataset.focusKey = `expand:${key}`;
    more.setAttribute('aria-expanded', String(expanded));
    more.setAttribute('aria-controls', contentId);
    more.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${callEntryRole(entry)}消息全文`);
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
  if (!renderDetailState('AGENT 调用')) return;
  const body = $('detailBody');
  body.classList.add('call-detail-body');
  const q = detailSearch;
  const running = callStatus(call) === 'running';
  const state = getCallDetailUi(call);
  $('detailTitle').textContent = TOOL_LABEL[call.tool] || call.tool || '调用详情';

  body.appendChild(renderCallSummary(call, running));

  const contextStack = el('div', 'call-context-stack');
  const metaId = `call-meta-${safeDomId(call.execId || 'current')}`;
  const meta = callDisclosure('执行信息', metaId, state.metaExpanded, () => {
    state.metaExpanded = !state.metaExpanded;
    state.metaTouched = true;
    renderWithFocus();
  });
  meta.panel.appendChild(detailRow('模型', call.model));
  meta.panel.appendChild(detailRow('模式', call.mode));
  meta.panel.appendChild(detailRow('状态', callStatusLabel(call)));
  meta.panel.appendChild(detailRow('执行目录', call.workDir));
  meta.panel.appendChild(detailRow('开始', fmtFull(call.startedAt)));
  meta.panel.appendChild(detailRow('结束', fmtFull(call.completedAt)));
  if (call.exitCode !== null && call.exitCode !== undefined) meta.panel.appendChild(detailRow('退出码', String(call.exitCode)));
  if (call.delegateStatus) meta.panel.appendChild(detailRow('委托状态', call.delegateStatus));
  contextStack.appendChild(meta.section);

  const promptText = String(call.prompt || '');
  const promptMatch = !q || promptText.toLowerCase().includes(q);
  if (promptText && promptMatch) {
    const promptId = `call-prompt-${safeDomId(call.execId || 'current')}`;
    const promptExpanded = Boolean(q) || state.promptExpanded;
    const prompt = callDisclosure('完整提示词', promptId, promptExpanded, () => {
      state.promptExpanded = !state.promptExpanded;
      renderWithFocus();
    }, copyButton(promptText, '复制完整提示词', '已复制完整提示词', `copy:${promptId}`));
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
  title.appendChild(el('strong', '', '对话'));
  title.appendChild(el('span', '', `${entries.length}${q ? ` / ${allEntries.length}` : ' 条'}`));
  if (running) title.appendChild(el('span', 'call-chat-live', '实时'));
  toolbar.appendChild(title);

  const auxiliaryEntries = entries
    .map((entry, index) => ({ entry, key: callEntryKey(entry, index) }))
    .filter(({ entry }) => AUXILIARY_CALL_ENTRY_TYPES.has(entry.type));
  if (auxiliaryEntries.length) {
    const allAuxExpanded = auxiliaryEntries.every(({ key }) => state.auxiliaryExpanded.has(key));
    const toggleAux = el('button', 'call-toolbar-command', allAuxExpanded ? '收起事件' : '展开事件');
    toggleAux.type = 'button';
    toggleAux.dataset.focusKey = 'toggle-auxiliary-events';
    toggleAux.disabled = Boolean(q);
    toggleAux.setAttribute('aria-label', allAuxExpanded ? '收起全部辅助事件' : '展开全部辅助事件');
    toggleAux.title = q ? '搜索结果会临时展开命中事件' : (allAuxExpanded ? '收起全部辅助事件' : '展开全部辅助事件');
    toggleAux.addEventListener('click', () => {
      for (const { key } of auxiliaryEntries) {
        if (allAuxExpanded) state.auxiliaryExpanded.delete(key);
        else state.auxiliaryExpanded.add(key);
      }
      renderWithFocus();
    });
    toolbar.appendChild(toggleAux);
  }
  const conversationCopy = copyButton(formatCallConversation(entries), q ? '复制当前搜索结果' : '复制完整对话', q ? '已复制当前搜索结果' : '已复制完整对话', 'copy:conversation');
  conversationCopy.disabled = !entries.length;
  toolbar.appendChild(conversationCopy);
  chat.appendChild(toolbar);

  const scroll = el('div', 'chat-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'log');
  scroll.setAttribute('aria-label', 'Agent 对话记录');
  scroll.setAttribute('aria-live', 'polite');
  scroll.setAttribute('aria-relevant', 'additions text');
  scroll.setAttribute('aria-busy', String(running));
  if (!allEntries.length) {
    scroll.appendChild(el('div', 'detail-empty', running ? 'Agent 已连接，正在等待首个输出。' : '没有可展示的对话条目。'));
  } else if (q && !entries.length) {
    scroll.appendChild(emptySearchResult(promptMatch ? '对话中未找到匹配内容' : undefined));
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
  jump.appendChild(el('span', '', `${state.newActivityCount} 条新动态`));
  jump.type = 'button';
  jump.dataset.focusKey = 'jump-to-latest';
  jump.hidden = !state.newActivityCount;
  jump.setAttribute('aria-label', `跳到最新，${state.newActivityCount} 条新动态`);
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
  if (!renderDetailState('AGENT 调用')) return;
  const body = $('detailBody');
  const q = detailSearch;
  const calls = snapshot.calls || [];
  const matched = q ? calls.filter((c) => matchCall(c, q)) : calls;
  $('detailTitle').textContent = 'Agent 调用 · 全部';
  $('detailKind').textContent = 'AGENT';
  setSearchCount(matched.length, calls.length);
  if (!calls.length) {
    body.appendChild(el('div', 'detail-empty', '暂无 Agent 调用记录。'));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult('未找到匹配的调用'));
    return;
  }
  const rows = el('div', 'rows');
  for (const call of matched) rows.appendChild(callRowEl(call, q));
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', '点击任意调用查看完整对话与元数据'));
}

/** 全部会话详情视图（含搜索，行内可展开 Run 时间线） */
function renderSessionsListDetail() {
  if (!renderDetailState('SESSION · RUN')) return;
  const body = $('detailBody');
  const q = detailSearch;
  const sessions = snapshot.sessions || [];
  const matched = q ? sessions.filter((s) => matchSession(s, q)) : sessions;
  $('detailTitle').textContent = 'Session · Run · 全部';
  $('detailKind').textContent = 'SESSIONS';
  setSearchCount(matched.length, sessions.length);
  if (!sessions.length) {
    body.appendChild(el('div', 'detail-empty', '暂无会话记录。'));
    return;
  }
  if (q && !matched.length) {
    body.appendChild(emptySearchResult('未找到匹配的会话'));
    return;
  }
  const active = snapshot.active_session_id;
  const ordered = matched.slice().sort((a, b) => Number(b.session_id === active) - Number(a.session_id === active));
  const rows = el('div', 'rows');
  for (const s of ordered) rows.appendChild(sessionRowEl(s, s.session_id === active));
  body.appendChild(rows);
  body.appendChild(el('div', 'kb-sub', '点击会话查看完整时间线、编排链与边界契约'));
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
    block.appendChild(el('div', 'contract-empty', '未声明'));
  } else {
    const list = el('ul', 'contract-list');
    for (const item of values) list.appendChild(el('li', '', item));
    block.appendChild(list);
  }
  parent.appendChild(block);
}

function chainStepState(step, session, index, position) {
  if (step.run_id && step.run_id === session.active_run_id) return 'current';
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

function renderRunEntry(run, session, q) {
  const key = `${session.session_id}:${run.run_id}`;
  const verdict = String(run.verdict || run.status || 'unknown').toLowerCase();
  const attention = ['blocked', 'failed', 'needs-retry', 'done_with_concerns'].includes(verdict) || (run.concerns || []).length > 0;
  const current = run.run_id === session.active_run_id || String(run.status).toLowerCase() === 'running';
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
  if (run.platform) primary.appendChild(el('span', 'run-platform', run.platform));
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
  const gates = Array.isArray(run.gate_ids) ? run.gate_ids.length : 0;
  if (decisions) signals.appendChild(el('span', 'signal-chip decision', `决策 ${decisions}`));
  if (concerns) signals.appendChild(el('span', 'signal-chip concern', `疑虑 ${concerns}`));
  if (gates) signals.appendChild(el('span', 'signal-chip gate', `门禁 ${gates}`));
  if (signals.children.length) main.appendChild(signals);
  trigger.appendChild(main);

  const side = el('div', 'run-side');
  const vBadge = el('span', `run-verdict ${verdictClass(verdict)}`, verdictLabel(run.verdict));
  vBadge.title = run.verdict || run.status || 'unknown';
  side.appendChild(vBadge);
  const time = [fmtClock2(run.started_at), run.duration_secs !== null && run.duration_secs !== undefined ? `${run.duration_secs}s` : ''].filter(Boolean).join(' · ');
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
    handoff.appendChild(el('div', 'run-detail-title', '交接摘要'));
    handoff.appendChild(el('div', 'run-detail-item', String(run.handoff_summary)));
    details.appendChild(handoff);
  }
  appendRunDetailSection(details, '决策', run.decisions, 'decision');
  appendRunDetailSection(details, '疑虑与警告', run.concerns, 'concern');
  appendRunDetailSection(details, '审批门禁', run.gate_ids, 'gate');
  entry.appendChild(details);

  trigger.addEventListener('click', () => {
    runDisclosureState.set(key, !runDisclosureState.get(key));
    renderSessionDetail();
    requestAnimationFrame(() => document.querySelector(`[aria-controls="${detailId}"]`)?.focus());
  });
  return entry;
}

function renderSessionDetail() {
  if (!renderDetailState('SESSION · RUN')) return;
  const body = $('detailBody');
  const session = detail.session || {};
  const q = detailSearch;
  $('detailTitle').textContent = session.session_id || '会话详情';

  const resume = el('section', 'resume-strip');
  resume.appendChild(el('div', 'resume-intent', session.intent || '未声明会话意图'));
  const resumeMeta = el('div', 'resume-meta');
  resumeMeta.appendChild(el('span', `badge ${statusClass(session.status)}`, session.status || 'unknown'));
  resumeMeta.appendChild(el('span', 'resume-stat', `${session.run_count || 0} Runs`));
  if (session.active_run_id) {
    const active = el('span', 'resume-stat');
    active.appendChild(document.createTextNode('活动 '));
    active.appendChild(el('code', '', session.active_run_id));
    resumeMeta.appendChild(active);
  } else if (session.latest_completed_run_id) {
    const latest = el('span', 'resume-stat');
    latest.appendChild(document.createTextNode('最近完成 '));
    latest.appendChild(el('code', '', session.latest_completed_run_id));
    resumeMeta.appendChild(latest);
  }
  resume.appendChild(resumeMeta);
  body.appendChild(resume);

  const boundary = detail.boundary_contract && typeof detail.boundary_contract === 'object' ? detail.boundary_contract : {};
  const boundarySection = el('section', 'detail-section boundary-section');
  boundarySection.appendChild(el('h2', 'section-title', '边界契约 · Boundary Contract'));
  const dod = el('div', 'contract-dod');
  dod.appendChild(el('div', 'contract-label', 'Definition of Done'));
  dod.appendChild(el('div', 'contract-value', boundary.definition_of_done || '未声明'));
  boundarySection.appendChild(dod);
  const contractGrid = el('div', 'contract-grid');
  appendContractBlock(contractGrid, 'In Scope', boundary.in_scope);
  appendContractBlock(contractGrid, 'Constraints', boundary.constraints);
  if (textArray(boundary.out_of_scope).length) appendContractBlock(contractGrid, 'Out of Scope', boundary.out_of_scope, true);
  boundarySection.appendChild(contractGrid);
  body.appendChild(boundarySection);

  const orchestration = detail.orchestration && typeof detail.orchestration === 'object' ? detail.orchestration : {};
  const chain = Array.isArray(orchestration.chain) ? orchestration.chain.filter((step) => step && typeof step === 'object') : [];
  const stepMatches = (step) => {
    if (!q) return true;
    return [step.command, step.step_id, step.stage, step.goal_ref, step.run_id, step.status]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };
  const steps = chain.filter(stepMatches);
  const chainSection = el('section', 'detail-section chain-section');
  chainSection.appendChild(el('h2', 'section-title', '编排链 · Orchestration'));
  const summary = el('div', 'chain-summary');
  if (orchestration.engine) {
    summary.appendChild(document.createTextNode('引擎 '));
    summary.appendChild(el('strong', '', orchestration.engine));
  }
  if (orchestration.quality_mode) {
    summary.appendChild(document.createTextNode('质量 '));
    summary.appendChild(el('strong', '', orchestration.quality_mode));
  }
  if (chain.length) summary.appendChild(el('span', '', `${chain.length} steps`));
  chainSection.appendChild(summary);
  if (!chain.length) {
    chainSection.appendChild(el('div', 'detail-empty', '尚未定义编排步骤。'));
  } else if (q && !steps.length) {
    chainSection.appendChild(el('div', 'detail-empty', '未找到匹配的编排步骤'));
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
      id.appendChild(highlightText([step.step_id, step.stage, step.goal_ref].filter(Boolean).join(' · '), q));
      copy.appendChild(id);
      row.appendChild(copy);
      row.appendChild(el('span', 'chain-run', step.run_id || step.status || 'pending'));
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
  runSection.appendChild(el('h2', 'section-title', `Run 时间线 · ${visibleRuns.length}${q ? ` / ${runs.length}` : ''}`));
  if (allRuns.length > runs.length) runSection.appendChild(el('div', 'timeline-limit', `为保证性能，仅展示最近 ${runs.length} 个 Run。`));
  if (!runs.length) {
    runSection.appendChild(el('div', 'detail-empty', '尚无 Run 记录。'));
  } else if (q && !visibleRuns.length && !steps.length) {
    runSection.appendChild(emptySearchResult('未找到匹配的 Run'));
  } else {
    const ledger = el('div', 'run-ledger');
    for (const run of visibleRuns) ledger.appendChild(renderRunEntry(run || {}, session, q));
    runSection.appendChild(ledger);
  }
  body.appendChild(runSection);
}

// ---------------------------------------------------------------------------
// 胶囊
// ---------------------------------------------------------------------------

function renderCapsule() {
  const sessions = snapshot.sessions || [];
  const calls = snapshot.calls || [];
  const active = sessions.find((item) => item.session_id === snapshot.active_session_id) || sessions[0];
  const runningCalls = calls.filter((call) => callStatus(call) === 'running');
  const selectedCall = runningCalls[0] || calls[0] || null;
  const hasRunningAgent = runningCalls.length > 0;
  const capsule = $('capsule');
  const sub = $('capSub');
  const sessionDot = sub.querySelector('.dot');
  const progressBar = $('capProgressBar');

  let sessionSignal = 'idle';
  let sessionColor = 'var(--text-dim)';
  let sessionContextMeta = '空闲';
  if (active) {
    const run = active.latest_run || null;
    const running = ['running', 'active', 'executing'].includes(String(active.status || '').toLowerCase());
    sessionSignal = String(run?.verdict || run?.status || active.status || 'unknown').toLowerCase();
    sessionColor = VERDICT_COLOR[sessionSignal]
      || (running ? 'var(--ok)' : null)
      || (['sealed', 'completed'].includes(sessionSignal) ? 'var(--info)' : null)
      || (['paused'].includes(sessionSignal) ? 'var(--warn)' : null)
      || (['failed', 'blocked', 'error'].includes(sessionSignal) ? 'var(--danger)' : 'var(--text-dim)')
      || 'var(--text-dim)';
    $('capTitle').textContent = active.intent ? oneLine(active.intent) : active.session_id;
    const sm = sessionStatusMeta(active.status);
    $('capStatus').className = `bd ${sm[0]} cap-status`;
    $('capStatus').textContent = sm[1];
    sessionDot.style.setProperty('--c', sessionColor);
    sessionDot.classList.toggle('pulse', running);
    const platform = run?.platform ? (TOOL_LABEL[run.platform] || run.platform) : '';
    $('capSessionAgent').textContent = platform || 'Session';
    const step = run && run.sequence != null && active.run_count
      ? `${run.sequence}/${active.run_count}`
      : `#${run?.sequence ?? '—'}`;
    sessionContextMeta = run ? `${step} · ${sm[1]}` : sm[1];
    $('capSubT').textContent = run ? `${step} · ${run.command || 'run'}` : '等待 Run';
    $('capAgo').textContent = run ? fmtAgo(run.started_at) : '';
    if (run && run.sequence != null && active.run_count) {
      $('capProgress').hidden = false;
      progressBar.style.width = `${Math.min(100, Math.round((run.sequence / active.run_count) * 100))}%`;
    } else {
      $('capProgress').hidden = true;
      progressBar.style.width = '0%';
    }
    $('capSessionPanel').setAttribute('aria-label', `Session：${$('capTitle').textContent}，${sm[1]}`);
  } else {
    $('capTitle').textContent = snapshot.workspace || 'Maestro';
    $('capStatus').className = 'bd bd-dim cap-status';
    $('capStatus').textContent = '空闲';
    sessionDot.style.setProperty('--c', 'var(--text-dim)');
    sessionDot.classList.remove('pulse');
    $('capSessionAgent').textContent = 'Session';
    $('capSubT').textContent = '当前没有活动会话';
    $('capAgo').textContent = '';
    $('capProgress').hidden = true;
    progressBar.style.width = '0%';
    $('capSessionPanel').setAttribute('aria-label', '当前没有活动 Session');
  }

  if (selectedCall) {
    const running = callStatus(selectedCall) === 'running';
    const toolColor = TOOL_COLORS[selectedCall.tool] || 'var(--text-dim)';
    const toolLabel = TOOL_LABEL[selectedCall.tool] || selectedCall.tool || 'Agent';
    $('capAgentDot').classList.toggle('pulse', running);
    $('capAgentDot').style.setProperty('--c', toolColor);
    $('capAgentCli').textContent = `${toolLabel} CLI`;
    $('capAgentModel').textContent = selectedCall.model || '默认模型';
    $('capAgentStatus').className = `bd ${callStatusClass(selectedCall)}`;
    $('capAgentStatus').textContent = callStatusLabel(selectedCall);
    const activityMs = Number(selectedCall.lastActivityMs);
    const activityAt = Number.isFinite(activityMs) && activityMs > 0
      ? new Date(activityMs).toISOString()
      : selectedCall.completedAt || selectedCall.startedAt;
    $('capAgentTime').textContent = fmtAgo(activityAt);
    $('capAgentBar').style.width = running ? '100%' : '0%';
    $('capAgentBar').style.background = toolColor;
    $('capAgentPanel').setAttribute('aria-label', `${toolLabel} CLI，${selectedCall.model || '默认模型'}，${callStatusLabel(selectedCall)}`);
  } else {
    $('capAgentDot').classList.remove('pulse');
    $('capAgentDot').style.setProperty('--c', 'var(--text-dim)');
    $('capAgentCli').textContent = 'Maestro CLI';
    $('capAgentModel').textContent = '等待 Agent';
    $('capAgentStatus').className = 'bd bd-dim';
    $('capAgentStatus').textContent = '空闲';
    $('capAgentTime').textContent = '—';
    $('capAgentBar').style.width = '0%';
    $('capAgentPanel').setAttribute('aria-label', '当前没有 Agent 动态');
  }

  if (hasRunningAgent) {
    setCapsulePane('agent');
    $('capContextLabel').textContent = 'AGENT';
    $('capContextMeta').textContent = `${runningCalls.length} 运行中`;
    $('capContextDot').style.setProperty('--c', selectedCall ? (TOOL_COLORS[selectedCall.tool] || 'var(--ok)') : 'var(--ok)');
    $('capContextDot').classList.add('pulse');
  } else {
    setCapsulePane('session');
    $('capContextLabel').textContent = 'SESSION';
    $('capContextMeta').textContent = sessionContextMeta;
    $('capContextDot').style.setProperty('--c', sessionColor);
    $('capContextDot').classList.toggle('pulse', ['running', 'active', 'executing'].includes(sessionSignal));
  }

  const visibleCall = hasRunningAgent ? selectedCall : null;
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
    $('liveStatus').textContent = '编辑器已打开';
  } catch (err) {
    $('liveStatus').textContent = `编辑器打开失败：${err && err.message ? err.message : err}`;
  }
}

/** 新建 md 知识条目（创建后直接打开到编辑器窗口） */
async function createKnowledgeItem() {
  const kind = window.prompt('条目类型（specs / memory / knowhow）：', 'specs');
  if (!kind || !['specs', 'memory', 'knowhow'].includes(kind)) return;
  const title = window.prompt('条目标题：');
  if (!title) return;
  try {
    const id = await invoke('create_knowledge_item', { kind, title, content: '' });
    kbItemsPromise = null; // 条目列表失效，下次拉取
    delete detailCache['knowledge::all'];
    $('liveStatus').textContent = `已创建 ${id}`;
    await openEditor(kind, id);
  } catch (err) {
    $('liveStatus').textContent = `创建失败：${err && err.message ? err.message : err}`;
  }
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
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < -60000) return '未来';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function fmtClock(epochSeconds) {
  if (!epochSeconds) return '—';
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtClock2(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtFull(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
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

