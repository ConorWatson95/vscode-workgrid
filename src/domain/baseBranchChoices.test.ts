import { describe, expect, it } from "vitest";
import { orderBaseBranchChoices } from "./baseBranchChoices";

describe("orderBaseBranchChoices", () => {
  it("puts the default first and sorts the rest", () => {
    expect(orderBaseBranchChoices(["zeta", "alpha", "develop"], "develop")).toEqual([
      "develop",
      "alpha",
      "zeta",
    ]);
  });

  it("offers a default that names no local branch", () => {
    expect(orderBaseBranchChoices(["main"], "HEAD")).toEqual(["HEAD", "main"]);
  });

  it("does not list the default twice", () => {
    expect(orderBaseBranchChoices(["main", "main"], "main")).toEqual(["main"]);
  });

  it("ignores blanks", () => {
    expect(orderBaseBranchChoices(["", "  ", "main"], "")).toEqual(["main"]);
  });
});
