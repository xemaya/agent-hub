const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function inline(value) {
  const codes = [];
  let text = String(value).replace(/`([^`\n]+)`/g, (_, code) => {
    const index = codes.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (match, label, url) => {
    if (!/^(https?:\/\/|mailto:|#|\/(?!\/))/i.test(url)) return match;
    return `<a href="${url}"${/^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

const listMatch = (line) => /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const headingMatch = (line) => /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
const fenceMatch = (line) => /^ {0,3}(```|~~~)/.exec(line);
const ruleMatch = (line) => /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line);
const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const tableDivider = (line) => {
  if (!line.includes('-')) return false;
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

function startsBlock(lines, index) {
  const line = lines[index];
  return headingMatch(line) || fenceMatch(line) || ruleMatch(line)
    || listMatch(line) || /^ {0,3}>/.test(line)
    || (line.includes('|') && tableDivider(lines[index + 1] ?? ''));
}

function renderBlocks(lines) {
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = fenceMatch(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(fence[1])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = headingMatch(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (ruleMatch(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^ {0,3}>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && tableDivider(lines[index + 1] ?? '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      html.push(`<div class="markdown-table"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cell) => `<td>${inline(row[cell] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const firstItem = listMatch(line);
    if (firstItem) {
      const indent = firstItem[1].length;
      const ordered = /^\d/.test(firstItem[2]);
      const items = [];
      while (index < lines.length) {
        const match = listMatch(lines[index]);
        if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered) break;
        const item = [match[3]];
        index += 1;
        while (index < lines.length) {
          const next = listMatch(lines[index]);
          if (next && next[1].length <= indent) break;
          if (!next && lines[index].trim() && lines[index].search(/\S/) <= indent) break;
          item.push(lines[index].trim() ? lines[index].slice(Math.min(indent + 2, lines[index].length)) : '');
          index += 1;
        }
        items.push(`<li>${renderBlocks(item)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join('\n')).replaceAll('\n', '<br>')}</p>`);
  }
  return html.join('');
}

export function renderMarkdown(value) {
  return `<div class="markdown-body">${renderBlocks(String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n'))}</div>`;
}
