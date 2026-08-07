import { describe, expect, it } from "vitest";
import { assessMcpReadiness } from "./mcpReadiness";

describe("assessMcpReadiness", () => {
  it("passes when nothing is required, whatever the servers did", () => {
    const readiness = assessMcpReadiness([], [{ name: "jira", status: "failed" }], []);
    expect(readiness.ok).toBe(true);
  });

  it("passes when every required server connected", () => {
    const readiness = assessMcpReadiness(
      ["jira"],
      [
        { name: "jira", status: "connected" },
        { name: "other", status: "failed" },
      ],
      [],
    );
    expect(readiness.ok).toBe(true);
  });

  it("ignores a server that failed but was not required", () => {
    const readiness = assessMcpReadiness(
      ["jira"],
      [
        { name: "jira", status: "connected" },
        { name: "unrelated", status: "failed" },
      ],
      [{ name: "unrelated", message: "bad command" }],
    );
    expect(readiness.ok).toBe(true);
    expect(readiness.failed).toEqual([]);
  });

  it("fails a required server that did not connect, naming the status", () => {
    const readiness = assessMcpReadiness(["jira"], [{ name: "jira", status: "failed" }], []);
    expect(readiness.ok).toBe(false);
    expect(readiness.failed).toEqual(["jira"]);
    expect(readiness.reason).toContain("jira (failed)");
  });

  it("fails a required server the init event never mentioned", () => {
    const readiness = assessMcpReadiness(["jira"], [{ name: "other", status: "connected" }], []);
    expect(readiness.ok).toBe(false);
    expect(readiness.missing).toEqual(["jira"]);
    expect(readiness.reason).toContain("not configured");
  });

  // A rejected config entry appears in no status list, so reading only statuses
  // reports it as a server nobody configured — which sends you to the wrong file.
  it("reports a rejected config entry as failed, with the CLI's message", () => {
    const readiness = assessMcpReadiness(
      ["jira"],
      [],
      [{ name: "jira", message: "command not found" }],
    );
    expect(readiness.ok).toBe(false);
    expect(readiness.failed).toEqual(["jira"]);
    expect(readiness.missing).toEqual([]);
    expect(readiness.reason).toContain("command not found");
  });

  // These names are config keys copied by hand between two files.
  it("matches names case- and whitespace-insensitively", () => {
    const readiness = assessMcpReadiness(
      ["  Jira "],
      [{ name: "jira", status: "connected" }],
      [],
    );
    expect(readiness.ok).toBe(true);
  });

  it("reports both failures and absences in one sentence", () => {
    const readiness = assessMcpReadiness(
      ["jira", "confluence"],
      [{ name: "jira", status: "needs-auth" }],
      [],
    );
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("jira (needs-auth)");
    expect(readiness.reason).toContain("confluence");
  });

  // Older CLI builds report no statuses at all; that must not read as "all present".
  it("fails required servers when the init event reported nothing", () => {
    const readiness = assessMcpReadiness(["jira"], undefined, undefined);
    expect(readiness.ok).toBe(false);
    expect(readiness.missing).toEqual(["jira"]);
  });
});
