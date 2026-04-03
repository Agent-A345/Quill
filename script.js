/**
 * QUILL MARKDOWN EDITOR — script.js
 * Pure vanilla JS. No external dependencies.
 * Features: Custom MD parser, multi-doc, syntax highlighting,
 *   scroll sync, dark/light mode, autosave, export, XSS sanitization.
 */

// ============================================================
// 0. CONSTANTS & STATE
// ============================================================
const STORAGE_KEY   = 'quill_docs_v2';
const DEBOUNCE_MS   = 180;
const DEFAULT_CONTENT = `# Welcome to Quill ✦

A beautiful, **offline-first** Markdown editor. No accounts, no sync, no nonsense.

## Features

- ✦ Live preview with scroll sync
- ✦ Multi-document with auto-save
- ✦ GitHub-flavored Markdown (tables, tasks, strikethrough)
- ✦ Syntax highlighting for code blocks
- ✦ Dark & light themes

## Quick Syntax Reference

**Bold**, *italic*, ~~strikethrough~~, \`inline code\`

### Code Block

\`\`\`javascript
function greet(name) {
  // Say hello
  const msg = \`Hello, \${name}!\`;
  console.log(msg);
  return msg;
}
\`\`\`

### Table

| Feature       | Status  | Notes              |
|---------------|---------|--------------------|
| Live Preview  | ✅ Done  | Scroll synced       |
| Multi-doc     | ✅ Done  | localStorage        |
| Export        | ✅ Done  | MD, HTML, PDF       |

### Task List

- [x] Build custom MD parser
- [x] Add syntax highlighting
- [ ] World domination

### Blockquote

> The best tool is the one that gets out of your way.
> — A writer, probably

---

Start writing on the left. Your work saves automatically.
`;

let state = {
  docs: [],       // [{ id, name, content, updatedAt }]
  activeId: null,
  sidebarOpen: true,
  theme: 'dark',
  saveTimer: null,
  debounceTimer: null,
  scrollSync: true,
  editorW: null,   // px width of editor pane (null = default)
};

// ============================================================
// 1. DOM REFS
// ============================================================
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const editor          = $('#editor');
const preview         = $('#preview');
const previewScroll   = $('#previewScroll');
const lineNumbers     = $('#lineNumbers');
const docList         = $('#docList');
const sidebar         = $('#sidebar');
const docTitleDisplay = $('#docTitleDisplay');
const savedStatus     = $('#savedStatus');
const toast           = $('#toast');
const renameModal     = $('#renameModal');
const renameInput     = $('#renameInput');
const exportMenu      = $('#exportMenu');

// ============================================================
// 2. SANITIZER (XSS prevention — DOMPurify-inspired)
// ============================================================
const ALLOWED_TAGS = new Set([
  'p','h1','h2','h3','h4','h5','h6','br','hr',
  'strong','em','del','s','u','mark','sup','sub',
  'a','img',
  'ul','ol','li','input',
  'blockquote',
  'pre','code','kbd','samp',
  'table','thead','tbody','tr','th','td',
  'div','span',
  'details','summary',
]);

const ALLOWED_ATTRS = {
  '*':      ['class','id','style'],
  'a':      ['href','title','target','rel'],
  'img':    ['src','alt','title','width','height'],
  'input':  ['type','checked','disabled'],
  'td':     ['align','colspan','rowspan'],
  'th':     ['align','colspan','rowspan'],
  'code':   ['class'],
  'pre':    ['class'],
  'div':    ['class','data-lang'],
  'span':   ['class'],
};

function sanitizeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node;

  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      const frag = document.createDocumentFragment();
      [...node.childNodes].forEach(c => frag.appendChild(sanitizeNode(c)));
      return frag;
    }

    // Remove dangerous attributes
    const toRemove = [];
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      const val  = attr.value;

      const allowed = ALLOWED_ATTRS[tag] || [];
      const allowedAll = ALLOWED_ATTRS['*'] || [];

      if (!allowed.includes(name) && !allowedAll.includes(name)) {
        toRemove.push(name);
        continue;
      }

      // Block javascript: and data: in hrefs/srcs
      if ((name === 'href' || name === 'src') &&
          /^\s*(javascript|data|vbscript):/i.test(val)) {
        toRemove.push(name);
        continue;
      }

      // Block on* event handlers in style
      if (name === 'style' && /expression\s*\(|javascript:/i.test(val)) {
        toRemove.push(name);
      }
    }
    toRemove.forEach(a => node.removeAttribute(a));

    // Sanitize children
    [...node.childNodes].forEach(c => {
      const cleaned = sanitizeNode(c);
      if (cleaned !== c) node.replaceChild(cleaned, c);
    });

    return node;
  }

  // Remove comments, processing instructions, etc.
  return document.createTextNode('');
}

function sanitizeHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;
  [...frag.childNodes].forEach(c => {
    const cleaned = sanitizeNode(c);
    if (cleaned !== c) frag.replaceChild(cleaned, c);
  });
  // Serialize back
  const div = document.createElement('div');
  div.appendChild(frag.cloneNode(true));
  return div.innerHTML;
}

// ============================================================
// 3. SYNTAX HIGHLIGHTER (JS, Python, HTML, CSS, Bash)
// ============================================================
function highlightCode(code, lang) {
  // Escape first
  let h = escapeHTML(code);

  const L = (lang || '').toLowerCase().trim();

  if (L === 'html' || L === 'xml' || L === 'svg') {
    // Tags + attributes + strings
    h = h
      .replace(/(&lt;\/?)([\w-]+)/g,
        (_, lt, tag) => `${lt}<span class="hl-tag">${tag}</span>`)
      .replace(/\s([\w-:@.#]+)(=)/g,
        (_, attr, eq) => ` <span class="hl-attr">${attr}</span>${eq}`)
      .replace(/(&#34;|&quot;|&#39;)[^<]*?\1/g,
        m => `<span class="hl-string">${m}</span>`)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g,
        m => `<span class="hl-comment">${m}</span>`);
    return h;
  }

  if (L === 'css' || L === 'scss') {
    h = h
      .replace(/(\/\*[\s\S]*?\*\/)/g, m => `<span class="hl-comment">${m}</span>`)
      .replace(/([.#]?[\w-]+)\s*\{/g,
        (_, sel) => `<span class="hl-tag">${sel}</span> {`)
      .replace(/([\w-]+)\s*:/g,
        (_, prop) => `<span class="hl-attr">${prop}</span>:`)
      .replace(/(&#34;.*?&#34;|&#39;.*?&#39;|".*?"|'.*?')/g,
        m => `<span class="hl-string">${m}</span>`);
    return h;
  }

  // JS / TS / Python / Bash / generic
  const keywords = L === 'python'
    ? /\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|try|except|with|as|pass|break|continue|lambda|yield|raise|del|global|nonlocal|async|await)\b/g
    : L === 'bash' || L === 'sh' || L === 'shell'
    ? /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|echo|export|local|source|exit|set|unset|readonly)\b/g
    : /\b(const|let|var|function|return|class|extends|import|export|from|default|if|else|for|while|do|switch|case|break|continue|new|this|typeof|instanceof|void|delete|null|undefined|true|false|try|catch|finally|throw|async|await|yield|of|in|super|static|get|set|type|interface|enum|namespace|declare|abstract|implements|readonly|private|public|protected)\b/g;

  h = h
    // Comments
    .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g,
      m => `<span class="hl-comment">${m}</span>`)
    // Strings (after comments)
    .replace(/(&#34;(?:[^\\&#]|\\.)*?&#34;|&#39;(?:[^\\&#]|\\.)*?&#39;|`[\s\S]*?`|&quot;.*?&quot;)/g,
      m => `<span class="hl-string">${m}</span>`)
    // Numbers
    .replace(/\b(0x[\da-fA-F]+|\d+\.?\d*([eE][+-]?\d+)?)\b/g,
      m => `<span class="hl-number">${m}</span>`)
    // Keywords
    .replace(keywords, m => `<span class="hl-keyword">${m}</span>`)
    // Functions
    .replace(/\b([\w$]+)\s*(?=\()/g,
      (_, fn) => `<span class="hl-function">${fn}</span>`);

  return h;
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// 4. MARKDOWN PARSER (Custom, ~300 lines, GitHub-flavored)
// ============================================================
function parseMarkdown(md) {
  if (!md) return '';

  let html = '';
  const lines = md.split('\n');
  let i = 0;

  // Helpers
  const peek  = () => lines[i] || '';
  const next  = () => lines[i++];

  // Inline parser — handles bold, italic, code, links, images, etc.
  function parseInline(text) {
    // Escape HTML
    let out = escapeHTML(text);

    // Inline code (backticks) — do first to prevent interference
    out = out.replace(/`([^`\n]+?)`/g,
      (_, c) => `<code>${escapeHTML(c).replace(/&amp;/g,'&amp;').replace(/&lt;/g,'&lt;')}</code>`);

    // Images before links
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const safeSrc = /^(https?:|\/|\.)/i.test(src) ? src : '';
      return `<img src="${safeSrc}" alt="${alt}" />`;
    });

    // Links
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
      const safeHref = /^(javascript|vbscript|data):/i.test(href.trim()) ? '#' : href;
      const ext = /^https?:\/\//.test(safeHref) ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${safeHref}"${ext}>${text}</a>`;
    });

    // Auto-links
    out = out.replace(/&lt;(https?:\/\/[^&]+)&gt;/g,
      (_, url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

    // Bold + Italic together (***text***)
    out = out.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
    out = out.replace(/_{3}(.+?)_{3}/g,   '<strong><em>$1</em></strong>');

    // Bold (**text** or __text__)
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__(.+?)__/g,     '<strong>$1</strong>');

    // Italic (*text* or _text_)
    out = out.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    out = out.replace(/_([^_\n]+?)_/g,   '<em>$1</em>');

    // Strikethrough
    out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Mark / highlight ==text==
    out = out.replace(/==(.+?)==/g, '<mark>$1</mark>');

    // Superscript ^text^
    out = out.replace(/\^(.+?)\^/g, '<sup>$1</sup>');

    // Subscript ~text~ (single tilde, not double)
    out = out.replace(/(?<!~)~([^~\n]+?)~(?!~)/g, '<sub>$1</sub>');

    // Hard line break (two spaces + newline handled at block level)
    out = out.replace(/  $/g, '<br>');

    return out;
  }

  // Parse table
  function parseTable(headerLine, sepLine, bodyLines) {
    const parseCells = line =>
      line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    const aligns = parseCells(sepLine).map(s => {
      if (/^:-+:$/.test(s)) return 'center';
      if (/^-+:$/.test(s))  return 'right';
      return 'left';
    });

    let t = '<table>\n<thead>\n<tr>';
    parseCells(headerLine).forEach((c, ci) => {
      const al = aligns[ci] ? ` align="${aligns[ci]}"` : '';
      t += `<th${al}>${parseInline(c)}</th>`;
    });
    t += '</tr>\n</thead>\n<tbody>\n';

    bodyLines.forEach(row => {
      t += '<tr>';
      parseCells(row).forEach((c, ci) => {
        const al = aligns[ci] ? ` align="${aligns[ci]}"` : '';
        t += `<td${al}>${parseInline(c)}</td>`;
      });
      t += '</tr>\n';
    });

    t += '</tbody>\n</table>\n';
    return t;
  }

  // Parse ordered/unordered/task lists (with nesting)
  function parseList(lines, ordered) {
    let out = ordered ? '<ol>\n' : '<ul>\n';

    let j = 0;
    while (j < lines.length) {
      const line = lines[j];

      // Match list marker
      const taskMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)/);
      const listMatch = !taskMatch && line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);

      if (taskMatch) {
        const checked = taskMatch[3].toLowerCase() === 'x';
        const content = taskMatch[4];
        out += `<li><input type="checkbox"${checked ? ' checked' : ''} disabled> ${parseInline(content)}`;
      } else if (listMatch) {
        out += `<li>${parseInline(listMatch[3])}`;
      } else {
        // Continuation or nested
        j++;
        continue;
      }

      // Check if next line is nested
      const nextLine = lines[j + 1] || '';
      const nestedMatch = nextLine.match(/^(\s{2,})([-*+]|\d+\.)\s/);
      if (nestedMatch) {
        const nested = [];
        j++;
        const indentLen = nestedMatch[1].length;
        while (j < lines.length) {
          const nl = lines[j];
          if (nl.match(/^\s{2,}/)) {
            nested.push(nl.replace(/^\s{2}/, ''));
            j++;
          } else break;
        }
        const nestedOrdered = /^\d+\./.test((nested[0] || '').replace(/^\s+/,''));
        out += '\n' + parseList(nested, nestedOrdered);
      } else {
        j++;
      }

      out += '</li>\n';
    }

    out += ordered ? '</ol>\n' : '</ul>\n';
    return out;
  }

  // Main block-level parser
  while (i < lines.length) {
    const line = lines[i];

    // --- Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- Setext-style headers (underline with === or ---)
    const nextLine = lines[i + 1] || '';
    if (/^=+$/.test(nextLine.trim()) && line.trim()) {
      html += `<h1>${parseInline(line.trim())}</h1>\n`;
      i += 2;
      continue;
    }
    if (/^-+$/.test(nextLine.trim()) && line.trim() && !line.match(/^[-*_\s]+$/)) {
      html += `<h2>${parseInline(line.trim())}</h2>\n`;
      i += 2;
      continue;
    }

    // --- ATX Headings
    const headMatch = line.match(/^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/);
    if (headMatch) {
      const level = headMatch[1].length;
      const id = headMatch[2].toLowerCase().replace(/[^\w\s-]/g,'').replace(/\s+/g,'-');
      html += `<h${level} id="${id}">${parseInline(headMatch[2])}</h${level}>\n`;
      i++;
      continue;
    }

    // --- Fenced code block ```lang
    if (line.match(/^```/)) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      const codeText = codeLines.join('\n');
      const highlighted = highlightCode(codeText, lang);
      const langLabel = lang ? `<span class="lang-label">${escapeHTML(lang)}</span>` : '';
      html += `<pre>${langLabel}<code class="language-${escapeHTML(lang)}">${highlighted}</code></pre>\n`;
      continue;
    }

    // --- Indented code block (4 spaces or 1 tab)
    if (line.match(/^( {4}|\t)/)) {
      const codeLines = [];
      while (i < lines.length && lines[i].match(/^( {4}|\t)/)) {
        codeLines.push(lines[i].replace(/^( {4}|\t)/, ''));
        i++;
      }
      html += `<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>\n`;
      continue;
    }

    // --- Horizontal rule
    if (line.match(/^([-*_]){3,}\s*$/) && line.replace(/\s/g,'').split('').every(c => c === line[0])) {
      html += '<hr>\n';
      i++;
      continue;
    }

    // --- Blockquote
    if (line.match(/^>\s?/)) {
      const bqLines = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        bqLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html += `<blockquote>${parseMarkdown(bqLines.join('\n'))}</blockquote>\n`;
      continue;
    }

    // --- Unordered list
    if (line.match(/^(\s*)([-*+])\s/)) {
      const listLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.match(/^(\s*)([-*+]|\d+\.)\s/) || (listLines.length > 0 && l.match(/^\s{2,}/))) {
          listLines.push(l);
          i++;
        } else break;
      }
      html += parseList(listLines, false);
      continue;
    }

    // --- Ordered list
    if (line.match(/^\s*\d+\.\s/)) {
      const listLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.match(/^\s*\d+\.\s/) || (listLines.length > 0 && l.match(/^\s{2,}/))) {
          listLines.push(l);
          i++;
        } else break;
      }
      html += parseList(listLines, true);
      continue;
    }

    // --- Table (| col | col |)
    if (line.includes('|') && nextLine.match(/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/)) {
      const bodyLines = [];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes('|')) {
        bodyLines.push(lines[i]);
        i++;
      }
      html += parseTable(line, nextLine, bodyLines);
      continue;
    }

    // --- HTML passthrough (raw HTML blocks)
    if (line.match(/^<(div|section|article|aside|nav|header|footer|details|summary|figure|figcaption)/i)) {
      const htmlLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        htmlLines.push(lines[i]);
        i++;
      }
      // We pass through but sanitize
      html += htmlLines.join('\n') + '\n';
      continue;
    }

    // --- Paragraph (collect consecutive non-blank, non-block lines)
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (l.match(/^(#{1,6}\s|```|>\s?|(\s*)([-*+]|\d+\.)\s|\s{4}|\t|<(div|section|article))/)) break;
      // Setext check
      const nxt = lines[i + 1] || '';
      if (/^[=\-]{3,}$/.test(nxt.trim())) break;
      paraLines.push(l);
      i++;
    }

    if (paraLines.length) {
      // Handle hard line breaks (two trailing spaces)
      const paraHTML = paraLines.map(l =>
        l.endsWith('  ') ? parseInline(l.trimEnd()) + '<br>' : parseInline(l)
      ).join('\n');
      html += `<p>${paraHTML}</p>\n`;
    } else {
      i++; // safety
    }
  }

  return html;
}

