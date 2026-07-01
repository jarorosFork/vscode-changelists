import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChangelistManager, DEFAULT_CHANGELIST } from './changelistManager';
import { GitService, WorkingChange } from './gitService';
import { ChangelistTreeProvider, ChangelistNode, ChangeNode } from './treeProvider';
import { Status } from './git';
import { CommitPanel } from './commitPanel';

export async function activate(context: vscode.ExtensionContext) {
  const git = new GitService();
  try {
    await git.init();
  } catch (err) {
    vscode.window.showErrorMessage(`Changelists: ${(err as Error).message}`);
    return;
  }

  const manager = new ChangelistManager(git, context.workspaceState);
  const provider = new ChangelistTreeProvider(manager, git);
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

  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('changelists.refresh', () => provider.refresh());

  reg('changelists.pull', async () => {
    if (!git.hasUpstream) {
      const branch = git.currentBranch;
      vscode.window.showInformationMessage(
        branch
          ? `"${branch}" has no upstream branch yet — there's nothing to pull until you push it.`
          : 'Current branch has no upstream branch yet — push it first.',
      );
      return;
    }
    try {
      await git.pull();
      provider.refresh();
      vscode.window.showInformationMessage('Pull complete.');
    } catch (err) {
      vscode.window.showErrorMessage(`Pull failed: ${(err as Error).message}`);
    }
  });

  reg('changelists.push', async () => {
    try {
      if (git.hasUpstream) {
        await git.push();
        vscode.window.showInformationMessage('Pushed.');
        return;
      }
      // No upstream yet (e.g. a brand new branch) — ask which remote to publish to.
      const branch = git.currentBranch;
      if (!branch) {
        vscode.window.showErrorMessage('No current branch to push.');
        return;
      }
      const remotes = git.remoteNames;
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
      await git.push(remote, branch, true);
      vscode.window.showInformationMessage(`Pushed and set upstream to ${remote}/${branch}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Push failed: ${(err as Error).message}`);
    }
  });

  reg('changelists.updateFromBranch', async () => {
    const current = git.currentBranch;
    if (!current) {
      vscode.window.showErrorMessage('Not currently on a branch.');
      return;
    }
    const branches = await git.listBranches();
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
        await git.fetch(remote, rest.join('/'));
      } else {
        await git.fetch(); // refresh remote-tracking refs in case they're stale
      }
      if (modePick.mode === 'rebase') await git.rebaseOnto(branchPick.ref);
      else await git.mergeRef(branchPick.ref);
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

  reg('changelists.createChangelist', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'New changelist name',
      validateInput: (v) =>
        manager.getChangelists().includes(v.trim())
          ? 'A changelist with this name already exists'
          : undefined,
    });
    if (name && !manager.createChangelist(name)) {
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
    if (name) manager.renameChangelist(node.name, name);
  });

  reg('changelists.deleteChangelist', (node?: ChangelistNode) => {
    if (!node) return;
    if (!manager.deleteChangelist(node.name)) {
      vscode.window.showWarningMessage('The default changelist cannot be deleted.');
    }
  });

  reg('changelists.setActiveChangelist', (node?: ChangelistNode) => {
    if (node) manager.setActive(node.name);
  });

  reg('changelists.moveToChangelist', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes).filter((n) => !n.change.untracked);
    if (selected.length === 0) return;
    const target = await chooseTarget(
      manager,
      `Move ${describe(selected)} to changelist`,
      selected.length === 1 ? selected[0].changelist : undefined,
    );
    if (!target) return;
    for (const n of selected) manager.moveToChangelist(n.change.fsPath, target);
  });

  reg('changelists.addToChangelist', async (node?: ChangeNode, nodes?: ChangeNode[]) => {
    const selected = selection(node, nodes).filter((n) => n.change.untracked);
    if (selected.length === 0) return;
    const target = await chooseTarget(manager, `Add ${describe(selected)} to changelist`);
    if (!target) return;
    try {
      const paths = selected.map((n) => n.change.fsPath);
      await git.intentToAdd(paths);
      for (const p of paths) manager.moveToChangelist(p, target);
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Add to changelist failed: ${(err as Error).message}`);
    }
  });

  reg('changelists.commitChangelist', async (node?: ChangelistNode) => {
    const name = node?.name ?? (await pickChangelist(manager));
    if (!name) return;
    const changes = git
      .getChanges()
      .filter((c) => !c.untracked && manager.changelistOf(c.fsPath) === name);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`Changelist "${name}" has no files to commit.`);
      return;
    }
    CommitPanel.show(git, () => provider.refresh(), name, changes);
  });

  reg('changelists.rollbackChangelist', async (node?: ChangelistNode) => {
    const name = node?.name ?? (await pickChangelist(manager));
    if (!name) return;
    const changes = git
      .getChanges()
      .filter((c) => !c.untracked && manager.changelistOf(c.fsPath) === name);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`Changelist "${name}" has no changes to roll back.`);
      return;
    }
    await rollback(changes, `all ${changes.length} change(s) in "${name}"`);
  });

  reg('changelists.showChangelistDiff', async (node?: ChangelistNode) => {
    const name = node?.name ?? (await pickChangelist(manager));
    if (!name) return;
    const changes = git
      .getChanges()
      .filter((c) => !c.untracked && manager.changelistOf(c.fsPath) === name);
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
    await rollback(selected.map((n) => n.change), describe(selected));
  });

  async function rollback(changes: { fsPath: string }[], what: string) {
    const confirmed = await vscode.window.showWarningMessage(
      `Roll back ${what}? This discards the local changes and cannot be undone.`,
      { modal: true },
      'Rollback',
    );
    if (confirmed !== 'Rollback') return;
    try {
      await git.discardChanges(changes.map((c) => c.fsPath));
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Rollback failed: ${(err as Error).message}`);
    }
  }

  reg('changelists.showDiff', async (node?: ChangeNode) => {
    if (node?.change) await openDiff(node.change);
  });

  // Same as showDiff, but keyed by fsPath — used by the commit panel webview,
  // which only knows file paths, not ChangeNode instances.
  reg('changelists.showDiffPath', async (fsPath: string) => {
    const change = git.getChanges().find((c) => c.fsPath === fsPath);
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
}

const EMPTY_SCHEME = 'changelist-empty';

/** A `git:` URI that resolves to the file's content at HEAD. */
function gitHeadUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: 'HEAD' }) });
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

/** Resolve the set of nodes a context-menu command acts on (supports multi-select). */
function selection(node?: ChangeNode, nodes?: ChangeNode[]): ChangeNode[] {
  const list = (nodes && nodes.length ? nodes : node ? [node] : []).filter(
    (n): n is ChangeNode => n instanceof ChangeNode,
  );
  return list;
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
