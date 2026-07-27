/**
 * Detection of Visual Studio solutions and .NET project flavour.
 *
 * Pure functions over a file listing and file contents (no I/O) so they can be
 * unit-tested against real project shapes.
 */

/** Which .NET a project targets. */
export type DotnetFlavour =
  /** .NET Framework (v4.x / net4x) — Windows-only, wants full Visual Studio. */
  | "framework"
  /** .NET 5+ / .NET Core — cross-platform, VS optional. */
  | "modern"
  /** A project file we couldn't classify. */
  | "unknown";

export interface VisualStudioProject {
  /** Worktree-relative path of the solution to open, if there is one. */
  solution?: string;
  /** Worktree-relative project files found (capped). */
  projects: string[];
  flavour: DotnetFlavour;
}

const SOLUTION_RE = /\.slnx?$/i;
const PROJECT_RE = /\.(cs|vb|fs)proj$/i;

/** Depth of a worktree-relative, forward-slashed path (0 = repository root). */
function depth(p: string): number {
  return p.split("/").length - 1;
}

/**
 * Chooses the solution to open when several exist: shallowest first (a root
 * solution is nearly always the entry point), then alphabetical so the choice
 * is stable rather than dependent on listing order.
 */
export function pickSolution(files: string[]): string | undefined {
  const solutions = files.filter((f) => SOLUTION_RE.test(f));
  if (solutions.length === 0) return undefined;
  return solutions.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
}

/** Project files, shallowest first, capped to keep classification cheap. */
export function findProjects(files: string[], limit = 20): string[] {
  return files
    .filter((f) => PROJECT_RE.test(f))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, limit);
}

/**
 * Classifies a project file's target framework.
 *
 * Handles both project styles, which express this differently:
 *   old-style  `<TargetFrameworkVersion>v4.8</TargetFrameworkVersion>`
 *   SDK-style  `<TargetFramework>net48</TargetFramework>` (or `net8.0`)
 * plus `<TargetFrameworks>` for multi-targeting, where any .NET Framework
 * target means Visual Studio is still the natural home.
 */
export function classifyProjectXml(xml: string): DotnetFlavour {
  // Old-style projects: v4.8, v3.5 — always .NET Framework.
  if (/<TargetFrameworkVersion\s*>\s*v\d/i.test(xml)) return "framework";

  const match = /<TargetFrameworks?\s*>([^<]+)<\/TargetFrameworks?>/i.exec(xml);
  if (!match) return "unknown";

  const targets = match[1]
    .split(";")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (targets.length === 0) return "unknown";

  // net48 / net472 are Framework; net5.0 and later are modern. The dot is the
  // discriminator: `net8.0` has one, `net48` does not.
  const isFramework = (t: string) => /^net\d{2,3}$/.test(t);
  const isModern = (t: string) => /^net\d+\.\d/.test(t) || t.startsWith("netcoreapp");

  if (targets.some(isFramework)) return "framework";
  if (targets.some(isModern)) return "modern";
  return "unknown";
}

/**
 * Combines flavours across a solution's projects. A single .NET Framework
 * project is enough to want Visual Studio, so it wins over "modern".
 */
export function combineFlavours(flavours: DotnetFlavour[]): DotnetFlavour {
  if (flavours.includes("framework")) return "framework";
  if (flavours.includes("modern")) return "modern";
  return "unknown";
}

/** One entry of `vswhere -format json`, reduced to what we use. */
export interface VsWhereInstance {
  productPath?: string;
  installationVersion?: string;
  displayName?: string;
}

/**
 * Picks the real Visual Studio IDE from a `vswhere` listing.
 *
 * `vswhere -latest -products *` is not safe to trust: other products are built
 * on the Visual Studio shell and are reported alongside it — on this machine
 * SQL Server Management Studio 22 was returned as "latest", ahead of Visual
 * Studio itself. Only `devenv.exe` opens a solution as expected, so require it,
 * then take the highest installation version.
 */
export function pickDevenv(instances: VsWhereInstance[]): string | undefined {
  const versionKey = (v: string | undefined) =>
    (v ?? "").split(".").map((part) => Number(part) || 0);
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (b[i] ?? 0) - (a[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  return instances
    .filter((i) => typeof i.productPath === "string" && /[\\/]devenv\.exe$/i.test(i.productPath))
    .sort((a, b) => compare(versionKey(a.installationVersion), versionKey(b.installationVersion)))
    .map((i) => i.productPath)[0];
}

/**
 * Detects a Visual Studio project from a file listing alone. Classification
 * needs file contents, so the caller supplies flavour separately.
 */
export function detectFromFiles(files: string[]): Omit<VisualStudioProject, "flavour"> | undefined {
  const solution = pickSolution(files);
  const projects = findProjects(files);
  if (!solution && projects.length === 0) return undefined;
  return { solution, projects };
}
