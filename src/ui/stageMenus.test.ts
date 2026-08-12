import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Stage context values are space-joined tokens (`stage-awaiting-approval correctable`),
 * so `viewItem == stage-…` is an equality test that a real stage can never satisfy —
 * every stage awaiting approval has a reply, hence is correctable, hence carries the
 * second token. That is how Approve vanished from the one row it exists for.
 */
describe("stage menu when clauses", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { contributes: { menus: Record<string, { when?: string }[]> } };

  const clauses = Object.values(pkg.contributes.menus)
    .flat()
    .map((entry) => entry.when ?? "");

  it("never matches a stage context value by equality", () => {
    const offenders = clauses.filter((when) => /viewItem\s*==\s*stage-/.test(when));
    expect(offenders).toEqual([]);
  });
});