// ============================================================
// 5. DOCUMENT MANAGEMENT
// ============================================================
function loadDocs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.docs) && parsed.docs.length) {
        state.docs    = parsed.docs;
        state.activeId = parsed.activeId || state.docs[0].id;
        state.theme   = parsed.theme || 'dark';
        return;
      }
    }
  } catch (e) { /* ignore */ }

  // Fresh start
  const id = uid();
  state.docs = [{
    id,
    name: 'Getting Started',
    content: DEFAULT_CONTENT,
    updatedAt: Date.now(),
  }];
  state.activeId = id;
  state.theme    = 'dark';
}

function saveDocs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      docs:     state.docs,
      activeId: state.activeId,
      theme:    state.theme,
    }));
    showSaved(true);
  } catch (e) {
    showToast('Could not save — storage full?');
  }
}

function scheduleSave() {
  showSaved(false);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDocs, 1200);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getActiveDoc() {
  return state.docs.find(d => d.id === state.activeId);
}

function newDoc() {
  const id = uid();
  state.docs.unshift({
    id,
    name: 'Untitled',
    content: '',
    updatedAt: Date.now(),
  });
  switchDoc(id);
  saveDocs();
  renderDocList();
  // Focus editor
  editor.focus();
}

function switchDoc(id) {
  // Save current content first
  const cur = getActiveDoc();
  if (cur) cur.content = editor.value;

  state.activeId = id;
  const doc = getActiveDoc();
  if (!doc) return;

  editor.value = doc.content;
  docTitleDisplay.textContent = doc.name;
  document.title = `${doc.name} — Quill`;
  renderDocList();
  updateLineNumbers();
  renderPreview();
  updateStats();
}

