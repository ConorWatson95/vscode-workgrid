import { describe, it, expect } from "vitest";
import {
  pickSolution,
  findProjects,
  classifyProjectXml,
  combineFlavours,
  detectFromFiles,
  pickDevenv,
} from "./visualStudio";

describe("pickSolution", () => {
  it("prefers a solution at the repository root", () => {
    expect(pickSolution(["src/Nested.sln", "App.sln", "README.md"])).toBe("App.sln");
  });

  it("is stable when several sit at the same depth", () => {
    expect(pickSolution(["src/b.sln", "src/a.sln"])).toBe("src/a.sln");
  });

  it("accepts the newer .slnx format and is case-insensitive", () => {
    expect(pickSolution(["App.SLNX"])).toBe("App.SLNX");
  });

  it("returns undefined when there is no solution", () => {
    expect(pickSolution(["package.json", "src/main.ts"])).toBeUndefined();
  });
});

describe("findProjects", () => {
  it("finds C#, VB and F# projects, shallowest first", () => {
    const files = ["src/deep/C.fsproj", "B.vbproj", "A.csproj", "notes.txt"];
    expect(findProjects(files)).toEqual(["A.csproj", "B.vbproj", "src/deep/C.fsproj"]);
  });

  it("caps how many are returned", () => {
    const files = Array.from({ length: 50 }, (_, i) => `P${i}.csproj`);
    expect(findProjects(files, 5)).toHaveLength(5);
  });
});

describe("classifyProjectXml", () => {
  it("detects old-style .NET Framework projects", () => {
    const xml = `<Project ToolsVersion="15.0">
      <PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup>
    </Project>`;
    expect(classifyProjectXml(xml)).toBe("framework");
  });

  it("detects SDK-style net48 as Framework and net8.0 as modern", () => {
    const framework = `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>`;
    const modern = `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`;
    expect(classifyProjectXml(framework)).toBe("framework");
    expect(classifyProjectXml(modern)).toBe("modern");
  });

  it("treats netcoreapp as modern", () => {
    const xml = `<TargetFramework>netcoreapp3.1</TargetFramework>`;
    expect(classifyProjectXml(xml)).toBe("modern");
  });

  it("reports Framework when multi-targeting includes it", () => {
    const xml = `<TargetFrameworks>net48;net8.0</TargetFrameworks>`;
    expect(classifyProjectXml(xml)).toBe("framework");
  });

  it("returns unknown rather than guessing", () => {
    expect(classifyProjectXml("<Project></Project>")).toBe("unknown");
    expect(classifyProjectXml("")).toBe("unknown");
  });
});

describe("combineFlavours", () => {
  it("lets a single Framework project win, since it needs Visual Studio", () => {
    expect(combineFlavours(["modern", "framework", "unknown"])).toBe("framework");
  });
  it("falls back through modern to unknown", () => {
    expect(combineFlavours(["unknown", "modern"])).toBe("modern");
    expect(combineFlavours([])).toBe("unknown");
  });
});

describe("detectFromFiles", () => {
  it("detects a solution with its projects", () => {
    const found = detectFromFiles(["App.sln", "src/App.csproj"]);
    expect(found).toEqual({ solution: "App.sln", projects: ["src/App.csproj"] });
  });

  it("detects a bare project with no solution", () => {
    expect(detectFromFiles(["App.csproj"])).toEqual({
      solution: undefined,
      projects: ["App.csproj"],
    });
  });

  it("returns undefined for a non-.NET worktree", () => {
    expect(detectFromFiles(["package.json", "src/main.ts", "README.md"])).toBeUndefined();
  });
});

describe("pickDevenv", () => {
  it("ignores VS-shell products that are not Visual Studio", () => {
    // Real output from this machine: vswhere -latest reported SSMS ahead of VS.
    const instances = [
      {
        displayName: "SQL Server Management Studio 22",
        installationVersion: "22.1.3",
        productPath: "C:\\Program Files\\Microsoft SQL Server Management Studio 22\\Release\\Common7\\IDE\\Ssms.exe",
      },
      {
        displayName: "Visual Studio Community 2026",
        installationVersion: "18.0.1",
        productPath: "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\devenv.exe",
      },
    ];
    expect(pickDevenv(instances)).toBe(
      "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\devenv.exe",
    );
  });

  it("picks the newest install, comparing versions numerically", () => {
    const instances = [
      { installationVersion: "17.9.0", productPath: "C:\\VS\\17\\devenv.exe" },
      { installationVersion: "18.0.1", productPath: "C:\\VS\\18\\devenv.exe" },
      { installationVersion: "9.0.0", productPath: "C:\\VS\\9\\devenv.exe" },
    ];
    expect(pickDevenv(instances)).toBe("C:\\VS\\18\\devenv.exe");
  });

  it("returns undefined when no Visual Studio is installed", () => {
    expect(pickDevenv([])).toBeUndefined();
    expect(pickDevenv([{ productPath: "C:\\Other\\Ssms.exe" }])).toBeUndefined();
  });
});
