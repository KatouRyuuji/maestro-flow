// ===========================================================================
// Maestro Sidebar · 独立编辑器窗口逻辑
// 数据流：主窗口点击知识条目 → open_editor_tab（Rust 存 EditorState）→
// emit editor-updated → 本窗口 listen → get_editor_state 渲染 tabs。
// ===========================================================================
'use strict';

const TAURI = window.__TAURI__;
const { invoke } = TAURI?.core ?? {};
const { listen } = TAURI?.event ?? {};

// 主题跟随主窗口（共享 localStorage；storage 事件实时同步主窗口切换）
function applyEditorTheme() {
  const supported = ['graphite', 'mist', 'glass', 'ember', 'blueprint', 'ocean', 'sunset'];
  const aliases = { specimen: 'graphite', synthwave: 'ember' };
  const stored = aliases[localStorage.getItem('theme')] || localStorage.getItem('theme');
  document.body.dataset.theme = supported.includes(stored) ? stored : 'graphite';
}
applyEditorTheme();
window.addEventListener('storage', (e) => {
  if (!e || e.key === null || e.key === 'theme') applyEditorTheme();
});

let state = { tabs: [], active: -1 };
let previewMode = false;
let draftSyncPromise = Promise.resolve();

const $ = (id) => document.getElementById(id);

function tab() {
  return state.tabs[state.active] || null;
}

function syncDraft(t, content) {
  const draft = { kind: t.kind, id: t.id, content };
  draftSyncPromise = draftSyncPromise
    .catch(() => {})
    .then(() => invoke('editor_changed', draft));
  return draftSyncPromise;
}

async function loadState() {
  const dirtyDrafts = new Map(
    state.tabs
      .filter((t) => t.dirty)
      .map((t) => [`${t.kind}::${t.id}`, { content: t.content, dirty: true }]),
  );
  try {
    const next = await invoke('get_editor_state');
    for (const t of next.tabs || []) {
      const draft = dirtyDrafts.get(`${t.kind}::${t.id}`);
      if (draft) Object.assign(t, draft);
    }
    state = next;
  } catch {
    // Keep the last local state: a transient IPC failure must not erase drafts.
  }
  renderTabs();
  renderBody();
}

function renderTabs() {
  const tabs = $('edTabs');
  // 保留「新建」按钮，重新插入 tab
  const newBtn = tabs.querySelector('.ed-new');
  tabs.innerHTML = '';
  state.tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ed-tab${i === state.active ? ' active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(i === state.active));
    if (t.dirty) btn.appendChild(el('i', 'ed-tab-dot'));
    const tt = el('span', 'ed-tab-t', t.title || t.id);
    tt.title = `${t.kind} · ${t.id}`;
    btn.appendChild(tt);
    const x = el('span', 'ed-tab-x', '×');
    x.title = '关闭';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      const dirty = state.tabs[i]?.dirty;
      if (dirty && !window.confirm('有未保存的修改，放弃？')) return;
      await invoke('close_editor_tab', { index: i }).catch(() => {});
      await loadState();
      if (state.tabs.length === 0) window.close();
    });
    btn.appendChild(x);
    btn.addEventListener('click', async () => {
      await invoke('set_editor_active', { index: i }).catch(() => {});
      await loadState();
    });
    tabs.appendChild(btn);
  });
  tabs.appendChild(newBtn);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 状态栏反馈：文字 + 状态点语义（ok=已同步 / warn=未保存·进行中 / error=失败） */
function setStatus(text, tone = 'ok') {
  $('stText').textContent = text;
  const dot = $('stDot');
  dot.classList.toggle('warn', tone === 'warn');
  dot.classList.toggle('error', tone === 'error');
}

function renderBody() {
  const t = tab();
  $('edSave').disabled = !t;
  $('edDelete').disabled = !t;
  if (!t) {
    $('edContent').value = '';
    $('edContent').hidden = true;
    $('edPreviewPane').hidden = true;
    $('edMeta').textContent = '';
    $('edDirty').textContent = '';
    setStatus('就绪 · 点击侧边栏知识条目打开文档');
    return;
  }
  $('edContent').value = t.content;
  $('edContent').hidden = previewMode;
  $('edPreviewPane').hidden = !previewMode;
  if (previewMode) $('edPreviewPane').innerHTML = renderMd(t.content);
  $('edMeta').textContent = `${t.kind} · ${t.id}`;
  $('edDirty').textContent = t.dirty ? '未保存' : '';
  $('edPreview').textContent = previewMode ? '编辑' : '预览';
  setStatus(`${t.kind} · ${t.id}`, t.dirty ? 'warn' : 'ok');
}

