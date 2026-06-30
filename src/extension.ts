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

  reg('changelists.moveToChangelist', async (node?: ChangeNode) => {
    if (!node) return;
    const others = manager.getChangelists().filter((n) => n !== node.changelist);
    const items: vscode.QuickPickItem[] = [
      ...others.map((n) => ({ label: n })),
      { label: '$(add) New changelist...', alwaysShow: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Move "${node.label}" to changelist`,
    });
    if (!picked) return;
    let target = picked.label;
    if (target.includes('New changelist')) {
      const name = await vscode.window.showInputBox({ prompt: 'New changelist name' });
      if (!name || !manager.createChangelist(name)) return;
      target = name.trim();
    }
    manager.moveToChangelist(node.change.fsPath, target);
  });

  reg('changelists.commitChangelist', async (node?: ChangelistNode) => {
    const name = node?.name ?? (await pickChangelist(manager));
    if (!name) return;
    const changes = git
      .getChanges()
      .filter((c) => manager.changelistOf(c.fsPath) === name);
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

  reg('changelists.openChange', async (node?: ChangeNode) => {
    if (node) await vscode.commands.executeCommand('vscode.open', node.change.uri);
  });
}

async function pickChangelist(manager: ChangelistManager): Promise<string | undefined> {
  return vscode.window.showQuickPick(manager.getChangelists(), {
    placeHolder: 'Select a changelist to commit',
  });
}

export function deactivate() {}
