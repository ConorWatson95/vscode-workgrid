/**
 * A report as a page a browser opens.
 *
 * Claude's pane draws in character cells and the dashboard sits in a chat column, so
 * neither is somewhere to read a stage's full account. A browser is, and needs no
 * extension: the report is written out as one self-contained file and handed to
 * whatever the machine opens `.html` with.
 *
 * Deliberately a small markdown renderer of its own rather than a dependency. The
 * reports carry agent replies and command output verbatim, so everything is escaped
 * and the only markup let through is the `<details>`/`<summary>` the report itself
 * emits to fold superseded rounds. A general renderer passes raw HTML on, and a page
 * opened from disk that runs whatever a stage happened to print is not a report.
 */

export function renderReportPage(title: string, markdown: string, generatedAt?: string): string {
  const stamp = generatedAt ? `<p class="stamp">Written ${escapeHtml(generatedAt)} by Task Workspaces.</p>` : "";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    `</head><body><main>${stamp}${renderMarkdown(markdown)}</main></body></html>`,
  ].join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff;
  --panel: #f6f8fa; --line: #d1d9e0; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1;
  --bg: #0d1117; --panel: #151b23; --line: #3d444d; --link: #4493f8; } }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
h1 { font-size: 1.8em; border-bottom: 1px solid var(--line); padding-bottom: .3em; }
h2 { font-size: 1.35em; border-bottom: 1px solid var(--line); padding-bottom: .25em; }
a { color: var(--link); }
code { font: 13px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
  background: var(--panel); padding: .1em .35em; border-radius: 4px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px; overflow: auto; }
pre code { background: none; padding: 0; white-space: pre; }
table { border-collapse: collapse; display: block; overflow: auto; margin: 1em 0; }
th, td { border: 1px solid var(--line); padding: 4px 10px; text-align: left; vertical-align: top; }
th { background: var(--panel); }
blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-left: 3px solid var(--line); }
details { border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; margin: .8em 0; }
summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
details[open] > summary { border-bottom: 1px solid var(--line); margin-bottom: .5em; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; }
.stamp { color: var(--muted); font-size: 13px; margin: 0; }
`;

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const fold = { depth: 0 };
  const html = renderBlocks(lines, fold);
  return html + "</details>".repeat(fold.depth);
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const DETAILS = /^\s*<details( open)?>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const DETAILS_END = /^\s*<\/details>\s*$/i;

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    DETAILS.test(line) ||
    SUMMARY.test(line) ||
    DETAILS_END.test(line) ||
    isTableStart(lines, i)
  );
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-");
}

function renderBlocks(lines: string[], fold: { depth: number }): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      // Closed only by a bare fence of the same character at least as long, so output
      // carrying fences of its own (`codeBlock` lengthens the outer one) stays inside.
      const closes = (l: string) => {
        const bare = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
        return !!bare && bare[1][0] === marker[0] && bare[1].length >= marker.length;
      };
      while (i < lines.length && !closes(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const details = DETAILS.exec(line);
    if (details) {
      fold.depth++;
      out.push(`<details${details[1] ? " open" : ""}>` + (details[2] !== undefined ? `<summary>${inline(details[2])}</summary>` : ""));
      i++;
      continue;
    }
    const summary = SUMMARY.exec(line);
    if (summary) {
      out.push(`<summary>${inline(summary[1])}</summary>`);
      i++;
      continue;
    }
    if (DETAILS_END.test(line)) {
      // A stray close from somebody's reply must not end a fold the report opened
      // further up, nor any fold at all when none is open.
      if (fold.depth > 0) {
        fold.depth--;
        out.push("</details>");
      } else {
        out.push(`<p>${escapeHtml(line.trim())}</p>`);
      }
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ""));
      out.push(`<blockquote>${renderBlocks(quoted, { depth: 0 })}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = cells(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push(
        "<table><thead><tr>" +
          header.map((cell) => `<th>${inline(cell)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((row) => "<tr>" + row.map((cell) => `<td>${inline(cell)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      continue;
    }

    const item = LIST.exec(line);
    if (item) {
      i = renderList(lines, i, out, fold);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines, i))) {
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${inline(paragraph.map((l) => l.trimStart()).join("\n"))}</p>`);
  }
  return out.join("\n");
}

/** One list at one indentation; an item's indented lines are its own blocks, nesting included. */
function renderList(lines: string[], start: number, out: string[], fold: { depth: number }): number {
  const first = LIST.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const item = LIST.exec(line);
    if (item && item[1].length === indent && /\d/.test(item[2]) === ordered) {
      items.push([item[3]]);
      i++;
      continue;
    }
    if (!line.trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (next < lines.length && leading(lines[next]) > indent) {
        items[items.length - 1].push("");
        i++;
        continue;
      }
      const sibling = next < lines.length ? LIST.exec(lines[next]) : null;
      if (sibling && sibling[1].length === indent && /\d/.test(sibling[2]) === ordered) {
        i = next;
        continue;
      }
      break;
    }
    if (leading(line) > indent) {
      items[items.length - 1].push(line);
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  const startAt = ordered ? Number.parseInt(first[2], 10) : 1;
  const rendered = items.map((content) => {
    const rest = content.slice(1);
    const margin = Math.min(...rest.filter((l) => l.trim()).map(leading), Number.POSITIVE_INFINITY);
    const body = [content[0], ...rest.map((l) => (Number.isFinite(margin) ? l.slice(margin) : l))];
    // A tight item's text is not a paragraph, or every bullet gains a paragraph's margin.
    return `<li>${renderBlocks(body, fold).replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`;
  });
  out.push(`<${tag}${ordered && startAt !== 1 ? ` start="${startAt}"` : ""}>${rendered.join("")}</${tag}>`);
  return i;
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

const LINKABLE = /^(https?:|file:|mailto:|vscode:)/i;

function inline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\)/g, (whole, label: string, target: string) => {
    const url = unescapeHtml(target);
    if (!LINKABLE.test(url)) return whole;
    return hold(`<a href="${escapeHtml(url)}">${emphasis(label)}</a>`);
  });
  s = s.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, (_, target: string) => hold(anchor(target)));
  s = s.replace(/https?:\/\/[^\s\u0000]+/g, (found: string) => {
    let url = found;
    let tail = "";
    for (;;) {
      const trailing = /(&quot;|&#39;|&gt;|[.,;:!?)\]])$/.exec(url);
      if (!trailing) break;
      tail = trailing[1] + tail;
      url = url.slice(0, -trailing[1].length);
    }
    return hold(anchor(url)) + tail;
  });
  s = emphasis(s).replace(/ {2,}\n/g, "<br>\n");
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[Number(n)]);
  return s;
}

function anchor(escapedUrl: string): string {
  return `<a href="${escapeHtml(unescapeHtml(escapedUrl))}">${escapedUrl}</a>`;
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "<em>$1</em>")
    .replace(/(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)/g, "<em>$1</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
