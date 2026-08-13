import { describe, expect, it } from "vitest";
import { SuggestionSource } from "../domain/suggestionSourceFile";
import {
  buildScanPrompt,
  scanFailures,
  scannedSuggestions,
  SuggestionScanRunner,
  SuggestionScanService,
} from "./suggestionScanService";

const source = (over: Partial<SuggestionSource> = {}): SuggestionSource => ({
  id: "jira",
  label: "JIRA",
  scanPrompt: "List issues assigned to me that are not done.",
  requiredMcpServers: ["atlassian"],
  order: { ranks: ["Blocker", "Major", "Minor"], showFrom: "Major" },
  ...over,
});

const clock = { now: () => "2026-08-13T09:00:00.000Z" };

class FakeRunner implements SuggestionScanRunner {
  calls: { root: string; prompt: string; label: string; servers?: readonly string[] }[] = [];
  constructor(
    private readonly replies: Record<
      string,
      { ok: boolean; text: string; error?: string } | Error
    >,
  ) {}
  async run(
    repositoryRoot: string,
    prompt: string,
    label: string,
    options?: { requiredMcpServers?: readonly string[] },
  ) {
    this.calls.push({
      root: repositoryRoot,
      prompt,
      label,
      servers: options?.requiredMcpServers,
    });
    const reply = this.replies[label] ?? { ok: true, text: "" };
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

describe("SuggestionScanService", () => {
  it("parses each source's reply and stamps the scan", async () => {
    const runner = new FakeRunner({
      "scan:jira": {
        ok: true,
        text: "SUGGESTION: NMGB-1 | Blocker | open | Export drops a row",
      },
    });
    const service = new SuggestionScanService(runner, clock);

    const result = await service.scan("C:/Dev/qubeautoapp", [source()]);
    expect(result.scannedAt).toBe("2026-08-13T09:00:00.000Z");
    expect(scannedSuggestions(result)).toEqual([
      {
        sourceId: "jira",
        ref: "NMGB-1",
        rank: "Blocker",
        state: "open",
        title: "Export drops a row",
      },
    ]);
    expect(scanFailures(result)).toEqual([]);
  });

  it("runs at the repository, not a worktree, and requires the declared servers", async () => {
    const runner = new FakeRunner({});
    await new SuggestionScanService(runner, clock).scan("C:/Dev/qubeautoapp", [source()]);
    expect(runner.calls[0].root).toBe("C:/Dev/qubeautoapp");
    expect(runner.calls[0].servers).toEqual(["atlassian"]);
  });

  it("tells an empty board apart from a source that failed", async () => {
    // The distinction the outcome type exists for: presented as "no work", a broken
    // MCP server reads as a quiet morning.
    const runner = new FakeRunner({
      "scan:jira": { ok: false, text: "", error: "atlassian unavailable" },
      "scan:empty": { ok: true, text: "Nothing is assigned to you." },
    });
    const service = new SuggestionScanService(runner, clock);

    const result = await service.scan("/repo", [
      source(),
      source({ id: "empty", label: "Empty board" }),
    ]);
    expect(scannedSuggestions(result)).toEqual([]);
    expect(scanFailures(result)).toEqual(["JIRA: atlassian unavailable"]);
    expect(result.outcomes[1].failure).toBeUndefined();
  });

  it("keeps scanning when one source throws", async () => {
    const runner = new FakeRunner({
      "scan:jira": new Error("spawn failed"),
      "scan:other": { ok: true, text: "SUGGESTION: X-1 | Major | open | Something" },
    });
    const service = new SuggestionScanService(runner, clock);

    const result = await service.scan("/repo", [source(), source({ id: "other", label: "Other" })]);
    expect(result.outcomes[0].failure).toBe("spawn failed");
    expect(scannedSuggestions(result).map((s) => s.ref)).toEqual(["X-1"]);
  });

  it("scans sources one at a time", async () => {
    const runner = new FakeRunner({});
    await new SuggestionScanService(runner, clock).scan("/repo", [
      source({ id: "a" }),
      source({ id: "b" }),
    ]);
    expect(runner.calls.map((c) => c.label)).toEqual(["scan:a", "scan:b"]);
  });

  it("remembers the last scan per repository, and can forget it", async () => {
    const runner = new FakeRunner({
      "scan:jira": { ok: true, text: "SUGGESTION: NMGB-1 | Blocker | open | Thing" },
    });
    const service = new SuggestionScanService(runner, clock);

    expect(service.lastScan("/repo")).toBeUndefined();
    await service.scan("/repo", [source()]);
    expect(scannedSuggestions(service.lastScan("/repo"))).toHaveLength(1);
    // Case and separators vary between the tree and git's own output.
    expect(service.lastScan("\\repo")).toBeDefined();

    service.forget("/repo");
    expect(service.lastScan("/repo")).toBeUndefined();
  });

  it("holds nothing for a project with no sources", async () => {
    const service = new SuggestionScanService(new FakeRunner({}), clock);
    const result = await service.scan("/repo", []);
    expect(result.outcomes).toEqual([]);
    expect(scannedSuggestions(result)).toEqual([]);
  });
});

describe("buildScanPrompt", () => {
  it("carries the project's prompt and adds the reply contract", () => {
    const prompt = buildScanPrompt(source());
    expect(prompt).toContain("List issues assigned to me that are not done.");
    expect(prompt).toContain("SUGGESTION: <ref> | <rank> | <state> | <title>");
  });

  it("names the source's own ranks, since the runtime cannot map an unknown one", () => {
    expect(buildScanPrompt(source())).toContain("Blocker, Major, Minor");
  });

  it("omits the rank instruction for a source that declares none", () => {
    const prompt = buildScanPrompt(source({ order: { ranks: [] } }));
    expect(prompt).not.toContain("for `rank`, exactly as written");
  });

  it("tells the scan not to write a SUGGESTION line saying none", () => {
    // The parser guards this too, but a prompt that invites it produces a reply the
    // guard has to catch on every scan.
    expect(buildScanPrompt(source())).toContain('"none"');
  });

  it("says the scan changes nothing", () => {
    // A read-only scan holding write tooling is one transition away from a board
    // edited by a list refresh.
    expect(buildScanPrompt(source())).toContain("read-only");
  });
});
