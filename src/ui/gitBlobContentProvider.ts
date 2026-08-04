import * as vscode from "vscode";

export const BLOB_SCHEME = "taskworkspaces-blob";

/** Reads one path at one revision. Narrow on purpose, so tests need no git. */
export type BlobReader = (
  worktreePath: string,
  revision: string,
  path: string,
) => Promise<string | undefined>;

/**
 * Serves a file's contents at a git revision, so the file-by-file view can show
 * a real before/after comparison without checking anything out.
 *
 * The empty revision is meaningful: it is the "this side does not exist" side of
 * an added or deleted file, and an empty document is exactly what the diff editor
 * needs there.
 */
export class GitBlobContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly read: BlobReader) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const worktreePath = params.get("cwd");
    const revision = params.get("rev") ?? "";
    const path = uri.path.replace(/^\//, "");
    if (!worktreePath || !revision) return "";

    // A missing blob is not an error here: git reports "path does not exist in
    // <rev>" for a file the task added, and the caller has already decided that
    // side should be empty.
    return (await this.read(worktreePath, revision, path)) ?? "";
  }

  /**
   * The "before" side of a file. Pass an empty revision for a file that did not
   * exist at the base.
   *
   * The path is kept in the URI's path, not the query, so the diff editor infers
   * the language from its extension — a `.sql` before-side rendered as plain text
   * next to a highlighted after-side reads as though something were wrong with it.
   */
  uriFor(worktreePath: string, revision: string, path: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: BLOB_SCHEME,
      path: `/${path.replace(/^\/+/, "")}`,
      query: new URLSearchParams({ cwd: worktreePath, rev: revision }).toString(),
    });
  }

  /** An empty document, for the missing side of an added or deleted file. */
  emptyUriFor(path: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: BLOB_SCHEME,
      path: `/${path.replace(/^\/+/, "")}`,
      query: "",
    });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
