import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Status } from './git';
import type { Repository, Change } from './git';
import { ChangelistManager } from './changelistManager';

const execFileAsync = promisify(execFile);

export interface WorkingChange {
  uri: vscode.Uri;
  fsPath: string;
  status: Status;
  staged: boolean;
  untracked: boolean;
}

/**
 * Everything scoped to a single git repository: its working-tree state, git
 * operations, and its own ChangelistManager. One instance per repository in
 * the workspace, created when the repo opens and discarded when it closes.
 */
export class Repo {
  readonly manager: ChangelistManager;
  readonly rootFsPath: string;

  constructor(
    readonly repository: Repository,
    legacyMemento?: vscode.Memento,
  ) {
    this.rootFsPath = repository.rootUri.fsPath;
    this.manager = new ChangelistManager(this.rootFsPath, legacyMemento);
  }

  get name(): string {
    return path.basename(this.rootFsPath);
  }

  dispose() {
    this.manager.dispose();
  }

  /** All changed files in the working tree + index, deduped by path. */
  getChanges(): WorkingChange[] {
    const out = new Map<string, WorkingChange>();
    const add = (c: Change, staged: boolean) => {
      const fsPath = c.uri.fsPath;
      // index entry wins for status display but we keep "staged" if either says so
      const prev = out.get(fsPath);
      out.set(fsPath, {
        uri: c.uri,
        fsPath,
        status: prev ? prev.status : c.status,
        staged: staged || (prev?.staged ?? false),
        // Derived from the change's own status, NOT from which state array it
        // came from: when the "git.untrackedChanges" setting is "mixed" (the
        // VSCode default), untracked files are reported via workingTreeChanges
        // rather than untrackedChanges, so relying on the array would silently
        // misclassify them as tracked.
        untracked: c.status === Status.UNTRACKED || (prev?.untracked ?? false),
      });
    };
    this.repository.state.indexChanges.forEach((c) => add(c, true));
    this.repository.state.workingTreeChanges.forEach((c) => add(c, false));
    this.repository.state.untrackedChanges.forEach((c) => add(c, false));
    return [...out.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /**
   * Commit only the given files. Mirrors JetBrains: stage exactly these paths,
   * leave everything else untouched, commit, done.
   */
  async commitFiles(fsPaths: string[], message: string, opts?: { amend?: boolean }): Promise<void> {
    // Amending with zero files just rewords the previous commit; otherwise a
    // commit needs at least one file.
    if (fsPaths.length === 0 && !opts?.amend) {
      throw new Error('No files to commit in this changelist.');
    }

    // Unstage everything first so other changelists never sneak into the commit.
    const allStaged = this.repository.state.indexChanges.map((c) => c.uri.fsPath);
    if (allStaged.length) await this.repository.revert(allStaged);

    if (fsPaths.length) await this.repository.add(fsPaths);
    await this.repository.commit(message, { amend: opts?.amend });
  }

  /** The message of the most recent commit, used to prefill "amend". */
  async lastCommitMessage(): Promise<string | undefined> {
    try {
      const [last] = await this.repository.log({ maxEntries: 1 });
      return last?.message;
    } catch {
      return undefined;
    }
  }

  get currentBranch(): string | undefined {
    return this.repository.state.HEAD?.name;
  }

  get upstream(): { remote: string; name: string } | undefined {
    return this.repository.state.HEAD?.upstream;
  }

  get hasUpstream(): boolean {
    return !!this.upstream;
  }

  get remoteNames(): string[] {
    return this.repository.state.remotes.map((r) => r.name);
  }

  /**
   * Push the current branch. If it has no upstream yet, the caller must pass
   * a remote name and set `setUpstream` so the branch starts tracking it.
   */
  async push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void> {
    await this.repository.push(remoteName, branchName, setUpstream);
  }

  /** Update remote-tracking refs (e.g. `origin/main`) without touching the working tree. */
  async fetch(remote?: string, ref?: string): Promise<void> {
    await this.repository.fetch(remote, ref);
  }

  /** Local and remote branches (excluding the current branch), for "update from" pickers. */
  async listBranches(): Promise<{ name: string; isRemote: boolean }[]> {
    const current = this.repository.state.HEAD?.name;
    const [locals, remotes] = await Promise.all([
      this.repository.getBranches({ remote: false }),
      this.repository.getBranches({ remote: true }),
    ]);
    const out: { name: string; isRemote: boolean }[] = [];
    for (const r of locals) if (r.name && r.name !== current) out.push({ name: r.name, isRemote: false });
    for (const r of remotes) if (r.name) out.push({ name: r.name, isRemote: true });
    return out;
  }

  async mergeRef(ref: string): Promise<void> {
    await this.repository.merge(ref);
  }

  async rebaseOnto(ref: string): Promise<void> {
    await this.repository.rebase(ref);
  }

  /**
   * Discard local changes for the given files, restoring them to HEAD
   * (`git clean`/`git checkout`). For untracked files this deletes them.
   * Mirrors JetBrains "Rollback". Irreversible.
   */
  async discardChanges(fsPaths: string[]): Promise<void> {
    if (fsPaths.length === 0) return;
    // Unstage first so clean restores both index and working tree to HEAD.
    const staged = this.repository.state.indexChanges
      .map((c) => c.uri.fsPath)
      .filter((p) => fsPaths.includes(p));
    if (staged.length) await this.repository.revert(staged);
    await this.repository.clean(fsPaths);
  }

  /**
   * Start tracking untracked files without staging them (`git add -N`).
   * The file then shows up as an intent-to-add change, so it can be placed in
   * a changelist and committed — mirrors JetBrains "Add to VCS".
   */
  async intentToAdd(fsPaths: string[]): Promise<void> {
    if (fsPaths.length === 0) return;
    await execFileAsync('git', ['add', '-N', '--', ...fsPaths], {
      cwd: this.rootFsPath,
    });
  }

  /**
   * Inverse of intentToAdd: unstage a newly-added file (INDEX_ADDED or
   * INTENT_TO_ADD, i.e. no HEAD version) so it reverts to untracked — mirrors
   * dragging a file back out to "Unversioned Files".
   */
  async unstage(fsPaths: string[]): Promise<void> {
    if (fsPaths.length === 0) return;
    await this.repository.revert(fsPaths);
  }
}
