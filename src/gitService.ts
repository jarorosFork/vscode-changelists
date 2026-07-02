import * as vscode from 'vscode';
import * as path from 'path';
import type { API, GitExtension, Repository } from './git';
import { Repo } from './repo';

export type { WorkingChange } from './repo';
export { Repo } from './repo';

/**
 * Tracks every open git repository in the workspace and owns one Repo (git
 * operations + its own ChangelistManager) per repository, created when it
 * opens and disposed when it closes.
 */
export class GitService {
  private api!: API;
  private readonly repoMap = new Map<Repository, Repo>();

  private readonly _onDidChangeRepos = new vscode.EventEmitter<void>();
  /** Fires only when the SET of open repositories changes (not per-file changes). */
  readonly onDidChangeRepos = this._onDidChangeRepos.event;

  constructor(private readonly legacyMemento?: vscode.Memento) {}

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) throw new Error('The built-in Git extension is not available.');
    if (!ext.isActive) await ext.activate();
    this.api = ext.exports.getAPI(1);
    for (const r of this.api.repositories) this.addRepo(r);
    this.api.onDidOpenRepository((r) => {
      this.addRepo(r);
      this._onDidChangeRepos.fire();
    });
    this.api.onDidCloseRepository((r) => {
      this.removeRepo(r);
      this._onDidChangeRepos.fire();
    });
    // The git extension normally closes a repository itself when its
    // containing workspace folder is removed, which the listener above
    // already handles via onDidCloseRepository. Don't rely solely on that,
    // though — cross-check directly against the live workspace folder list
    // so a removed folder's changelist disappears even if the git extension
    // is slow to close it (or doesn't, for some edge-case repo layout).
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.pruneOrphanedRepos()) this._onDidChangeRepos.fire();
    });
  }

  private addRepo(r: Repository) {
    if (this.repoMap.has(r)) return;
    this.repoMap.set(r, new Repo(r, this.legacyMemento));
  }

  private removeRepo(r: Repository) {
    this.repoMap.get(r)?.dispose();
    this.repoMap.delete(r);
  }

  /** Drop any tracked repo whose root no longer falls under an open workspace folder. */
  private pruneOrphanedRepos(): boolean {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    let changed = false;
    for (const [raw, repo] of this.repoMap) {
      const stillOpen = folders.some(
        (f) => repo.rootFsPath === f || repo.rootFsPath.startsWith(f + path.sep),
      );
      if (!stillOpen) {
        this.removeRepo(raw);
        changed = true;
      }
    }
    return changed;
  }

  /** All open repositories, sorted by folder name for a stable display order. */
  get repos(): Repo[] {
    return [...this.repoMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Fires when the repo set changes (open, close, or a removed workspace
   * folder pruning a repo), or any currently-open repo's own state changes.
   * Built on top of onDidChangeRepos rather than the raw git API events
   * directly, so every path that can add/remove a repo — including the
   * defensive workspace-folder prune above — reliably triggers a refresh.
   */
  onDidChange(listener: () => void): vscode.Disposable {
    const stateDisposables: vscode.Disposable[] = [];
    const resubscribe = () => {
      stateDisposables.forEach((d) => d.dispose());
      stateDisposables.length = 0;
      for (const repo of this.repoMap.keys()) stateDisposables.push(repo.state.onDidChange(listener));
    };
    resubscribe();
    const reposSub = this.onDidChangeRepos(() => {
      resubscribe();
      listener();
    });
    return new vscode.Disposable(() => {
      stateDisposables.forEach((d) => d.dispose());
      reposSub.dispose();
    });
  }
}
