import * as vscode from 'vscode';
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
  }

  private addRepo(r: Repository) {
    if (this.repoMap.has(r)) return;
    this.repoMap.set(r, new Repo(r, this.legacyMemento));
  }

  private removeRepo(r: Repository) {
    this.repoMap.get(r)?.dispose();
    this.repoMap.delete(r);
  }

  /** All open repositories, sorted by folder name for a stable display order. */
  get repos(): Repo[] {
    return [...this.repoMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Fires when the repo set changes, or any open repo's own state changes. */
  onDidChange(listener: () => void): vscode.Disposable {
    const stateDisposables: vscode.Disposable[] = [];
    const resubscribe = () => {
      stateDisposables.forEach((d) => d.dispose());
      stateDisposables.length = 0;
      for (const repo of this.repoMap.keys()) stateDisposables.push(repo.state.onDidChange(listener));
    };
    resubscribe();
    const openSub = this.api.onDidOpenRepository(() => {
      resubscribe();
      listener();
    });
    const closeSub = this.api.onDidCloseRepository(() => {
      resubscribe();
      listener();
    });
    return new vscode.Disposable(() => {
      stateDisposables.forEach((d) => d.dispose());
      openSub.dispose();
      closeSub.dispose();
    });
  }
}
