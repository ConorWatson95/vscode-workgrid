import { describe, expect, it } from "vitest";

import { killTreeCommand } from "./processTree";

describe("killTreeCommand", () => {
  it("takes the whole tree on Windows, because the direct child is a shell shim", () => {
    expect(killTreeCommand(4580, "win32")).toEqual({
      command: "taskkill",
      args: ["/PID", "4580", "/T", "/F"],
    });
  });

  it("forces, so a CLI mid-turn cannot decline to exit", () => {
    const tree = killTreeCommand(1, "win32");
    expect(tree?.args).toContain("/F");
    expect(tree?.args).toContain("/T");
  });

  it("asks for no command elsewhere, where the direct child is the CLI itself", () => {
    expect(killTreeCommand(4580, "linux")).toBeUndefined();
    expect(killTreeCommand(4580, "darwin")).toBeUndefined();
  });
});
