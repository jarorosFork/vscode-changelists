import * as vscode from 'vscode';
import { ChangelistManager, DEFAULT_CHANGELIST } from './changelistManager';
import { GitService } from './gitService';
import { ChangelistTreeProvider, ChangelistNode, ChangeNode } from './treeProvider';

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
    const message = await vscode.window.showInputBox({
      prompt: `Commit message for "${name}" (${changes.length} file${changes.length === 1 ? '' : 's'})`,
      placeHolder: 'Commit message',
      validateInput: (v) => (v.trim() ? undefined : 'A commit message is required'),
    });
    if (!message) return;
    try {
      await git.commitFiles(changes.map((c) => c.fsPath), message);
      vscode.window.showInformationMessage(`Committed ${changes.length} file(s) from "${name}".`);
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Commit failed: ${(err as Error).message}`);
    }
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

  reg('changelists.openChange', async (node?: ChangeNode) => {
    if (node) await vscode.commands.executeCommand('vscode.open', node.change.uri);
  });
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
