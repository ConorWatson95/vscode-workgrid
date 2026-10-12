import { describe, expect, it } from "vitest";
import { releaseBundle } from "./update";

const asset = (name: string) => ({ name, browser_download_url: `https://dl/${name}` });

describe("releaseBundle", () => {
  it("reads the version from the tag and the bundle files from the assets", () => {
    expect(
      releaseBundle({
        tag_name: "v0.149.0",
        assets: [asset("task-workspaces-0.149.0.vsix"), asset("harnessMcpServer.js"), asset("harnessRunner.js")],
      }),
    ).toEqual({
      version: "0.149.0",
      assets: {
        "task-workspaces-0.149.0.vsix": "https://dl/task-workspaces-0.149.0.vsix",
        "harnessMcpServer.js": "https://dl/harnessMcpServer.js",
        "harnessRunner.js": "https://dl/harnessRunner.js",
      },
    });
  });

  it("refuses a release that would pair a new server with an old runner", () => {
    expect(releaseBundle({ tag_name: "v0.149.0", assets: [asset("harnessMcpServer.js")] })).toMatch(
      /does not attach harnessRunner\.js/,
    );
    expect(releaseBundle({ assets: [] })).toMatch(/no tag/);
    expect(releaseBundle(undefined)).toMatch(/no tag/);
  });
});
