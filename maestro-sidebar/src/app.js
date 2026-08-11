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
if (!invoke) showBootError('__TAURI__.core 缺失：Tauri API 未注入');

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let snapshot = null;          // 最近一次快照
let config = null;            // 配置（roots / always_on_top）
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

const TOOL_COLORS = {
  'claude-code': '#e08a57',
  'claude': '#e08a57',
  'codex': 'var(--info)',
  'gemini': 'var(--ok)',
  'qwen': 'var(--warn)',
  'opencode': 'var(--accent)',
};
const TOOL_LABEL = {
  'claude-code': 'Claude',
  'claude': 'Claude',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'qwen': 'Qwen',
  'opencode': 'OpenCode',
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
  renderRootList();

  // 首帧骨架：快照到达前不闪空态
  $('liveStatus').textContent = '正在加载…';
  renderSkeleton();
  try {
    snapshot = await invoke('get_snapshot');
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
      if (!$('menuPop').hidden) return;
      $('liveStatus').textContent = '实时监听';
      renderWithFocus();
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
  render();
  requestAnimationFrame(() => {
    if (focused && focused.isConnected) focused.focus();
  });
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

function bindEvents() {
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
      renderWithFocus();
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

  // 窗口工具栏：菜单 / 隐藏（托盘） / 关闭（退出）
  $('btnMenu').addEventListener('click', (e) => toggleMenu($('menuPop').hidden, e.currentTarget));
  $('btnHideWin').addEventListener('click', () => invoke('hide_window'));
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
  $('btnCapsule').addEventListener('click', async () => {
    toggleMenu(false);
    await invoke('set_window_mode', { mode: 'capsule' });
    document.body.dataset.mode = 'capsule';
    $('card').hidden = true;
    $('capsule').hidden = false;
    $('capsule').classList.add('mode-enter');
    setTimeout(() => $('capsule').classList.remove('mode-enter'), 200);
    fitWindow();
  });
  $('btnHide').addEventListener('click', () => { toggleMenu(false); invoke('hide_window'); });
  $('btnQuit').addEventListener('click', () => invoke('quit_app'));
  $('btnAddRoot').addEventListener('click', async () => {
    toggleMenu(false);
    const path = await dialogOpen({ directory: true, multiple: false });
    if (!path) return;
    const btn = $('btnAddRoot');
    btn.disabled = true;
    try {
      config = await invoke('add_root', { path });
      renderRootList();
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
  $('btnCapMenu').addEventListener('click', async (e) => {
    e.stopPropagation();
    await invoke('set_window_mode', { mode: 'card' });
    document.body.dataset.mode = 'card';
    $('capsule').hidden = true;
    $('card').hidden = false;
    $('card').classList.add('mode-enter');
    setTimeout(() => $('card').classList.remove('mode-enter'), 200);
    toggleMenu(true, $('btnMenu'));
    fitWindow();
  });

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
  $('capBody').addEventListener('click', async () => {
    await invoke('set_window_mode', { mode: 'card' });
    document.body.dataset.mode = 'card';
    $('capsule').hidden = true;
    $('card').hidden = false;
    $('card').classList.add('mode-enter');
    setTimeout(() => $('card').classList.remove('mode-enter'), 200);
    fitWindow();
  });

  // Esc 关闭菜单或返回列表；菜单打开时 Tab 焦点陷阱
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('menuPop').hidden) {
        toggleMenu(false);
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
      renderRootList();
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
  $('btnCapMenu').setAttribute('aria-expanded', String(open));
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
  if (!config || !config.roots.length) {
    box.appendChild(el('div', 'mp-label', '未添加工程'));
    return;
  }
  for (const root of config.roots) {
    const row = el('button', 'mp-row');
    row.type = 'button';
    row.setAttribute('aria-label', `移除工程目录：${root}`);
    row.title = '移除工程目录';
    row.appendChild(svg('i-trash', 12));
    const span = el('span', 'root-path', root);
    row.appendChild(span);
    row.addEventListener('click', async () => {
      if (!window.confirm(`从侧边栏移除工程目录？\n${root}`)) return;
      config = await invoke('remove_root', { path: root });
      renderRootList();
      snapshot = await invoke('get_snapshot');
      render();
    });
    box.appendChild(row);
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
    else if (view.kind === 'knowledge') renderKnowledgeDetail();
    else if (view.kind === 'knowledge-item') renderKnowledgeItemDetail();
    else renderSessionDetail();
  } else {
    $('detailView').hidden = true;
    $('listView').hidden = false;
    renderCalls();
    renderSessions();
    renderKnowledge();
  }
  renderCapsule();
  fitWindow();
  scheduleFade();
}

// ---------------------------------------------------------------------------
// Agent 调用（列表）
// ---------------------------------------------------------------------------

function renderCalls() {
  const calls = snapshot.calls || [];
  $('callsCount').textContent = String(calls.length);
  $('callsEmpty').hidden = calls.length > 0;
  // Section 头状态 chip：运行中调用数
  let meta = $('headCalls').querySelector('.sh-meta');
  if (meta) meta.remove();
  const runningCount = calls.filter((c) => callStatus(c) === 'running').length;
  if (runningCount > 0) {
    meta = el('span', 'sh-meta');
    const hm = el('span', 'hm run');
    const dot = el('i', 'hm-dot');
    dot.style.setProperty('--c', 'var(--ok)');
    hm.appendChild(dot);
    hm.appendChild(document.createTextNode(`运行 ${runningCount}`));
    meta.appendChild(hm);
    $('headCalls').appendChild(meta);
  }
  const list = $('callsList');
  list.innerHTML = '';
  const visibleCalls = callsExpanded ? calls : calls.slice(0, CALLS_LIMIT);
  for (const call of visibleCalls) {
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
    rl.appendChild(el('span', 'tool-n', TOOL_LABEL[call.tool] || call.tool || 'Agent'));
    if (call.model) rl.appendChild(el('span', 'model', call.model));
    const rc = el('span', 'rc');
    rc.appendChild(el('span', 'rt', fmtAgo(call.started_at)));
    rc.appendChild(el('span', `bd ${callStatusClass(call)}`, callStatusLabel(call)));
    rl.appendChild(rc);
    rb.appendChild(rl);
    rb.appendChild(el('div', 'rp', oneLine(call.prompt) || '（无提示词）'));
    item.appendChild(rb);

    item.addEventListener('click', () => openDetail('call', call.exec_id, item));
    list.appendChild(item);
  }
  if (!calls.length) {
    const empty = $('callsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-activity', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', '暂无 Agent 调用'));
    empty.appendChild(el('div', 'empty-hint', '运行一个 Agent，这里就会亮起来'));
  }
  const foot = $('callsFoot');
  foot.innerHTML = '';
  if (calls.length > CALLS_LIMIT) {
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

function callStatus(call) {
  const delegate = String(call.delegate_status || '').toLowerCase();
  if (delegate === 'cancelling' || delegate === 'cancelled') return 'cancel';
  if (delegate === 'queued') return 'queued';
  if (delegate === 'running') return 'running';
  if (call.completed_at) return call.exit_code === 0 ? 'done' : 'error';
  if (delegate) return 'unknown';
  return 'running';
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
    case 'unknown': return call.delegate_status || '未知';
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
  const sessions = snapshot.sessions || [];
  $('sessionsCount').textContent = String(sessions.length);
  $('sessionsEmpty').hidden = sessions.length > 0;
  // Section 头状态概览 chips：运行/封存/暂停/失败 一眼可见
  let meta = $('headSessions').querySelector('.sh-meta');
  if (meta) meta.remove();
  const statusCounts = { running: 0, sealed: 0, paused: 0, failed: 0 };
  for (const s of sessions) {
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
    $('headSessions').appendChild(meta);
  }
  const list = $('sessionsList');
  list.innerHTML = '';
  if (!sessions.length) {
    const empty = $('sessionsEmpty');
    empty.innerHTML = '';
    const ic = el('div', 'empty-ic');
    ic.appendChild(svg('i-session', 20));
    empty.appendChild(ic);
    empty.appendChild(el('div', '', '暂无会话'));
    empty.appendChild(el('div', 'empty-hint', '运行一次 Maestro 流程后，会话会出现在这里'));
  }
  const active = snapshot.active_session_id;
  const orderedSessions = sessions.slice().sort((a, b) => Number(b.session_id === active) - Number(a.session_id === active));
  const visibleSessions = sessionsListExpanded ? orderedSessions : orderedSessions.slice(0, SESSIONS_LIMIT);

  for (const s of visibleSessions) {
    const isActive = s.session_id === active;
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
    list.appendChild(item);
  }
  const foot = $('sessionsFoot');
  foot.innerHTML = '';
  if (sessions.length > SESSIONS_LIMIT) {
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
  $('knowledgeTotal').textContent = String(total);
  const body = $('kbBody');
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
  body.appendChild(foot);
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
  $('detailTitle').textContent = '知识积累';
  $('detailKind').textContent = 'KNOWLEDGE';
  const sub = el('div', 'kb-sub');
  sub.textContent = 'specs 规范 / memory 记忆 / knowhow 诀窍 / learning 学习 / issues 问题 · 点击条目复制 ID';
  body.appendChild(sub);
  if (!items.length) {
    body.appendChild(el('div', 'detail-empty', '暂无知识条目。'));
    return;
  }
  const colorOf = (key) => {
    const found = KNOWLEDGE_ITEMS.find(([k]) => k === key);
    return found ? found[2] : 'var(--text-dim)';
  };
  for (const [kind, label] of KB_KIND_ORDER) {
    const group = items.filter((item) => item.kind === kind);
    if (!group.length) continue;
    const head = el('div', 'kg-h');
    const dot = el('i', 'lg-dot');
    dot.style.setProperty('--c', colorOf(kind));
    head.appendChild(dot);
    head.appendChild(el('span', '', label));
    head.appendChild(el('span', 'pill', String(group.length)));
    body.appendChild(head);
    for (const item of group) {
      const ke = el('button', 'ke');
      ke.type = 'button';
      ke.title = `${item.id} · ${item.status || ''}`;
      ke.setAttribute('aria-label', `复制 ${item.id}`);
      const kh = el('div', 'ke-h');
      kh.appendChild(el('span', 'ke-id', item.id || ''));
      kh.appendChild(el('span', 'ke-t', item.title || '未命名条目'));
      ke.appendChild(kh);
      if (item.summary) ke.appendChild(el('div', 'ke-s', oneLine(item.summary)));
      const kf = el('div', 'ke-f');
      for (const tag of (item.tags || []).slice(0, 4)) {
        kf.appendChild(el('span', 'tag', String(tag)));
      }
      if (item.status) kf.appendChild(el('span', `bd ${kbStatusClass(item.status)}`, item.status));
      if (item.updated) kf.appendChild(el('span', 'rt', `${fmtAgo(item.updated)} 更新`));
      ke.appendChild(kf);
      ke.addEventListener('click', () => openDetail('knowledge-item', `${item.kind}::${item.id}`, ke));
      body.appendChild(ke);
    }
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
  body.appendChild(meta);
  if (item.content) {
    const card = el('section', 'detail-card full-width');
    card.appendChild(el('h2', 'd-sec-title', '全文'));
    card.appendChild(el('pre', 'd-prompt', String(item.content)));
    body.appendChild(card);
  } else {
    body.appendChild(el('div', 'detail-empty', '该条目没有可展示的正文。'));
  }
}
// ---------------------------------------------------------------------------
// 详情视图
// ---------------------------------------------------------------------------

async function openDetail(kind, id, trigger = null, fromStack = false) {
  const requestId = ++detailRequestId;
  const key = `${kind}::${id}`;
  if (trigger) detailReturnFocus = trigger;
  if (!fromStack) viewStack.push({ kind, id });
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
      result = await invoke('get_knowledge_items');
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

function renderCallDetail() {
  if (!renderDetailState('AGENT 调用')) return;
  const body = $('detailBody');
  const call = detail.call || {};
  $('detailTitle').textContent = TOOL_LABEL[call.tool] || call.tool || '调用详情';

  const meta = el('section', 'detail-card');
  meta.appendChild(el('h2', 'd-sec-title', '执行信息'));
  meta.appendChild(detailRow('模型', call.model));
  meta.appendChild(detailRow('模式', call.mode));
  meta.appendChild(detailRow('状态', callStatusLabel(call)));
  meta.appendChild(detailRow('执行目录', call.work_dir));
  meta.appendChild(detailRow('开始', fmtFull(call.started_at)));
  meta.appendChild(detailRow('结束', fmtFull(call.completed_at)));
  if (call.exit_code !== null && call.exit_code !== undefined) meta.appendChild(detailRow('退出码', String(call.exit_code)));
  if (call.delegate_status) meta.appendChild(detailRow('委托状态', call.delegate_status));
  body.appendChild(meta);

  if (call.prompt) {
    const prompt = el('section', 'detail-card full-width');
    prompt.appendChild(el('h2', 'd-sec-title', '完整提示词'));
    prompt.appendChild(el('pre', 'd-prompt', call.prompt));
    body.appendChild(prompt);
  }

  const allowed = new Set(['user_message', 'assistant_message', 'tool_use', 'tool_result', 'system_message']);
  const entries = (Array.isArray(detail.entries) ? detail.entries : []).filter((entry) => entry && allowed.has(entry.type));
  const chat = el('section', 'detail-card full-width');
  chat.appendChild(el('h2', 'd-sec-title', `对话 · ${entries.length}`));
  if (!entries.length) {
    chat.appendChild(el('div', 'detail-empty', '没有可展示的对话条目。'));
  } else {
    const flow = el('div', 'chat-flow');
    for (const entry of entries) {
      const kind = entry.type === 'user_message' ? 'user' : entry.type === 'assistant_message' ? 'assistant' : 'tool';
      const bubble = el('div', `chat-bubble ${kind}`);
      bubble.appendChild(el('div', 'chat-role', kind === 'user' ? '用户' : kind === 'assistant' ? '助手' : entry.type));
      const content = String(entry.content || '');
      bubble.appendChild(el('div', 'chat-content', content.length > 600 ? `${content.slice(0, 600)}…` : content));
      if (entry.timestamp) bubble.appendChild(el('div', 'chat-time', fmtFull(entry.timestamp)));
      flow.appendChild(bubble);
    }
    chat.appendChild(flow);
  }
  body.appendChild(chat);
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

function renderRunEntry(run, session) {
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
  primary.appendChild(el('span', 'run-cmd', run.command || 'run'));
  if (run.platform) primary.appendChild(el('span', 'run-platform', run.platform));
  primary.appendChild(el('span', 'run-runid', run.run_id || '—'));
  main.appendChild(primary);
  if (run.handoff_summary) main.appendChild(el('div', 'run-handoff', oneLine(run.handoff_summary)));
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
  } else {
    const rail = el('ol', 'chain-rail');
    chain.forEach((step, index) => {
      const state = chainStepState(step, session, index, orchestration.position);
      const row = el('li', `chain-step ${state}`);
      row.appendChild(el('span', 'chain-node'));
      const copy = el('div', 'chain-copy');
      copy.appendChild(el('div', 'chain-cmd', step.command || step.step_id || `step ${index + 1}`));
      copy.appendChild(el('div', 'chain-id', [step.step_id, step.stage, step.goal_ref].filter(Boolean).join(' · ')));
      row.appendChild(copy);
      row.appendChild(el('span', 'chain-run', step.run_id || step.status || 'pending'));
      rail.appendChild(row);
    });
    chainSection.appendChild(rail);
  }
  body.appendChild(chainSection);

  const allRuns = Array.isArray(detail.runs) ? detail.runs : [];
  const runs = allRuns.length > 50 ? allRuns.slice(-50) : allRuns;
  const runSection = el('section', 'detail-section runs-section');
  runSection.appendChild(el('h2', 'section-title', `Run 时间线 · ${allRuns.length}`));
  if (allRuns.length > runs.length) runSection.appendChild(el('div', 'timeline-limit', `为保证性能，仅展示最近 ${runs.length} 个 Run。`));
  if (!runs.length) {
    runSection.appendChild(el('div', 'detail-empty', '尚无 Run 记录。'));
  } else {
    const ledger = el('div', 'run-ledger');
    for (const run of runs) ledger.appendChild(renderRunEntry(run || {}, session));
    runSection.appendChild(ledger);
  }
  body.appendChild(runSection);
}

// ---------------------------------------------------------------------------
// 胶囊
// ---------------------------------------------------------------------------

function renderCapsule() {
  const sessions = snapshot.sessions || [];
  const active = sessions.find((item) => item.session_id === snapshot.active_session_id) || sessions[0];
  const capsule = $('capsule');
  const knowledgeTotal = (snapshot.knowledge || {}).total || 0;
  const sub = $('capSub');
  const dot = sub.querySelector('.dot');
  const subT = $('capSubT');
  const vb = $('capVerdict');
  const ago = $('capAgo');
  const progressBar = $('capProgressBar');
  if (active) {
    const run = active.latest_run || null;
    const running = ['running', 'active', 'executing'].includes(String(active.status || '').toLowerCase());
    const signal = String(run?.verdict || run?.status || active.status || 'unknown').toLowerCase();
    const color = VERDICT_COLOR[signal]
      || (running ? 'var(--ok)' : null)
      || (['sealed', 'completed'].includes(signal) ? 'var(--info)' : null)
      || (['paused'].includes(signal) ? 'var(--warn)' : null)
      || (['failed', 'blocked', 'error'].includes(signal) ? 'var(--danger)' : 'var(--text-dim)')
      || 'var(--text-dim)';
    capsule.dataset.kind = signal;
    capsule.style.setProperty('--cap-color', color);
    // 行 1：意图 + 状态徽章
    $('capTitle').textContent = active.intent ? oneLine(active.intent) : active.session_id;
    const sm = sessionStatusMeta(active.status);
    const stBadge = $('capStatus');
    stBadge.className = `bd ${sm[0]} cap-status`;
    stBadge.textContent = sm[1];
    // 行 2：run 故事 + verdict 徽章 + 相对时间（静态元素原地更新）
    dot.style.setProperty('--c', color);
    dot.classList.toggle('pulse', running);
    const step = run && run.sequence != null && active.run_count
      ? `第 ${run.sequence}/${active.run_count} 步`
      : `#${run?.sequence ?? '—'}`;
    subT.textContent = run ? `${step} · ${run.command || 'run'}` : '等待 Run';
    subT.title = run ? `${run.run_id || ''} · ${run.verdict || ''}` : '';
    if (run && run.verdict) {
      vb.hidden = false;
      vb.className = `bd ${verdictClass(run.verdict)}`;
      vb.textContent = verdictLabel(run.verdict);
      vb.title = run.verdict;
    } else {
      vb.hidden = true;
    }
    ago.textContent = run ? fmtAgo(run.started_at) : '';
    // 行 3：进度
    if (run && run.sequence != null && active.run_count) {
      $('capProgress').hidden = false;
      progressBar.style.width = `${Math.min(100, Math.round((run.sequence / active.run_count) * 100))}%`;
    } else {
      $('capProgress').hidden = true;
      progressBar.style.width = '0%';
    }
    const total = sessions.length;
    $('capSessions').textContent = total >= 40 ? '40+ 会话' : `${total} 会话`;
    $('capBody').setAttribute('aria-label', `打开活动会话：${$('capTitle').textContent}`);
  } else {
    capsule.dataset.kind = 'idle';
    capsule.style.setProperty('--cap-color', 'var(--text-dim)');
    $('capTitle').textContent = snapshot.workspace || 'Maestro';
    const stBadge = $('capStatus');
    stBadge.className = 'bd bd-dim cap-status';
    stBadge.textContent = '空闲';
    dot.style.setProperty('--c', 'var(--text-dim)');
    dot.classList.remove('pulse');
    subT.textContent = '当前没有活动会话';
    subT.title = '';
    vb.hidden = true;
    ago.textContent = '';
    $('capProgress').hidden = true;
    progressBar.style.width = '0%';
    $('capSessions').textContent = '0 会话';
    $('capBody').setAttribute('aria-label', '打开完整卡片视图');
  }
  $('capKnowledge').textContent = `${knowledgeTotal} 知识`;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

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
    if (document.body.dataset.mode !== 'card') return;
    if (view) return; // 详情视图：不随内容拉高窗口，由 .content 内部滚动
    const content = document.querySelector('.content');
    const h = content ? content.scrollHeight + 46 + 32 + 22 : document.documentElement.scrollHeight;
    invoke('fit_window_height', { height: h }).catch(() => {});
  }, 120);
}

init().catch((err) => {
  showBootError(`init failed: ${err && err.message ? err.message : String(err)}`);
});