function deleteDoc(id) {
  if (state.docs.length === 1) {
    showToast('Cannot delete last document');
    return;
  }
  state.docs = state.docs.filter(d => d.id !== id);
  if (state.activeId === id) {
    state.activeId = state.docs[0].id;
    switchDoc(state.activeId);
  }
  renderDocList();
  saveDocs();
}

function renameDoc(id, newName) {
  const doc = state.docs.find(d => d.id === id);
  if (doc) {
    doc.name = newName.trim() || 'Untitled';
    if (id === state.activeId) {
      docTitleDisplay.textContent = doc.name;
      document.title = `${doc.name} — Quill`;
    }
    renderDocList();
    saveDocs();
  }
}

// ============================================================
// 6. RENDER: DOC LIST
// ============================================================
function renderDocList() {
  docList.innerHTML = '';
  state.docs.forEach(doc => {
    const li = document.createElement('li');
    li.className = 'doc-item' + (doc.id === state.activeId ? ' active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', doc.id === state.activeId ? 'true' : 'false');
    li.dataset.id = doc.id;

    li.innerHTML = `
      <svg class="doc-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="doc-item-name" title="${escapeHTML(doc.name)}">${escapeHTML(doc.name)}</span>
      <button class="doc-item-del" title="Delete" aria-label="Delete document">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    li.addEventListener('click', e => {
      if (e.target.closest('.doc-item-del')) {
        e.stopPropagation();
        deleteDoc(doc.id);
        return;
      }
      switchDoc(doc.id);
    });

    li.addEventListener('dblclick', e => {
      if (!e.target.closest('.doc-item-del')) openRenameModal(doc.id);
    });

    docList.appendChild(li);
  });
}

// ============================================================
// 7. RENDER: PREVIEW
// ============================================================
function renderPreview() {
  const md  = editor.value;
  if (!md.trim()) {
    preview.innerHTML = `
      <div class="preview-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        Start writing…
      </div>`;
    return;
  }

  const rawHTML = parseMarkdown(md);
  const safe    = sanitizeHTML(rawHTML);
  preview.innerHTML = safe;
}

// ============================================================
// 8. LINE NUMBERS
// ============================================================
function updateLineNumbers() {
  const lineCount = editor.value.split('\n').length;
  let html = '';
  for (let n = 1; n <= lineCount; n++) {
    html += `<span>${n}</span>`;
  }
  lineNumbers.innerHTML = html;

  // Sync scroll
  lineNumbers.scrollTop = editor.scrollTop;
}

// ============================================================
// 9. STATS
// ============================================================
function updateStats() {
  const text  = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const lines = text.split('\n').length;
  const mins  = Math.max(1, Math.ceil(words / 150));

  $('#statusWords').textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
  $('#statusChars').textContent = `${chars.toLocaleString()} char${chars !== 1 ? 's' : ''}`;
  $('#statusLines').textContent = `${lines.toLocaleString()} line${lines !== 1 ? 's' : ''}`;
  $('#statusReadTime').textContent = `${mins} min read`;
}

function updateCursorPos() {
  const pos   = editor.selectionStart;
  const text  = editor.value.slice(0, pos);
  const line  = text.split('\n').length;
  const col   = pos - text.lastIndexOf('\n');
  $('#statusCursor').textContent = `Ln ${line}, Col ${col}`;
}

// ============================================================
// 10. SCROLL SYNC
// ============================================================
function syncScroll() {
  if (!state.scrollSync) return;
  const ratio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight || 1);
  previewScroll.scrollTop = ratio * (previewScroll.scrollHeight - previewScroll.clientHeight);
}

// ============================================================
// 11. TOOLBAR ACTIONS
// ============================================================
const SNIPPETS = {
  bold:        { wrap: '**',    placeholder: 'bold text' },
  italic:      { wrap: '*',     placeholder: 'italic text' },
  strikethrough:{ wrap: '~~',  placeholder: 'strikethrough' },
  code:        { wrap: '`',     placeholder: 'code' },
};

const LINE_PREFIXES = {
  h1:         '# ',
  h2:         '## ',
  h3:         '### ',
  ul:         '- ',
  ol:         '1. ',
  task:       '- [ ] ',
  blockquote: '> ',
};

function toolbarAction(action) {
  editor.focus();

  if (action === 'clear') {
    if (confirm('Clear this document? This cannot be undone.')) {
      editor.value = '';
      onEditorInput();
    }
    return;
  }

  if (action === 'hr') {
    insertAtCursor('\n\n---\n\n');
    return;
  }

  if (action === 'link') {
    const sel = getSelection();
    const text = sel || 'link text';
    const url  = 'https://';
    const snippet = `[${text}](${url})`;
    if (sel) {
      replaceSelection(snippet);
    } else {
      insertAtCursor(snippet);
      // Position cursor on url part
      const pos = editor.selectionStart - url.length - 1;
      editor.setSelectionRange(pos, pos + url.length);
    }
    onEditorInput();
    return;
  }

  if (action === 'image') {
    const sel = getSelection();
    const alt = sel || 'alt text';
    const snippet = `![${alt}](https://url-to-image.jpg)`;
    replaceSelection(snippet);
    onEditorInput();
    return;
  }

  if (action === 'table') {
    const tbl = '\n| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n| Cell     | Cell     | Cell     |\n| Cell     | Cell     | Cell     |\n\n';
    insertAtCursor(tbl);
    onEditorInput();
    return;
  }

  if (action === 'codeblock') {
    const sel = getSelection();
    const snippet = sel ? `\`\`\`\n${sel}\n\`\`\`` : '```javascript\n\n```';
    replaceSelection(snippet);
    if (!sel) {
      const pos = editor.selectionStart - 4;
      editor.setSelectionRange(pos, pos);
    }
    onEditorInput();
    return;
  }

  // Inline wraps
  if (SNIPPETS[action]) {
    const { wrap, placeholder } = SNIPPETS[action];
    const sel = getSelection();
    const inner = sel || placeholder;
    replaceSelection(`${wrap}${inner}${wrap}`);
    if (!sel) {
      const end   = editor.selectionStart;
      const start = end - wrap.length - placeholder.length;
      editor.setSelectionRange(start, start + placeholder.length);
    }
    onEditorInput();
    return;
  }

  // Line prefixes
  if (LINE_PREFIXES[action]) {
    const prefix = LINE_PREFIXES[action];
    const start  = editor.selectionStart;
    const end    = editor.selectionEnd;
    const text   = editor.value;

    // Find line start
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd   = text.indexOf('\n', end);
    const line      = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);

    // Toggle: if already has prefix, remove it
    if (line.startsWith(prefix)) {
      const newLine = line.slice(prefix.length);
      editor.value = text.slice(0, lineStart) + newLine + text.slice(lineEnd === -1 ? text.length : lineEnd);
      editor.setSelectionRange(start - prefix.length, end - prefix.length);
    } else {
      editor.value = text.slice(0, lineStart) + prefix + line + text.slice(lineEnd === -1 ? text.length : lineEnd);
      editor.setSelectionRange(start + prefix.length, end + prefix.length);
    }
    onEditorInput();
  }
}

function getSelection() {
  return editor.value.slice(editor.selectionStart, editor.selectionEnd);
}

function replaceSelection(text) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const val   = editor.value;
  editor.value = val.slice(0, start) + text + val.slice(end);
  editor.setSelectionRange(start + text.length, start + text.length);
}

