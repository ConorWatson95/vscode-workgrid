import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SERVER_BUNDLE_DIR,
  SERVER_BUNDLE_FILES,
  installServerBundle,
  installedBundleVersion,
  isNewerVersion,
} from "../services/serverBundleInstaller";
import { loadHeadlessSettings } from "./headlessHost";

/**
 * `update`: installs the latest release's server and runner into the stable folder.
 *
 * Until now the only thing that refreshed that folder was VS Code activating a newer
 * extension, so a machine driven from Claude ran whichever server it last got from an
 * editor. This fetches the release instead — the same two files the release attaches —
 * and installs them through `installServerBundle`, so the copy is atomic and the
 * version marker means neither writer can put an older release back over a newer one.
 *
 * Refuses a downgrade unless `--force`. Prints one JSON line saying what it did.
 */
export const RELEASE_REPOSITORY = "ConorWatson95/vscode-workgrid";

export interface ReleaseBundle {
  version: string;
  /** File name → download URL, for every bundle file the release attaches. */
  assets: Record<string, string>;
}

/**
 * Reads what `GET /releases/latest` returned. A release missing either file is refused
 * rather than half installed: a new server beside an old runner is the pairing the
 * stable folder exists to prevent.
 */
export function releaseBundle(release: unknown): ReleaseBundle | string {
  const value = release as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] };
  const tag = typeof value?.tag_name === "string" ? value.tag_name : undefined;
  if (!tag) return "the release has no tag";
  const assets: Record<string, string> = {};
  for (const asset of Array.isArray(value.assets) ? value.assets : []) {
    if (typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
      assets[asset.name] = asset.browser_download_url;
    }
  }
  const missing = SERVER_BUNDLE_FILES.filter((name) => !assets[name]);
  if (missing.length > 0) return `release ${tag} does not attach ${missing.join(" or ")}`;
  return { version: tag.replace(/^v/, ""), assets };
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "task-workspaces-harness", Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  return response;
}

export async function update(): Promise<void> {
  const force = process.argv.includes("--force");
  const targetDir = path.join(loadHeadlessSettings(process.cwd()).storageDir, SERVER_BUNDLE_DIR);
  const report = (result: Record<string, unknown>, code = 0): never => {
    process.stdout.write(`${JSON.stringify({ target: targetDir, ...result })}\n`);
    process.exit(code);
  };

  let bundle: ReleaseBundle | string;
  try {
    const release = await fetchOk(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`);
    bundle = releaseBundle(await release.json());
  } catch (error) {
    return report({ updated: false, error: `could not read the latest release: ${String(error)}` }, 1);
  }
  if (typeof bundle === "string") return report({ updated: false, error: bundle }, 1);

  const installed = installedBundleVersion(targetDir);
  if (!force && installed && !isNewerVersion(bundle.version, installed)) {
    return report({ updated: false, installed, latest: bundle.version });
  }

  // Downloaded beside each other first, so the install is the same copy-and-rename VS
  // Code's activation does and a failed download leaves the stable folder untouched.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "harness-update-"));
  try {
    for (const name of SERVER_BUNDLE_FILES) {
      const response = await fetchOk(bundle.assets[name]);
      fs.writeFileSync(path.join(staging, name), Buffer.from(await response.arrayBuffer()));
    }
    const logged: string[] = [];
    const logger = {
      info: (m: string) => void logged.push(m),
      warn: (m: string) => void logged.push(m),
      error: (m: string) => void logged.push(m),
      debug: () => undefined,
    };
    const result = installServerBundle(staging, targetDir, logger, undefined, {
      version: bundle.version,
      force,
    });
    if (!result) return report({ updated: false, error: logged.join(" ") || "install failed" }, 1);
    return report({
      updated: result.updated.length > 0,
      from: installed ?? null,
      to: bundle.version,
      files: result.updated,
    });
  } catch (error) {
    return report({ updated: false, error: `could not download the release: ${String(error)}` }, 1);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
