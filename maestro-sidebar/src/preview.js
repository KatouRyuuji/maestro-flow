
    'use strict';
    const TAURI = window.__TAURI__;
    const { invoke } = TAURI?.core ?? {};

    // 主题跟随主窗口
    (function applyTheme() {
      const supported = ['graphite', 'mist', 'glass', 'ember', 'blueprint', 'ocean', 'sunset'];
      const aliases = { specimen: 'graphite', synthwave: 'ember' };
      const stored = aliases[localStorage.getItem('theme')] || localStorage.getItem('theme');
      document.body.dataset.theme = supported.includes(stored) ? stored : 'graphite';
    })();

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function inline(s) {
      return esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }
    function renderMd(md) {
      // 去 frontmatter
      let body = md;
      if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
        const end = body.indexOf('\n---');
        if (end > 0) body = body.slice(end + 4);
      }
      const lines = body.split(/\r?\n/);
      let html = '';
      let list = null;      // 'ul' | 'ol' | null
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

    async function load() {
      if (!invoke) {
        document.getElementById('pvBody').innerHTML = '<div class="preview-error">预览窗口必须在 Tauri 容器中运行。</div>';
        return;
      }
      try {
        const doc = await invoke('get_md_preview');
        if (!doc || !doc.content) throw new Error('empty');
        document.getElementById('pvTitle').textContent = doc.title || doc.id || '未命名';
        document.getElementById('pvKind').textContent = String(doc.kind || 'MD').toUpperCase();
        document.getElementById('pvBody').innerHTML = renderMd(doc.content);
        document.title = 'MD 预览 · ' + (doc.title || doc.id || '');
      } catch {
        document.getElementById('pvTitle').textContent = '无预览内容';
        document.getElementById('pvBody').innerHTML = '<div class="preview-error">没有可预览的文档。请先在侧边栏中打开知识条目并点击「预览 Markdown」。</div>';
      }
    }
    load();
  