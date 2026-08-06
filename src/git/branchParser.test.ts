import { describe, expect, it } from "vitest";
import { parseBranchNames } from "./branchParser";

describe("parseBranchNames", () => {
  it("reads one name per line, sorted", () => {
    expect(parseBranchNames("main\ndev\nfeature/x\n")).toEqual([
      "dev",
      "feature/x",
      "main",
    ]);
  });

  it("drops blank lines and trailing whitespace", () => {
    expect(parseBranchNames("main \n\n  dev\n\n")).toEqual(["dev", "main"]);
  });

  it("handles CRLF, since git on Windows is where this runs", () => {
    expect(parseBranchNames("main\r\ndev\r\n")).toEqual(["dev", "main"]);
  });

  it("returns nothing for empty output", () => {
    expect(parseBranchNames("")).toEqual([]);
  });
});