async function save() {
  const t = tab();
  if (!t) return;
  const btn = $('edSave');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  setStatus('保存中…', 'warn');
  try {
    const content = $('edContent').value;
    t.content = content;
    await draftSyncPromise.catch(() => {});
    await invoke('update_knowledge_item', { kind: t.kind, id: t.id, content });
    await invoke('editor_synced', { kind: t.kind, id: t.id, content });
    t.dirty = false;
    $('edDirty').textContent = '';
    setStatus(`已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, 'ok');
  } catch (err) {
    setStatus(`保存失败：${err && err.message ? err.message : err}`, 'error');
  } finally {
    btn.disabled = !tab();
    btn.removeAttribute('aria-busy');
  }
}

async function removeTab() {
  const t = tab();
  if (!t) return;
  if (!window.confirm(`删除知识条目？\n${t.kind} · ${t.id}`)) return;
  try {
    await invoke('delete_knowledge_item', { kind: t.kind, id: t.id });
    const idx = state.active;
    await invoke('close_editor_tab', { index: idx });
    setStatus(`已删除 ${t.id}`, 'ok');
    await loadState();
    if (state.tabs.length === 0) window.close();
  } catch (err) {
    setStatus(`删除失败：${err && err.message ? err.message : err}`, 'error');
  }
}

async function createTab() {
  const kind = window.prompt('条目类型（specs / memory / knowhow）：', 'specs');
  if (!kind || !['specs', 'memory', 'knowhow'].includes(kind)) return;
  const title = window.prompt('条目标题：');
  if (!title) return;
  try {
    const id = await invoke('create_knowledge_item', { kind, title, content: '' });
    await invoke('open_editor_tab', { kind, id });
    setStatus(`已创建 ${id}`, 'ok');
    await loadState();
    // 预填标题并聚焦
    const t = tab();
    if (t) {
      t.content = `# ${title}\n\n`;
      t.dirty = true;
      void syncDraft(t, t.content).catch(() => {});
      renderBody();
      $('edContent').focus();
    }
  } catch (err) {
    setStatus(`创建失败：${err && err.message ? err.message : err}`, 'error');
  }
}

// 事件
$('edSave').addEventListener('click', save);
$('edPreview').addEventListener('click', () => { previewMode = !previewMode; renderBody(); });
$('edCopy').addEventListener('click', async () => {
  const t = tab();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t.id);
    setStatus(`已复制 ${t.id}`, 'ok');
  } catch {
    setStatus('复制失败：剪贴板不可用', 'error');
  }
});
$('edDelete').addEventListener('click', removeTab);
$('edNew').addEventListener('click', createTab);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    const t = tab();
    if (t) {
      if (t.dirty && !window.confirm('有未保存的修改，放弃？')) return;
      invoke('close_editor_tab', { index: state.active }).then(async () => {
        await loadState();
        if (state.tabs.length === 0) window.close();
      });
    }
  }
});

// tablist 方向键导航（ArrowLeft/Right/Home/End 在 tab 间移动焦点）
$('edTabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = Array.from($('edTabs').querySelectorAll('.ed-tab'));
  if (!tabs.length) return;
  const cur = tabs.indexOf(document.activeElement);
  let next = cur;
  if (e.key === 'ArrowLeft') next = cur <= 0 ? tabs.length - 1 : cur - 1;
  else if (e.key === 'ArrowRight') next = cur === tabs.length - 1 || cur < 0 ? 0 : cur + 1;
  else if (e.key === 'Home') next = 0;
  else next = tabs.length - 1;
  e.preventDefault();
  tabs[next]?.focus();
});

// 主窗口推送更新（新 tab / 内容刷新）
if (listen) {
  listen('editor-updated', () => loadState());
}

// 窗口获得焦点时刷新（页面错过 emit 的兜底）
window.addEventListener('focus', loadState);

// Rust 侧 show 后兜底刷新（非 reload）
window.__refreshEditor = loadState;

// 预览模式下输入自动重渲染（防抖 180ms）
let prevTimer = null;
$('edContent').addEventListener('input', () => {
  const t = tab();
  if (t) {
    const wasDirty = t.dirty;
    t.content = $('edContent').value;
    t.dirty = true;
    $('edDirty').textContent = '未保存';
    if (!wasDirty) setStatus(`${t.kind} · ${t.id}`, 'warn');
    void syncDraft(t, t.content).catch(() => {});
  }
  if (previewMode) {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => {
      $('edPreviewPane').innerHTML = renderMd($('edContent').value);
    }, 180);
  }
});

loadState();
