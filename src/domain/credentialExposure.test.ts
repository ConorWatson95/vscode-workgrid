import { describe, expect, it } from "vitest";
import { credentialExposureReason, findCredentialExposure } from "./credentialExposure";

describe("findCredentialExposure", () => {
  it("catches the form that put 150 passwords in the state file", () => {
    expect(
      findCredentialExposure('sqlcmd -S 10.0.0.1 -U dbuser -P hunter2 -d Trade -Q "SELECT 1"'),
    ).toEqual({ kind: "command-line password flag" });
  });

  it("catches a password in a connection string", () => {
    expect(
      findCredentialExposure('$c = "Server=x;Database=y;User Id=z;Password=hunter2;"'),
    ).toEqual({ kind: "inline password assignment" });
  });

  it("catches a lowercase pwd assignment", () => {
    expect(findCredentialExposure("PWD=hunter2 ./run.sh")).toBeTruthy();
  });

  // A false positive here blocks real work, which is how a check like this gets
  // switched off. Each of these is a command that must go straight through.
  it("does not treat grep's Perl regex flag as a password", () => {
    expect(findCredentialExposure("grep -P '\\d{4}' report.txt")).toBeUndefined();
  });

  it("does not flag -P for a program that is not a database client", () => {
    expect(findCredentialExposure("scp -P 2222 file host:/tmp")).toBeUndefined();
    expect(findCredentialExposure("mkdir -p build/out")).toBeUndefined();
  });

  it("does not flag a database client with no password flag", () => {
    expect(
      findCredentialExposure('sqlcmd -S 10.0.0.1 -E -d Trade -Q "SELECT 1"'),
    ).toBeUndefined();
  });

  it("does not flag the interactive form, which is the behaviour being encouraged", () => {
    // -P with no value: sqlcmd prompts. Catching this would refuse the fix.
    expect(findCredentialExposure('sqlcmd -S x -U me -P -Q "SELECT 1"')).toBeUndefined();
  });

  it("does not flag a password flag that is only named, not given a value", () => {
    expect(findCredentialExposure("sqlcmd --help | grep password")).toBeUndefined();
  });

  it("does not flag an empty assignment or a variable reference", () => {
    expect(findCredentialExposure("Password= ")).toBeUndefined();
    expect(findCredentialExposure("psql --password")).toBeUndefined();
  });

  it("ignores an empty command", () => {
    expect(findCredentialExposure("   ")).toBeUndefined();
  });
});

describe("credentialExposureReason", () => {
  const reason = credentialExposureReason({ kind: "command-line password flag" });

  it("says the work is fine and the call simply must be re-issued", () => {
    // A denial that reads as a permission wall is one the agent works around, which
    // here means finding another way to pass the same password.
    expect(reason).toMatch(/nothing has gone wrong/i);
    expect(reason).toMatch(/re-issue it without the secret/i);
  });

  it("explains that the command is persisted, which is the actual harm", () => {
    expect(reason).toMatch(/recorded verbatim/i);
  });

  it("carries no project knowledge", () => {
    // The harness may say a secret must not reach a command line; only a repository
    // can say which script resolves one.
    for (const leak of ["tools/sql", "Invoke-Sql", "qubeautoapp", ".env", "profiles"]) {
      expect(reason).not.toContain(leak);
    }
  });
});
