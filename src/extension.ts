import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_CHANGELIST, ChangelistManager } from './changelistManager';
import { GitService } from './gitService';
import { Repo, WorkingChange } from './repo';
import { ChangelistTreeProvider, RepoNode, ChangelistNode, ChangeNode } from './treeProvider';
import { Status } from './git';
import { CommitPanel } from './commitPanel';

export async function activate(context: vscode.ExtensionContext) {
  const git = new GitService(context.workspaceState);
  try {
    await git.init();
  } catch (err) {
    vscode.window.showErrorMessage(`Changelists: ${(err as Error).message}`);
    return;
  }

  const provider = new ChangelistTreeProvider(git);
  // Resolves to empty content; used as the right side when diffing a deleted file.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
  );

  const view = vscode.window.createTreeView('changelists.view', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    canSelectMany: true,
  });
  context.subscriptions.push(view);

  // Hides the single-repo title-bar Pull/Push/Commit/New-Changelist/Update-from-Branch
  // buttons in favor of per-folder equivalents once there's more than one repo open —
  // those actions are ambiguous ("pull which folder?") without a specific repo.
  const updateMultiRepoContext = () => {
    void vscode.commands.executeCommand('setContext', 'changelists.multiRepo', git.repos.length > 1);
  };
  updateMultiRepoContext();
  context.subscriptions.push(git.onDidChangeRepos(updateMultiRepoContext));

  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('changelists.refresh', () => provider.refresh());

  reg('changelists.pull', async (node?: RepoNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const upstream = repo.upstream;
    if (!upstream) {
      const branch = repo.currentBranch;
      vscode.window.showInformationMessage(
        branch
          ? `"${branch}" has no upstream branch yet — there's nothing to pull until you push it.`
          : 'Current branch has no upstream branch yet — push it first.',
      );
      return;
    }
    // Never call plain "git pull": with no pull.rebase/pull.ff configured,
    // git refuses with "you have divergent branches, please reconcile" the
    // moment histories diverge. Instead fetch, then explicitly merge or
    // rebase per the configured strategy — same as JetBrains' "Update Method"
    // setting, so there's never an ambiguous state to hit.
    const strategy = vscode.workspace
      .getConfiguration('changelists')
      .get<'merge' | 'rebase'>('pullStrategy', 'merge');
    const ref = `${upstream.remote}/${upstream.name}`;
    try {
      await repo.fetch(upstream.remote, upstream.name);
      if (strategy === 'rebase') await repo.rebaseOnto(ref);
      else await repo.mergeRef(ref);
      provider.refresh();
      vscode.window.showInformationMessage(`Pulled (${strategy}) from ${ref}.`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Pull failed: ${(err as Error).message}. If there are conflicts, resolve them in the Source ` +
          `Control view, then use "Continue" (rebase) or commit (merge) to finish.`,
      );
    }
  });

  reg('changelists.push', async (node?: RepoNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    try {
      if (repo.hasUpstream) {
        await repo.push();
        vscode.window.showInformationMessage('Pushed.');
        return;
      }
      // No upstream yet (e.g. a brand new branch) — ask which remote to publish to.
      const branch = repo.currentBranch;
      if (!branch) {
        vscode.window.showErrorMessage('No current branch to push.');
        return;
      }
      const remotes = repo.remoteNames;
      if (remotes.length === 0) {
        vscode.window.showErrorMessage('No git remotes configured.');
        return;
      }
      const remote =
        remotes.length === 1
          ? remotes[0]
          : await vscode.window.showQuickPick(remotes, {
              placeHolder: `"${branch}" has no upstream — choose a remote to publish to`,
            });
      if (!remote) return;
      await repo.push(remote, branch, true);
      vscode.window.showInformationMessage(`Pushed and set upstream to ${remote}/${branch}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Push failed: ${(err as Error).message}`);
    }
  });

  reg('changelists.updateFromBranch', async (node?: RepoNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const current = repo.currentBranch;
    if (!current) {
      vscode.window.showErrorMessage('Not currently on a branch.');
      return;
    }
    const branches = await repo.listBranches();
    if (branches.length === 0) {
      vscode.window.showInformationMessage('No other branches found.');
      return;
    }
    // Float likely default branches (main/master) to the top of the picker.
    const rank = (name: string) => {
      const short = name.split('/').pop();
      return short === 'main' || short === 'master' ? 0 : 1;
    };
    branches.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

    const branchPick = await vscode.window.showQuickPick(
      branches.map((b) => ({
        label: `${b.isRemote ? '$(cloud)' : '$(git-branch)'} ${b.name}`,
        description: b.isRemote ? 'remote' : 'local',
        ref: b.name,
        isRemote: b.isRemote,
      })),
      { placeHolder: `Fetch and update "${current}" from…` },
    );
    if (!branchPick) return;

    const modePick = await vscode.window.showQuickPick(
      [
        { label: 'Rebase', description: `Replay "${current}" on top of ${branchPick.ref}`, mode: 'rebase' as const },
        { label: 'Merge', description: `Merge ${branchPick.ref} into "${current}"`, mode: 'merge' as const },
      ],
      { placeHolder: 'How do you want to update?' },
    );
    if (!modePick) return;

    try {
      if (branchPick.isRemote) {
        const [remote, ...rest] = branchPick.ref.split('/');
        await repo.fetch(remote, rest.join('/'));
      } else {
        await repo.fetch(); // refresh remote-tracking refs in case they're stale
      }
      if (modePick.mode === 'rebase') await repo.rebaseOnto(branchPick.ref);
      else await repo.mergeRef(branchPick.ref);
      provider.refresh();
      const verb = modePick.mode === 'rebase' ? 'Rebased' : 'Merged';
      vscode.window.showInformationMessage(`${verb} "${current}" onto ${branchPick.ref}.`);
    } catch (err) {
      const verb = modePick.mode === 'rebase' ? 'Rebase' : 'Merge';
      vscode.window.showErrorMessage(
        `${verb} failed: ${(err as Error).message}. If there are conflicts, resolve them in the ` +
          `Source Control view, then use "Continue" (rebase) or commit (merge) to finish.`,
      );
    }
  });

  reg('changelists.createChangelist', async (node?: RepoNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const name = await vscode.window.showInputBox({
      prompt: 'New changelist name',
      validateInput: (v) =>
        repo.manager.getChangelists().includes(v.trim())
          ? 'A changelist with this name already exists'
          : undefined,
    });
    if (name && !repo.manager.createChangelist(name)) {
      vscode.window.showWarningMessage('Could not create changelist.');
    }
  });

  reg('changelists.renameChangelist', async (node?: ChangelistNode) => {
    if (!node) return;
    if (node.name === DEFAULT_CHANGELIST) {
      vscode.window.showWarningMessage('The default changelist cannot be renamed.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Rename changelist', value: node.name });
    if (name) node.repo.manager.renameChangelist(node.name, name);
  });

  reg('changelists.deleteChangelist', (node?: ChangelistNode) => {
    if (!node) return;
    if (!node.repo.manager.deleteChangelist(node.name)) {
      vscode.window.showWarningMessage('The default changelist cannot be deleted.');
    }
  });

  reg('changelists.setActiveChangelist', (node?: ChangelistNode) => {
    if (node) node.repo.manager.setActive(node.name);
  });

  reg('changelists.commitSelected', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes).filter((n) => !n.change.untracked);
    if (selected.length === 0) return;
    const repo = selected[0].repo;
    // Never reuse a bare changelist name here — that would look identical to
    // a full "Commit Changelist..." even though this may be a subset of it.
    const title =
      selected.length === 1 ? path.basename(selected[0].change.fsPath) : `${selected.length} selected files`;
    CommitPanel.show(repo, () => provider.refresh(), title, selected.map((n) => n.change));
  });

  reg('changelists.moveToChangelist', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes).filter((n) => !n.change.untracked);
    if (selected.length === 0) return;
    const repo = selected[0].repo;
    const target = await chooseTarget(
      repo.manager,
      `Move ${describe(selected)} to changelist`,
      selected.length === 1 ? selected[0].changelist : undefined,
    );
    if (!target) return;
    for (const n of selected) repo.manager.moveToChangelist(n.change.fsPath, target);
  });

  reg('changelists.addToChangelist', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes).filter((n) => n.change.untracked);
    if (selected.length === 0) return;
    const repo = selected[0].repo;
    const target = await chooseTarget(repo.manager, `Add ${describe(selected)} to changelist`);
    if (!target) return;
    try {
      const paths = selected.map((n) => n.change.fsPath);
      await repo.intentToAdd(paths);
      for (const p of paths) repo.manager.moveToChangelist(p, target);
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Add to changelist failed: ${(err as Error).message}`);
    }
  });

  reg('changelists.commitChangelist', async (node?: ChangelistNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const name = node?.name ?? (await pickChangelist(repo.manager));
    if (!name) return;
    const changes = repo
      .getChanges()
      .filter((c) => !c.untracked && repo.manager.changelistOf(c.fsPath) === name);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`Changelist "${name}" has no files to commit.`);
      return;
    }
    CommitPanel.show(repo, () => provider.refresh(), name, changes);
  });

  reg('changelists.rollbackChangelist', async (node?: ChangelistNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const name = node?.name ?? (await pickChangelist(repo.manager));
    if (!name) return;
    const changes = repo
      .getChanges()
      .filter((c) => !c.untracked && repo.manager.changelistOf(c.fsPath) === name);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`Changelist "${name}" has no changes to roll back.`);
      return;
    }
    await rollback(repo, changes, `all ${changes.length} change(s) in "${name}"`);
  });

  reg('changelists.showChangelistDiff', async (node?: ChangelistNode) => {
    const repo = node?.repo ?? git.repos[0];
    if (!repo) return;
    const name = node?.name ?? (await pickChangelist(repo.manager));
    if (!name) return;
    const changes = repo
      .getChanges()
      .filter((c) => !c.untracked && repo.manager.changelistOf(c.fsPath) === name);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`Changelist "${name}" has no changes to show.`);
      return;
    }
    // [label, left, right] per file — undefined sides render natively as
    // added/deleted in the multi-file changes editor, no empty-content hack needed.
    const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = changes.map((c) => [
      c.uri,
      hasHeadVersion(c.status) ? gitHeadUri(c.uri) : undefined,
      fs.existsSync(c.fsPath) ? c.uri : undefined,
    ]);
    await vscode.commands.executeCommand('vscode.changes', `Changes in "${name}"`, resources);
  });

  reg('changelists.rollbackChange', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes);
    if (selected.length === 0) return;
    await rollback(selected[0].repo, selected.map((n) => n.change), describe(selected));
  });

  async function rollback(repo: Repo, changes: { fsPath: string }[], what: string) {
    const confirmed = await vscode.window.showWarningMessage(
      `Roll back ${what}? This discards the local changes and cannot be undone.`,
      { modal: true },
      'Rollback',
    );
    if (confirmed !== 'Rollback') return;
    try {
      await repo.discardChanges(changes.map((c) => c.fsPath));
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Rollback failed: ${(err as Error).message}`);
    }
  }

  reg('changelists.showDiff', async (node?: ChangeNode) => {
    if (node?.change) await openDiff(node.change);
  });

  // Same as showDiff, but keyed by fsPath + repo root — used by the commit
  // panel webview, which only knows file paths, not ChangeNode instances.
  reg('changelists.showDiffPath', async (fsPath: string, repoRoot: string) => {
    const repo = git.repos.find((r) => r.rootFsPath === repoRoot);
    const change = repo?.getChanges().find((c) => c.fsPath === fsPath);
    if (change) await openDiff(change);
  });

  async function openDiff(change: WorkingChange) {
    const uri = change.uri;
    // Untracked files have no HEAD version to diff against — just open them.
    if (change.untracked) {
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    }
    const name = path.basename(uri.fsPath);
    const noHead = !hasHeadVersion(change.status); // added/renamed: nothing at HEAD
    const noWorktree = !fs.existsSync(uri.fsPath); // deleted: nothing on disk

    // Pick a real source per side, falling back to empty where the file doesn't exist.
    const left = noHead ? gitEmptyUri(uri) : gitHeadUri(uri);
    const right = noWorktree ? gitEmptyUri(uri) : uri;
    const suffix = noHead ? '(Added)' : noWorktree ? '(Deleted)' : '(Working Tree ↔ HEAD)';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} ${suffix}`);
  }

  reg('changelists.openChange', async (node?: ChangeNode) => {
    if (!node?.change) return;
    const uri = node.change.uri;
    // A deleted file has nothing to open in the working tree — show HEAD read-only.
    if (!node.change.untracked && !fs.existsSync(uri.fsPath)) {
      await vscode.commands.executeCommand('vscode.open', gitHeadUri(uri));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  });

  reg('changelists.showFileHistory', async (arg?: ChangeNode | vscode.Uri) => {
    // Invoked from our tree (ChangeNode), from editor/explorer context menus
    // (a Uri), or from the command palette (no arg → active editor).
    let uri: vscode.Uri | undefined;
    let repo: Repo | undefined;
    if (arg instanceof ChangeNode) {
      uri = arg.change.uri;
      repo = arg.repo;
    } else if (arg instanceof vscode.Uri) {
      uri = arg;
    } else {
      uri = vscode.window.activeTextEditor?.document.uri;
    }
    if (!uri || uri.scheme !== 'file') return;
    // Longest-prefix match so nested repos resolve to the innermost one.
    repo ??= git.repos
      .filter((r) => uri!.fsPath === r.rootFsPath || uri!.fsPath.startsWith(r.rootFsPath + path.sep))
      .sort((a, b) => b.rootFsPath.length - a.rootFsPath.length)[0];
    if (!repo) {
      vscode.window.showInformationMessage('This file is not inside an open git repository.');
      return;
    }

    const name = path.basename(uri.fsPath);
    const commits = await repo.fileHistory(uri.fsPath);
    if (commits.length === 0) {
      vscode.window.showInformationMessage(`No commits found for "${name}".`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: c.message.split('\n')[0],
        description: `${c.hash.slice(0, 7)} · ${c.authorName ?? 'unknown'} · ${relativeDate(c.authorDate)}`,
        commit: c,
      })),
      {
        placeHolder: `File History: ${name} (${commits.length} commit${commits.length === 1 ? '' : 's'})`,
        matchOnDescription: true,
      },
    );
    if (!picked) return;

    // Diff the file at that commit against its parent — "what did this commit
    // do to this file". A side where the file doesn't exist (added by this
    // commit → no parent version; deleted by it → no version at the commit)
    // gets empty content instead of an unresolvable git: URI.
    const commit = picked.commit;
    const parent = commit.parents[0];
    const [hasLeft, hasRight] = await Promise.all([
      parent ? repo.fileExistsAtRef(parent, uri.fsPath) : Promise.resolve(false),
      repo.fileExistsAtRef(commit.hash, uri.fsPath),
    ]);
    const left = hasLeft ? gitRefUri(uri, parent) : gitEmptyUri(uri);
    const right = hasRight ? gitRefUri(uri, commit.hash) : gitEmptyUri(uri);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${commit.hash.slice(0, 7)})`);
  });
}

const EMPTY_SCHEME = 'changelist-empty';

/** A `git:` URI that resolves to the file's content at the given ref. */
function gitRefUri(uri: vscode.Uri, ref: string): vscode.Uri {
  return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
}

/** A `git:` URI that resolves to the file's content at HEAD. */
function gitHeadUri(uri: vscode.Uri): vscode.Uri {
  return gitRefUri(uri, 'HEAD');
}

/** A URI that always resolves to empty content (used where a side has no file). */
function gitEmptyUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: EMPTY_SCHEME });
}

/** Whether this change has a version at HEAD (false for newly added/renamed files). */
function hasHeadVersion(status: Status): boolean {
  switch (status) {
    case Status.INDEX_ADDED:
    case Status.INDEX_COPIED:
    case Status.INDEX_RENAMED:
    case Status.UNTRACKED:
    case Status.INTENT_TO_ADD:
    case Status.INTENT_TO_RENAME:
      return false;
    default:
      return true;
  }
}

/** "2 days ago"-style formatting for the history picker. */
function relativeDate(d?: Date): string {
  if (!d) return '';
  const seconds = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = seconds;
  for (const [size, unit] of units) {
    if (value < size) {
      const n = Math.floor(value);
      return n <= 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
    value /= size;
  }
  return '';
}

/**
 * Resolve the set of nodes a context-menu command acts on (supports
 * multi-select). If the selection spans more than one repository, only the
 * nodes matching the first-selected item's repo are kept — an action can't
 * sensibly operate across two repos at once.
 */
function selection(node?: ChangeNode, nodes?: ChangeNode[]): ChangeNode[] {
  const list = (nodes && nodes.length ? nodes : node ? [node] : []).filter(
    (n): n is ChangeNode => n instanceof ChangeNode,
  );
  if (list.length <= 1) return list;
  const firstRepo = list[0].repo;
  return list.filter((n) => n.repo === firstRepo);
}

function describe(selected: ChangeNode[]): string {
  return selected.length === 1 ? `"${selected[0].label}"` : `${selected.length} files`;
}

async function pickChangelist(manager: ChangelistManager): Promise<string | undefined> {
  return vscode.window.showQuickPick(manager.getChangelists(), {
    placeHolder: 'Select a changelist to commit',
  });
}

/**
 * Prompt for a target changelist, offering an inline "New changelist..." option
 * that creates one on the fly. Returns the chosen/created name, or undefined.
 */
async function chooseTarget(
  manager: ChangelistManager,
  placeHolder: string,
  exclude?: string,
): Promise<string | undefined> {
  const names = manager.getChangelists().filter((n) => n !== exclude);
  const picked = await vscode.window.showQuickPick(
    [...names.map((label) => ({ label })), { label: '$(add) New changelist...', alwaysShow: true }],
    { placeHolder },
  );
  if (!picked) return undefined;
  if (!picked.label.includes('New changelist')) return picked.label;
  const name = await vscode.window.showInputBox({ prompt: 'New changelist name' });
  if (!name || !manager.createChangelist(name)) return undefined;
  return name.trim();
}

export function deactivate() {}