function insertAtCursor(text) {
  const start = editor.selectionStart;
  const val   = editor.value;
  editor.value = val.slice(0, start) + text + val.slice(start);
  editor.setSelectionRange(start + text.length, start + text.length);
}

// ============================================================
// 12. THEME
// ============================================================
function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
  saveDocs();
}

// ============================================================
// 13. FULLSCREEN
// ============================================================
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    $('#fullscreenBtn .expand-icon').style.display   = 'none';
    $('#fullscreenBtn .compress-icon').style.display = 'block';
  } else {
    document.exitFullscreen().catch(() => {});
    $('#fullscreenBtn .expand-icon').style.display   = 'block';
    $('#fullscreenBtn .compress-icon').style.display = 'none';
  }
}

// ============================================================
// 14. EXPORT
// ============================================================
function exportMD() {
  const doc  = getActiveDoc();
  const name = (doc?.name || 'document').replace(/[^a-z0-9\s-]/gi, '').trim() || 'document';
  downloadText(editor.value, `${name}.md`, 'text/markdown');
}

function exportHTML() {
  const doc    = getActiveDoc();
  const name   = (doc?.name || 'document').replace(/[^a-z0-9\s-]/gi, '').trim() || 'document';
  const body   = preview.innerHTML;
  const full   = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(doc?.name || 'Document')}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 24px; line-height: 1.75; color: #1a1c24; background: #fff; }
  h1,h2,h3,h4,h5,h6 { margin: 1.5em 0 0.5em; line-height: 1.25; }
  h1 { font-size: 2em; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.2em; }
  p { margin: 0.75em 0; }
  code { background: #f0f0f0; padding: 0.15em 0.45em; border-radius: 3px; font-size: 0.88em; }
  pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 8px; padding: 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #5b8af0; padding: 6px 18px; margin: 1em 0; background: #f0f4ff; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { padding: 8px 14px; border: 1px solid #ddd; text-align: left; }
  th { background: #f6f6f6; }
  a { color: #3b6ae0; }
  img { max-width: 100%; border-radius: 6px; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  downloadText(full, `${name}.html`, 'text/html');
}

function exportPDF() {
  window.print();
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filename}`);
}

function copyHTML() {
  const html = preview.innerHTML;
  navigator.clipboard.writeText(html)
    .then(() => showToast('HTML copied to clipboard'))
    .catch(() => showToast('Copy failed — try manually'));
}

// ============================================================
// 15. UI HELPERS
// ============================================================
function showSaved(saved) {
  if (saved) {
    savedStatus.classList.remove('unsaved');
    savedStatus.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>Saved`;
  } else {
    savedStatus.classList.add('unsaved');
    savedStatus.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>Unsaved`;
  }
}

let toastTimer;
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function openRenameModal(id) {
  const doc = state.docs.find(d => d.id === id);
  if (!doc) return;
  renameModal.dataset.targetId = id;
  renameInput.value = doc.name;
  renameModal.classList.add('open');
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
}

function closeRenameModal() {
  renameModal.classList.remove('open');
}

// ============================================================
// 16. RESIZER (drag to resize panels)
// ============================================================
function initResizer() {
  const resizer     = $('#resizer');
  const editorPane  = $('.editor-pane');
  const workspace   = $('#workspace');

  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = editorPane.getBoundingClientRect().width;
    resizer.classList.add('active');
    document.body.style.userSelect  = 'none';
    document.body.style.cursor      = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta     = e.clientX - startX;
    const totalW    = workspace.getBoundingClientRect().width;
    const newW      = Math.min(Math.max(startW + delta, 200), totalW - 200);
    const pct       = (newW / totalW) * 100;
    editorPane.style.flex = `0 0 ${pct}%`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.style.userSelect = '';
    document.body.style.cursor     = '';
  });

  // Keyboard support for accessibility
  resizer.addEventListener('keydown', e => {
    const step = e.shiftKey ? 50 : 10;
    const totalW = workspace.getBoundingClientRect().width;
    const currentW = $('.editor-pane').getBoundingClientRect().width;
    let newW = currentW;

    if (e.key === 'ArrowLeft')  newW -= step;
    if (e.key === 'ArrowRight') newW += step;

    newW = Math.min(Math.max(newW, 200), totalW - 200);
    const pct = (newW / totalW) * 100;
    $('.editor-pane').style.flex = `0 0 ${pct}%`;
    e.preventDefault();
  });
}

// ============================================================
// 17. KEYBOARD SHORTCUTS
// ============================================================
function handleKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'b') { e.preventDefault(); toolbarAction('bold'); }
  if (ctrl && e.key === 'i') { e.preventDefault(); toolbarAction('italic'); }
  if (ctrl && e.key === 'k') { e.preventDefault(); toolbarAction('link'); }
  if (ctrl && e.key === 's') { e.preventDefault(); saveDocs(); showToast('Saved!'); }
  if (ctrl && e.key === 'n') { e.preventDefault(); newDoc(); }

  // Tab key in editor
  if (e.target === editor && e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    if (start === end) {
      insertAtCursor('  ');
    } else {
      // Indent selected lines
      const val   = editor.value;
      const lines = val.split('\n');
      let charCount = 0;
      let firstLine = -1;
      let lastLine  = -1;
      for (let i = 0; i < lines.length; i++) {
        if (charCount + lines[i].length >= start && firstLine === -1) firstLine = i;
        if (charCount <= end) lastLine = i;
        charCount += lines[i].length + 1;
      }
      if (e.shiftKey) {
        for (let i = firstLine; i <= lastLine; i++) {
          lines[i] = lines[i].replace(/^  /, '');
        }
      } else {
        for (let i = firstLine; i <= lastLine; i++) {
          lines[i] = '  ' + lines[i];
        }
      }
      editor.value = lines.join('\n');
    }
    onEditorInput();
  }

  // Auto-close brackets/quotes
  if (e.target === editor) {
    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
    if (pairs[e.key]) {
      const sel = getSelection();
      if (sel) {
        e.preventDefault();
        replaceSelection(`${e.key}${sel}${pairs[e.key]}`);
        onEditorInput();
      }
    }
  }
}

// ============================================================
// 18. INPUT HANDLER (debounced)
// ============================================================
function onEditorInput() {
  updateLineNumbers();
  updateStats();
  updateCursorPos();

  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    renderPreview();
    // Update doc content
    const doc = getActiveDoc();
    if (doc) doc.content = editor.value;
    scheduleSave();
  }, DEBOUNCE_MS);
}

// ============================================================
// 19. INIT
// ============================================================
function init() {
  // Load persisted data
  loadDocs();

  // Set theme
  setTheme(state.theme);

  // Populate editor with active doc
  const doc = getActiveDoc();
  if (doc) {
    editor.value         = doc.content;
    docTitleDisplay.textContent = doc.name;
    document.title       = `${doc.name} — Quill`;
  }

  // Render sidebar
  renderDocList();

  // Initial render
  updateLineNumbers();
  renderPreview();
  updateStats();
  updateCursorPos();

  // Init resizer
  initResizer();

  // ---- Event listeners ----

  // Editor input
  editor.addEventListener('input', onEditorInput);

  editor.addEventListener('scroll', () => {
    lineNumbers.scrollTop = editor.scrollTop;
    syncScroll();
  });

  editor.addEventListener('keydown', handleKeydown);

  editor.addEventListener('click', updateCursorPos);
  editor.addEventListener('keyup', updateCursorPos);

  // Toolbar buttons
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn && btn.classList.contains('tool-btn')) {
      toolbarAction(btn.dataset.action);
    }
  });

  // Sidebar toggle
  $('#sidebarToggle').addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    sidebar.classList.toggle('collapsed', !state.sidebarOpen);
  });

  // New doc button
  $('#newDocBtn').addEventListener('click', newDoc);

  // Doc title double-click = rename
  docTitleDisplay.addEventListener('dblclick', () => {
    const doc = getActiveDoc();
    if (doc) openRenameModal(doc.id);
  });

  // Theme toggle
  $('#themeToggle').addEventListener('click', toggleTheme);

  // Fullscreen
  $('#fullscreenBtn').addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    const inFS = !!document.fullscreenElement;
    $('#fullscreenBtn .expand-icon').style.display   = inFS ? 'none'  : 'block';
    $('#fullscreenBtn .compress-icon').style.display = inFS ? 'block' : 'none';
  });

  // Copy HTML
  $('#copyHtmlBtn').addEventListener('click', copyHTML);

  // Export menu toggle
  $('#exportBtn').addEventListener('click', e => {
    e.stopPropagation();
    exportMenu.classList.toggle('open');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.export-menu-wrap')) {
      exportMenu.classList.remove('open');
    }
  });

  // Export items
  document.addEventListener('click', e => {
    const item = e.target.closest('[data-export]');
    if (!item) return;
    exportMenu.classList.remove('open');
    const type = item.dataset.export;
    if (type === 'md')   exportMD();
    if (type === 'html') exportHTML();
    if (type === 'pdf')  exportPDF();
  });

  // Rename modal
  $('#renameCancelBtn').addEventListener('click', closeRenameModal);

  $('#renameConfirmBtn').addEventListener('click', () => {
    const id   = renameModal.dataset.targetId;
    const name = renameInput.value.trim() || 'Untitled';
    renameDoc(id, name);
    closeRenameModal();
  });

  renameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { $('#renameConfirmBtn').click(); }
    if (e.key === 'Escape') { closeRenameModal(); }
  });

  renameModal.addEventListener('click', e => {
    if (e.target === renameModal) closeRenameModal();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);

  // Pane label click = focus/toggle fullscreen hint
  const editorLabel  = $('.editor-pane .pane-label');
  const previewLabel = $('.preview-pane .pane-label');

  editorLabel.classList.add('fullscreen-hint');
  editorLabel.title = 'Click to focus editor';
  editorLabel.addEventListener('click', () => editor.focus());

  previewLabel.classList.add('fullscreen-hint');

  // Window unload — final save
  window.addEventListener('beforeunload', () => {
    const doc = getActiveDoc();
    if (doc) doc.content = editor.value;
    saveDocs();
  });
}

// Boot
document.addEventListener('DOMContentLoaded', init);
