// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A small Markdown renderer for the assistant's answers.
 *
 * Model output is untrusted, so this never touches innerHTML: it builds DOM nodes and
 * every piece of text goes in through `textContent`. Links are kept only for http(s)
 * URLs and open in a new tab without an opener. HTML in the source stays literal text.
 *
 * Covered, because chat answers use them: paragraphs (a single newline is a line break,
 * as in chat), ATX headings, fenced code, bullet/numbered lists with nesting by indent,
 * block quotes, GFM tables, horizontal rules, and inline code, bold, italic,
 * strikethrough and links. It also has to render half-written input on every streamed
 * chunk: an unterminated fence shows as code so far, an unclosed `**` stays literal.
 */

const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Render Markdown source into a fragment of safe DOM nodes. */
export function renderMarkdown(src: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++;   // the closing fence, or past the end while still streaming
      const pre = el('pre');
      const code = el('code', body.join('\n'));
      if (fence[2]) code.dataset.lang = fence[2];
      pre.appendChild(code);
      out.appendChild(pre);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(6, h[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      const head = el(`h${level}`);
      head.appendChild(renderInline(h[2]!));
      out.appendChild(head);
      i++;
      continue;
    }

    if (RULE.test(line)) { out.appendChild(el('hr')); i++; continue; }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      const q = el('blockquote');
      q.appendChild(renderMarkdown(quoted.join('\n')));
      out.appendChild(q);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(lines[i++]!);
      out.appendChild(table(rows));
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (BULLET.test(l) || ORDERED.test(l)) { items.push(l); i++; continue; }
        // A blank line followed by more list, or an indented continuation, stays in the list.
        if (!l.trim() && i + 1 < lines.length && (BULLET.test(lines[i + 1]!) || ORDERED.test(lines[i + 1]!))) { i++; continue; }
        if (l.trim() && /^\s{2,}/.test(l) && items.length) { items[items.length - 1] += `\n${l.trim()}`; i++; continue; }
        break;
      }
      out.appendChild(list(items));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) para.push(lines[i++]!);
    if (para.length === 0) para.push(lines[i++]!);   // a block marker that did not parse as one
    const p = el('p');
    para.forEach((l, k) => {
      if (k) p.appendChild(el('br'));
      p.appendChild(renderInline(l.trim()));
    });
    out.appendChild(p);
  }
  return out;
}

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || /^\s*>/.test(l) ||
    BULLET.test(l) || ORDERED.test(l) ||
    (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!));
}

function splitRow(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(rows: string[]): HTMLElement {
  const wrap = el('div');
  wrap.className = 'md-table';
  const tbl = el('table');
  const head = splitRow(rows[0]!);
  const thead = el('thead');
  const tr = el('tr');
  for (const c of head) { const th = el('th'); th.appendChild(renderInline(c)); tr.appendChild(th); }
  thead.appendChild(tr);
  tbl.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows.slice(1)) {
    const row = el('tr');
    const cells = splitRow(r);
    for (let k = 0; k < head.length; k++) {
      const td = el('td');
      td.appendChild(renderInline(cells[k] ?? ''));
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

/** Nested lists from indentation: deeper items open a child list in the previous item. */
function list(items: string[]): HTMLElement {
  interface Level { indent: number; el: HTMLElement }
  const parse = (l: string) => {
    const b = BULLET.exec(l.split('\n')[0]!);
    const o = ORDERED.exec(l.split('\n')[0]!);
    const m = (b ?? o)!;
    const rest = l.split('\n').slice(1);
    return { indent: m[1]!.replace(/\t/g, '    ').length, ordered: !b, start: o ? Number(o[2]) : 1, text: [m[3]!, ...rest] };
  };
  const first = parse(items[0]!);
  const root = el(first.ordered ? 'ol' : 'ul');
  if (first.ordered && first.start !== 1) root.setAttribute('start', String(first.start));
  const stack: Level[] = [{ indent: first.indent, el: root }];
  for (const raw of items) {
    const it = parse(raw);
    while (stack.length > 1 && it.indent < stack[stack.length - 1]!.indent) stack.pop();
    let top = stack[stack.length - 1]!;
    if (it.indent > top.indent && top.el.lastElementChild) {
      const child = el(it.ordered ? 'ol' : 'ul');
      if (it.ordered && it.start !== 1) child.setAttribute('start', String(it.start));
      top.el.lastElementChild.appendChild(child);
      stack.push({ indent: it.indent, el: child });
      top = stack[stack.length - 1]!;
    }
    const li = el('li');
    it.text.forEach((t, k) => {
      if (k) li.appendChild(el('br'));
      li.appendChild(renderInline(t));
    });
    top.el.appendChild(li);
  }
  return root;
}

// ------------------------------------------------------------------ inline

interface InlineRule { re: RegExp; make(m: RegExpExecArray): Node }

const INLINE: InlineRule[] = [
  { re: /`([^`\n]+)`/, make: (m) => el('code', m[1]!) },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, make: (m) => link(m[1]!, m[2]!) },
  // `__` only off word boundaries too, so identifiers like window.__proto__x stay literal.
  { re: /\*\*(?=\S)([^*\n]*?\S)\*\*|(?<![\w_])__(?=\S)([^_\n]*?\S)__(?![\w_])/, make: (m) => wrap('strong', m[1] ?? m[2]!) },
  { re: /~~(?=\S)([^~\n]*?\S)~~/, make: (m) => wrap('del', m[1]!) },
  // Single * or _ only around a word, so snake_case and 2*3*4 stay literal.
  { re: /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/, make: (m) => wrap('em', m[1] ?? m[2]!) },
  { re: /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, make: (m) => link(m[0], m[0]) },
];

function wrap(tag: 'strong' | 'em' | 'del', text: string): Node {
  const e = el(tag);
  e.appendChild(renderInline(text));
  return e;
}

function link(text: string, href: string): Node {
  if (!/^https?:\/\//i.test(href)) return document.createTextNode(text);
  const a = el('a', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** Inline spans: the earliest match wins; text between matches stays literal. */
export function renderInline(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let rest = text;
  while (rest) {
    let best: { m: RegExpExecArray; rule: InlineRule } | null = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) { out.appendChild(document.createTextNode(rest)); break; }
    if (best.m.index > 0) out.appendChild(document.createTextNode(rest.slice(0, best.m.index)));
    out.appendChild(best.rule.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}
