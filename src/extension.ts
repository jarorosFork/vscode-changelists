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

  const manager = new ChangelistManager(context.workspaceState);
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
    if (node) await openDiff(node.change);
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
    if (!node) return;
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
