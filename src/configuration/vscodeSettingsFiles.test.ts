import { describe, expect, it } from "vitest";
import {
  parseJsonc,
  readSettingsFiles,
  sectionValues,
  userSettingsCandidates,
} from "./vscodeSettingsFiles";

describe("parseJsonc", () => {
  it("accepts comments and trailing commas, and leaves strings alone", () => {
    const text = `{
      // the model
      "taskWorkspaces.model": "sonnet", /* inline */
      "url": "https://example.com/a//b",
      "quote": "a \\" // not a comment",
      "list": [1, 2,],
    }`;
    expect(parseJsonc(text)).toEqual({
      "taskWorkspaces.model": "sonnet",
      url: "https://example.com/a//b",
      quote: 'a " // not a comment',
      list: [1, 2],
    });
  });

  it("keeps a comma inside a string that precedes a bracket", () => {
    expect(parseJsonc(`{"a": ", }"}`)).toEqual({ a: ", }" });
  });

  it("reads an empty file as no settings", () => {
    expect(parseJsonc("  // nothing\n")).toEqual({});
  });
});

describe("sectionValues", () => {
  it("strips the prefix, takes nested values, and lets flat keys win", () => {
    expect(
      sectionValues({
        "taskWorkspaces.model": "opus",
        taskWorkspaces: { model: "sonnet", stageTimeoutMinutes: 30 },
        "editor.fontSize": 14,
      }),
    ).toEqual({ model: "opus", stageTimeoutMinutes: 30 });
  });
});

describe("readSettingsFiles", () => {
  const files: Record<string, string> = {
    "/u/Code/User/settings.json": `{"taskWorkspaces.model": "sonnet", "taskWorkspaces.stageTimeoutMinutes": 45}`,
    "/u/Code - Insiders/User/settings.json": `{"taskWorkspaces.model": "haiku"}`,
    "/repo/.vscode/settings.json": `{"taskWorkspaces.stageTimeoutMinutes": 60,}`,
  };
  const read = (file: string) => files[file];

  it("puts the workspace over the first user file that exists, and names both", () => {
    const result = readSettingsFiles(
      ["/u/Code/User/settings.json", "/u/Code - Insiders/User/settings.json"],
      "/repo/.vscode/settings.json",
      read,
    );
    expect(result.values).toEqual({ model: "sonnet", stageTimeoutMinutes: 60 });
    expect(result.sources).toEqual(["/u/Code/User/settings.json", "/repo/.vscode/settings.json"]);
    expect(result.problems).toEqual([]);
  });

  it("reports a file it could not parse rather than applying part of it", () => {
    const result = readSettingsFiles(["/broken"], "/missing", (file) =>
      file === "/broken" ? "{ nope" : undefined,
    );
    expect(result.values).toEqual({});
    expect(result.problems).toHaveLength(1);
  });
});

describe("userSettingsCandidates", () => {
  it("uses APPDATA on Windows", () => {
    const [stable] = userSettingsCandidates({ platform: "win32", home: "C:/h", appData: "C:/h/AD" });
    expect(stable.replace(/\\/g, "/")).toBe("C:/h/AD/Code/User/settings.json");
  });
});
