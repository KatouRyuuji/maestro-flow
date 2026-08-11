// ===========================================================================
// Maestro Sidebar · 独立编辑器窗口逻辑
// 数据流：主窗口点击知识条目 → open_editor_tab（Rust 存 EditorState）→
// emit editor-updated → 本窗口 listen → get_editor_state 渲染 tabs。
// ===========================================================================
'use strict';

const TAURI = window.__TAURI__;
const { invoke } = TAURI?.core ?? {};
const { listen } = TAURI?.event ?? {};

// 主题跟随主窗口（共享 localStorage）
(function applyTheme() {
  const supported = ['graphite', 'mist', 'glass', 'ember', 'blueprint', 'ocean', 'sunset'];
  const aliases = { specimen: 'graphite', synthwave: 'ember' };
  const stored = aliases[localStorage.getItem('theme')] || localStorage.getItem('theme');
  document.body.dataset.theme = supported.includes(stored) ? stored : 'graphite';
})();

let state = { tabs: [], active: -1 };
let previewMode = false;
let draftSyncPromise = Promise.resolve();

const $ = (id) => document.getElementById(id);

function esc(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(x) {
  return esc(x)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMd(md) {
  let body = md;
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    const end = body.indexOf('\n---');
    if (end > 0) body = body.slice(end + 4);
  }
  const lines = body.split(/\r?\n/);
  let html = '';
  let list = null;
  let inCode = false;
  let codeBuf = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { html += '<p>' + para.map(inline).join('<br/>') + '</p>'; para = []; }
  };
  const closeList = () => {
    if (list) { html += '</' + list + '>'; list = null; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        html += '<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
        codeBuf = []; inCode = false;
      } else {
        flushPara(); closeList(); inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const t = line.trim();
    if (!t) { flushPara(); closeList(); continue; }
    if (/^#{1,6}\s/.test(t)) {
      flushPara(); closeList();
      const level = t.match(/^(#{1,6})\s/)[1].length;
      html += `<h${level}>${inline(t.replace(/^#{1,6}\s*/, ''))}</h${level}>`;
      continue;
    }
    if (/^\s*[-*+]\s/.test(t)) {
      flushPara();
      if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; }
      html += `<li>${inline(t.replace(/^\s*[-*+]\s*/, ''))}</li>`;
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(t)) {
      flushPara();
      if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; }
      html += `<li>${inline(t.replace(/^\s*\d+[.)]\s*/, ''))}</li>`;
      continue;
    }
    if (/^>\s?/.test(t)) {
      flushPara(); closeList();
      html += `<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara(); closeList();
      html += '<hr/>';
      continue;
    }
    if (/^\|.*\|$/.test(t)) {
      flushPara(); closeList();
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      html += '<table><tr>' + cells.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></table>';
      continue;
    }
    closeList();
    para.push(t);
  }
  flushPara(); closeList();
  if (inCode) html += '<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
  return html;
}

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
    $('stText').textContent = '就绪 · 点击侧边栏知识条目打开文档';
    return;
  }
  $('edContent').value = t.content;
  $('edContent').hidden = previewMode;
  $('edPreviewPane').hidden = !previewMode;
  if (previewMode) $('edPreviewPane').innerHTML = renderMd(t.content);
  $('edMeta').textContent = `${t.kind} · ${t.id}`;
  $('edDirty').textContent = t.dirty ? '未保存' : '';
  $('edPreview').textContent = previewMode ? '编辑' : '预览';
  $('stText').textContent = `${t.kind} · ${t.id}`;
}

async function save() {
  const t = tab();
  if (!t) return;
  try {
    const content = $('edContent').value;
    t.content = content;
    await draftSyncPromise.catch(() => {});
    await invoke('update_knowledge_item', { kind: t.kind, id: t.id, content });
    await invoke('editor_synced', { kind: t.kind, id: t.id, content });
    t.dirty = false;
    $('edDirty').textContent = '';
    $('stText').textContent = `已保存 ${t.id}`;
  } catch (err) {
    $('stText').textContent = `保存失败：${err && err.message ? err.message : err}`;
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
    $('stText').textContent = `已删除 ${t.id}`;
    await loadState();
    if (state.tabs.length === 0) window.close();
  } catch (err) {
    $('stText').textContent = `删除失败：${err && err.message ? err.message : err}`;
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
    $('stText').textContent = `已创建 ${id}`;
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
    $('stText').textContent = `创建失败：${err && err.message ? err.message : err}`;
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
    $('stText').textContent = `已复制 ${t.id}`;
  } catch { /* 剪贴板不可用 */ }
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
    t.content = $('edContent').value;
    t.dirty = true;
    $('edDirty').textContent = '未保存';
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
