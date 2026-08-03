import { describe, it, expect } from "vitest";
import { mergeAllowRules } from "./permissionRules";

const RULE = "PowerShell(tools/jira/Get-JiraAttachment.ps1:*)";

describe("mergeAllowRules", () => {
  it("creates the permissions block when the file has none", () => {
    const result = mergeAllowRules({ enabledPlugins: {} }, [RULE]);
    expect(result.added).toEqual([RULE]);
    expect(result.settings).toEqual({
      enabledPlugins: {},
      permissions: { allow: [RULE] },
    });
  });

  it("appends to an existing allow list without removing anything", () => {
    const result = mergeAllowRules(
      { permissions: { allow: ["Bash(sqlcmd:*)"], deny: ["Bash(rm:*)"] } },
      [RULE],
    );
    expect(result.settings).toEqual({
      permissions: { allow: ["Bash(sqlcmd:*)", RULE], deny: ["Bash(rm:*)"] },
    });
  });

  it("preserves keys it does not understand", () => {
    // This is a file the user owns; dropping their settings would be far worse
    // than declining to edit it.
    const result = mergeAllowRules(
      { enabledPlugins: { "x@y": false }, someFutureKey: 42 },
      [RULE],
    );
    expect(result.settings?.enabledPlugins).toEqual({ "x@y": false });
    expect(result.settings?.someFutureKey).toBe(42);
  });

  it("does not add a rule that is already there", () => {
    const result = mergeAllowRules({ permissions: { allow: [RULE] } }, [RULE]);
    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual([RULE]);
    // Nothing to write, so no settings are returned and the file is left alone.
    expect(result.settings).toBeUndefined();
  });

  it("reports both added and already-present rules", () => {
    const result = mergeAllowRules({ permissions: { allow: [RULE] } }, [
      RULE,
      "Bash(sqlcmd:*)",
    ]);
    expect(result.added).toEqual(["Bash(sqlcmd:*)"]);
    expect(result.alreadyPresent).toEqual([RULE]);
  });

  it("de-duplicates within one request", () => {
    const result = mergeAllowRules({}, [RULE, RULE]);
    expect(result.added).toEqual([RULE]);
  });

  it("starts from scratch when the file is absent", () => {
    const result = mergeAllowRules(undefined, [RULE]);
    expect(result.settings).toEqual({ permissions: { allow: [RULE] } });
  });

  it("does nothing when given no rules", () => {
    const result = mergeAllowRules({ permissions: { allow: [] } }, []);
    expect(result.added).toEqual([]);
    expect(result.settings).toBeUndefined();
  });

  it("ignores blank rules rather than writing an empty grant", () => {
    const result = mergeAllowRules({}, ["  ", ""]);
    expect(result.added).toEqual([]);
    expect(result.settings).toBeUndefined();
  });

  it("trims a rule before comparing, so whitespace is not a new grant", () => {
    const result = mergeAllowRules({ permissions: { allow: [RULE] } }, [`  ${RULE}  `]);
    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual([RULE]);
  });

  describe("refusing rather than overwriting", () => {
    it("refuses when the settings file is not an object", () => {
      const result = mergeAllowRules([1, 2, 3], [RULE]);
      expect(result.problem).toContain("JSON object");
      expect(result.settings).toBeUndefined();
    });

    it("refuses when permissions is the wrong shape", () => {
      const result = mergeAllowRules({ permissions: "all" }, [RULE]);
      expect(result.problem).toContain("permissions");
      expect(result.settings).toBeUndefined();
    });

    it("refuses when allow is not an array of strings", () => {
      expect(mergeAllowRules({ permissions: { allow: "x" } }, [RULE]).problem).toContain(
        "allow",
      );
      expect(
        mergeAllowRules({ permissions: { allow: [1, 2] } }, [RULE]).problem,
      ).toContain("allow");
    });
  });

  it("does not mutate the settings it was given", () => {
    const original = { permissions: { allow: ["Bash(sqlcmd:*)"] } };
    const snapshot = JSON.stringify(original);
    mergeAllowRules(original, [RULE]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
