import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets, REDACTED } from "./secretRedaction";

describe("redactSecrets", () => {
  it("masks a SQL connection string password but keeps the rest readable", () => {
    // The case that prompted this: a route builds one of these from a profile and
    // passes it to a deployment script, so it landed in the state file verbatim.
    const text =
      "Server=tcp:qube.database.windows.net;Database=Core;User ID=deploy;Password=S3cr3t!Value;Encrypt=True";
    const out = redactSecrets(text);
    expect(out).not.toContain("S3cr3t!Value");
    expect(out).toContain("Password=" + REDACTED);
    expect(out).toContain("Server=tcp:qube.database.windows.net");
    expect(out).toContain("User ID=deploy");
    expect(out).toContain("Encrypt=True");
  });

  it("masks the PowerShell flag forms", () => {
    expect(redactSecrets("./Deploy.ps1 -Password Hunter2 -Server dev")).toBe(
      `./Deploy.ps1 -Password ${REDACTED} -Server dev`,
    );
    expect(redactSecrets("sqlcmd --password=Hunter2 -Q x")).toContain(REDACTED);
    expect(redactSecrets("sqlcmd --password=Hunter2 -Q x")).not.toContain("Hunter2");
  });

  it("keeps the flag itself, so the command is still recognisable", () => {
    expect(redactSecrets("./Deploy.ps1 -Password Hunter2")).toContain("-Password");
  });

  it("masks quoted values", () => {
    expect(redactSecrets('Password="a b c";Database=X')).toBe(
      `Password=${REDACTED};Database=X`,
    );
  });

  it("masks credentials in a URL", () => {
    expect(redactSecrets("git push https://conor:ghp_abcdefghij1234567890@github.com/x")).toBe(
      `git push https://conor:${REDACTED}@github.com/x`,
    );
  });

  it("masks tokens by shape, even when nothing names them", () => {
    for (const token of [
      "ghp_abcdefghij1234567890",
      "xoxb-1234567890-abcdefghij",
      "sk-ant-api03-abcdefghij1234567890",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ]) {
      expect(redactSecrets(`value was ${token} apparently`)).not.toContain(token);
    }
  });

  it("masks a bearer header", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghij1234567890")).not.toContain(
      "abcdefghij1234567890",
    );
  });

  it("masks several on one line", () => {
    const out = redactSecrets("Password=one;Token=two;Database=keep");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).toContain("Database=keep");
  });

  it("leaves ordinary text and paths alone", () => {
    // Over-masking has a cost too: a report that hides the command is no more
    // use than one that was never recorded.
    const text =
      "./tools/sql/Invoke-SqlDeployment.ps1 -WhatIf -Project SC-123 -Environment DEV";
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("Resolved SQL files: 2\nNo changes.")).toBe(
      "Resolved SQL files: 2\nNo changes.",
    );
  });

  it("does not mask a filename that merely mentions a secret", () => {
    // `.env` profile paths are how the route locates credentials, and seeing which
    // profile was used is exactly what makes a report worth reading.
    const text = "Read tools/mcp/profiles/Renault.dev.env";
    expect(redactSecrets(text)).toBe(text);
  });

  it("does not mask an empty assignment", () => {
    expect(redactSecrets("Password=")).toBe("Password=");
  });

  it("is safe on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("containsSecret", () => {
  it("reports whether anything was masked", () => {
    expect(containsSecret("Password=x")).toBe(true);
    expect(containsSecret("just text")).toBe(false);
  });
});

describe("single-letter credential flags", () => {
  it("masks sqlcmd -P, the case that actually leaked", () => {
    // No word resembling "password" anywhere on the line, which is why both the
    // named patterns and the cheap early-exit missed it entirely.
    const out = redactSecrets("sqlcmd -S qube.db -U deploy -P Hunter2 -Q \"SELECT 1\"");
    expect(out).not.toContain("Hunter2");
    expect(out).toContain("-P " + REDACTED);
    // The user name and server stay: they are how you tell which target it hit.
    expect(out).toContain("-U deploy");
    expect(out).toContain("-S qube.db");
    expect(out).toContain("SELECT 1");
  });

  it("masks the -P:value form", () => {
    expect(redactSecrets("bcp Core.dbo.T in f.dat -U sa -P:Hunter2")).not.toContain("Hunter2");
  });

  it("masks mysql's attached -pvalue", () => {
    const out = redactSecrets("mysql -u root -pHunter2 core");
    expect(out).not.toContain("Hunter2");
    expect(out).toContain("-p" + REDACTED);
  });

  it("masks curl -u, whose value carries the password too", () => {
    expect(redactSecrets("curl -u conor:Hunter2 https://api.example.com")).not.toContain(
      "Hunter2",
    );
  });

  it("leaves -p alone when no credential-taking tool is named", () => {
    // -p is a port or a path far more often than a password.
    const text = "docker run -p 8080:80 nginx";
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("mkdir -p tools/sql/projects/SC-123")).toBe(
      "mkdir -p tools/sql/projects/SC-123",
    );
  });

  it("does not mask a port on a line that happens to name curl", () => {
    // Scoped per line, so one mention of a tool cannot mask a whole document.
    const out = redactSecrets("mkdir -p out\ncurl -u a:b http://x\nmkdir -p two");
    expect(out).toContain("mkdir -p out");
    expect(out).toContain("mkdir -p two");
    expect(out).not.toContain("a:b");
  });
});
