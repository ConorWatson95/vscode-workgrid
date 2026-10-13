import { describe, expect, it } from "vitest";
import { renderMarkdown, renderReportPage } from "./reportHtml";

describe("renderMarkdown", () => {
  it("renders the shapes a stage report is made of", () => {
    const html = renderMarkdown(
      [
        "# Pyramid export",
        "",
        "**Task:** Export the pyramid · `rc-implement-app`",
        "",
        "## Commands",
        "",
        "- ran `npm test`",
        "  - nested detail",
        "- wrote [Index.cshtml](file:///C:/w/Index.cshtml)",
        "",
        "1. first",
        "2. second",
        "",
        "```",
        "exit 0 <done>",
        "```",
        "",
        "| Item | Check |",
        "|---|---|",
        "| CSV | `pyramid-csv` |",
        "",
        "> quoted",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Pyramid export</h1>");
    expect(html).toContain("<p><strong>Task:</strong> Export the pyramid · <code>rc-implement-app</code></p>");
    expect(html).toContain("<ul><li>ran <code>npm test</code>\n<ul><li>nested detail</li></ul></li>");
    expect(html).toContain('<li>wrote <a href="file:///C:/w/Index.cshtml">Index.cshtml</a></li>');
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<pre><code>exit 0 &lt;done&gt;</code></pre>");
    expect(html).toContain("<th>Item</th><th>Check</th>");
    expect(html).toContain("<td><code>pyramid-csv</code></td>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<hr>");
  });

  it("escapes whatever a stage printed, so a report can never run it", () => {
    const html = renderMarkdown('The page said <script>alert("x")</script> and <img src=x onerror=y>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("links only schemes a report means, leaving a javascript: link as text", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) and https://jira/browse/NMGB-1.");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://jira/browse/NMGB-1">https://jira/browse/NMGB-1</a>.');
  });

  it("keeps the report's own folds and drops a close nothing opened", () => {
    const html = renderMarkdown(
      ["</details>", "<details><summary>Round 1 — **superseded**</summary>", "", "old reply", "", "</details>", "after"].join("\n"),
    );
    expect(html).toContain("<p>&lt;/details&gt;</p>");
    expect(html).toContain("<details><summary>Round 1 — <strong>superseded</strong></summary>");
    expect(html.match(/<\/details>/g)).toHaveLength(1);
  });

  it("closes a fold a reply left open, so the rest of the page is not swallowed by it", () => {
    expect(renderMarkdown("<details>\n\ntext")).toMatch(/<\/details>$/);
  });

  it("keeps fences inside a longer fence as content, as command output often carries them", () => {
    const html = renderMarkdown(["````", "# Error details", "```", "Expected: true", "```yaml", "````", "after"].join("\n"));
    expect(html).toBe("<pre><code># Error details\n```\nExpected: true\n```yaml</code></pre>\n<p>after</p>");
  });

  it("leaves snake_case and a lone asterisk alone", () => {
    const html = renderMarkdown("p_Bespoke_Detail_Summary costs 2 * 3");
    expect(html).toBe("<p>p_Bespoke_Detail_Summary costs 2 * 3</p>");
  });
});

describe("renderReportPage", () => {
  it("is a whole page with an escaped title", () => {
    const page = renderReportPage("A <b> task", "# Hi", "13 Oct 2026 09:00");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<title>A &lt;b&gt; task</title>");
    expect(page).toContain("Written 13 Oct 2026 09:00");
  });
});
