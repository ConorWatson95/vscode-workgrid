import { describe, expect, it } from "vitest";
import {
  MAX_VERIFY_OUTPUT,
  describeVerification,
  prepareOutput,
} from "./verificationRunner";

describe("describeVerification", () => {
  it("reports the exit code and the output", () => {
    const text = describeVerification("dotnet build", {
      exitCode: 1,
      output: "CS1002: ; expected",
    });
    expect(text).toContain("exit 1");
    expect(text).toContain("dotnet build");
    expect(text).toContain("CS1002");
  });

  it("distinguishes a command that could not start from a failing check", () => {
    // A command that never ran proves nothing about the work, and reading it as a
    // failed build sends someone looking for a bug that is not there.
    const text = describeVerification("dotnat build", {
      exitCode: -1,
      output: "",
      spawnError: "spawn dotnat ENOENT",
    });
    expect(text).toContain("could not be started");
    expect(text).toContain("fix the command, not the work");
  });

  it("masks a credential in the command it quotes back", () => {
    const text = describeVerification(
      'sqlcmd -S srv -U deploy -P S3cr3t!Value -Q "select 1"',
      { exitCode: 1, output: "Login failed" },
    );
    expect(text).not.toContain("S3cr3t!Value");
  });

  it("says so when a failing command printed nothing", () => {
    // An empty section reads as the report being broken rather than the command
    // being silent.
    expect(describeVerification("false", { exitCode: 1, output: "" })).toContain(
      "(no output)",
    );
  });
});

describe("prepareOutput", () => {
  it("keeps short output as it is", () => {
    expect(prepareOutput("  2 tests passed\n")).toBe("2 tests passed");
  });

  it("keeps the tail of long output, where the error is", () => {
    const body = `${"x".repeat(MAX_VERIFY_OUTPUT * 2)}THE ACTUAL ERROR`;
    const result = prepareOutput(body);
    expect(result).toContain("THE ACTUAL ERROR");
    expect(result).toContain("earlier characters omitted");
    expect(result.length).toBeLessThan(MAX_VERIFY_OUTPUT + 200);
  });

  it("masks credentials in captured output", () => {
    // A failing sqlcmd echoes the connection it tried.
    expect(prepareOutput("failed: Password=S3cr3t!Value")).not.toContain("S3cr3t!Value");
  });
});
