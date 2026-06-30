import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API, GitExtension, Repository, Change, Status } from './git';

const execFileAsync = promisify(execFile);

export interface WorkingChange {
  uri: vscode.Uri;
  fsPath: string;
  status: Status;
  staged: boolean;
  untracked: boolean;
}

export class GitService {
  private api!: API;

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) throw new Error('The built-in Git extension is not available.');
    if (!ext.isActive) await ext.activate();
    this.api = ext.exports.getAPI(1);
  }

  get repository(): Repository | undefined {
    return this.api?.repositories[0];
  }

  /** Fires whenever the repo state or set of repos changes. */
  onDidChange(listener: () => void): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    const subscribe = () => {
      const repo = this.repository;
      if (repo) disposables.push(repo.state.onDidChange(listener));
    };
    subscribe();
    disposables.push(this.api.onDidOpenRepository(() => { subscribe(); listener(); }));
    disposables.push(this.api.onDidCloseRepository(() => listener()));
    return new vscode.Disposable(() => disposables.forEach((d) => d.dispose()));
  }

  /** All changed files in the working tree + index, deduped by path. */
  getChanges(): WorkingChange[] {
    const repo = this.repository;
    if (!repo) return [];
    const out = new Map<string, WorkingChange>();
    const add = (c: Change, staged: boolean, untracked = false) => {
      const fsPath = c.uri.fsPath;
      // index entry wins for status display but we keep "staged" if either says so
      const prev = out.get(fsPath);
      out.set(fsPath, {
        uri: c.uri,
        fsPath,
        status: prev ? prev.status : c.status,
        staged: staged || (prev?.staged ?? false),
        untracked: untracked || (prev?.untracked ?? false),
      });
    };
    repo.state.indexChanges.forEach((c) => add(c, true));
    repo.state.workingTreeChanges.forEach((c) => add(c, false));
    repo.state.untrackedChanges.forEach((c) => add(c, false, true));
    return [...out.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /**
   * Commit only the given files. Mirrors JetBrains: stage exactly these paths,
   * leave everything else untouched, commit, done.
   */
  async commitFiles(fsPaths: string[], message: string): Promise<void> {
    const repo = this.repository;
    if (!repo) throw new Error('No git repository found.');
    if (fsPaths.length === 0) throw new Error('No files to commit in this changelist.');

    // Unstage everything first so other changelists never sneak into the commit.
    const allStaged = repo.state.indexChanges.map((c) => c.uri.fsPath);
    if (allStaged.length) await repo.revert(allStaged);

    await repo.add(fsPaths);
    await repo.commit(message);
  }

  /**
   * Discard local changes for the given files, restoring them to HEAD
   * (`git clean`/`git checkout`). For untracked files this deletes them.
   * Mirrors JetBrains "Rollback". Irreversible.
   */
  async discardChanges(fsPaths: string[]): Promise<void> {
    const repo = this.repository;
    if (!repo || fsPaths.length === 0) return;
    // Unstage first so clean restores both index and working tree to HEAD.
    const staged = repo.state.indexChanges
      .map((c) => c.uri.fsPath)
      .filter((p) => fsPaths.includes(p));
    if (staged.length) await repo.revert(staged);
    await repo.clean(fsPaths);
  }

  /**
   * Start tracking untracked files without staging them (`git add -N`).
   * The file then shows up as an intent-to-add change, so it can be placed in
   * a changelist and committed — mirrors JetBrains "Add to VCS".
   */
  async intentToAdd(fsPaths: string[]): Promise<void> {
    const repo = this.repository;
    if (!repo || fsPaths.length === 0) return;
    await execFileAsync('git', ['add', '-N', '--', ...fsPaths], {
      cwd: repo.rootUri.fsPath,
    });
  }
}
