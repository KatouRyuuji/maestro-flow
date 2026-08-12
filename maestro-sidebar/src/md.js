// ===========================================================================
// Maestro Sidebar · 共享 Markdown 渲染（主窗口详情预览 / 编辑器窗口预览共用）
// 轻量安全渲染：先 HTML 转义再应用 inline 标记，不执行任何脚本。
// ===========================================================================
'use strict';

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
  let table = null;
  const flushPara = () => {
    if (para.length) { html += '<p>' + para.map(inline).join('<br/>') + '</p>'; para = []; }
  };
  const closeList = () => {
    if (list) { html += '</' + list + '>'; list = null; }
  };
  // 连续管道行聚合为一个 <table>：第 2 行为分隔行时首行作 <th>，其余为 <td>
  const isSepRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
  const closeTable = () => {
    if (!table) return;
    const rows = table;
    table = null;
    let header = null;
    let bodyRows = rows;
    if (rows.length >= 2 && isSepRow(rows[1]) && !isSepRow(rows[0])) {
      header = rows[0];
      bodyRows = rows.slice(2);
    }
    bodyRows = bodyRows.filter((cells) => !isSepRow(cells));
    let out = '<table>';
    if (header) out += '<tr>' + header.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr>';
    for (const cells of bodyRows) out += '<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>';
    out += '</table>';
    html += out;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        html += '<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
        codeBuf = []; inCode = false;
      } else {
        flushPara(); closeList(); closeTable(); inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const t = line.trim();
    if (table && !/^\|.*\|$/.test(t)) closeTable();
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
      if (!table) table = [];
      table.push(t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    closeList();
    para.push(t);
  }
  flushPara(); closeList(); closeTable();
  if (inCode) html += '<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
  return html;
}
