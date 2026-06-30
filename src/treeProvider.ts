import * as vscode from 'vscode';
import * as path from 'path';
import { ChangelistManager } from './changelistManager';
import { GitService, WorkingChange } from './gitService';
import { Status } from './git';

export class ChangelistNode extends vscode.TreeItem {
  constructor(public readonly name: string, isActive: boolean, count: number) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'changelist';
    this.iconPath = new vscode.ThemeIcon(isActive ? 'circle-filled' : 'circle-outline');
    this.description = `${count} file${count === 1 ? '' : 's'}${isActive ? ' · active' : ''}`;
    this.tooltip = isActive ? `${name} (active changelist)` : name;
  }
}

export const UNVERSIONED = 'Unversioned Files';

export class UnversionedNode extends vscode.TreeItem {
  constructor(count: number) {
    super(UNVERSIONED, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'unversioned';
    this.iconPath = new vscode.ThemeIcon('question');
    this.description = `${count} file${count === 1 ? '' : 's'}`;
    this.tooltip = 'Untracked files — not part of any changelist and not committed.';
  }
}

export class ChangeNode extends vscode.TreeItem {
  constructor(public readonly change: WorkingChange, public readonly changelist: string) {
    super(path.basename(change.fsPath), vscode.TreeItemCollapsibleState.None);
    // Untracked files live in their own section and cannot be moved into a changelist.
    this.contextValue = change.untracked ? 'unversioned-change' : 'change';
    this.resourceUri = change.uri;
    this.description = vscode.workspace.asRelativePath(path.dirname(change.fsPath));
    this.tooltip = change.fsPath;
    this.iconPath = letterIcon(change.status);
    this.command = {
      command: 'changelists.openChange',
      title: 'Open Change',
      arguments: [this],
    };
  }
}

function letterIcon(status: Status): vscode.ThemeIcon {
  switch (status) {
    case Status.UNTRACKED:
    case Status.INTENT_TO_ADD:
    case Status.INDEX_ADDED:
      return new vscode.ThemeIcon('diff-added');
    case Status.DELETED:
    case Status.INDEX_DELETED:
      return new vscode.ThemeIcon('diff-removed');
    case Status.INDEX_RENAMED:
      return new vscode.ThemeIcon('diff-renamed');
    default:
      return new vscode.ThemeIcon('diff-modified');
  }
}

const MIME = 'application/vnd.code.tree.changelists.view';

export class ChangelistTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Drag-and-drop wiring.
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(
    private readonly manager: ChangelistManager,
    private readonly git: GitService,
  ) {
    this.manager.onDidChange(() => this.refresh());
    this.git.onDidChange(() => this.refresh());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /** Tracked changes grouped by changelist, plus untracked files kept apart. */
  private group(): { groups: Map<string, WorkingChange[]>; untracked: WorkingChange[] } {
    const changes = this.git.getChanges();
    const tracked = changes.filter((c) => !c.untracked);
    const untracked = changes.filter((c) => c.untracked);
    // Only tracked files are ever assigned to changelists.
    this.manager.prune(new Set(tracked.map((c) => c.fsPath)));
    const groups = new Map<string, WorkingChange[]>();
    for (const name of this.manager.getChangelists()) groups.set(name, []);
    for (const change of tracked) {
      const cl = this.manager.changelistOf(change.fsPath);
      if (!groups.has(cl)) groups.set(cl, []);
      groups.get(cl)!.push(change);
    }
    return { groups, untracked };
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!this.git.repository) {
      const item = new vscode.TreeItem('No git repository in this workspace');
      return element ? [] : [item];
    }
    const { groups, untracked } = this.group();
    if (!element) {
      const active = this.manager.getActive();
      const nodes: vscode.TreeItem[] = this.manager
        .getChangelists()
        .map((name) => new ChangelistNode(name, name === active, groups.get(name)?.length ?? 0));
      // "Unversioned Files" always sorts last, and only shows when non-empty.
      if (untracked.length) nodes.push(new UnversionedNode(untracked.length));
      return nodes;
    }
    if (element instanceof ChangelistNode) {
      return (groups.get(element.name) ?? []).map((c) => new ChangeNode(c, element.name));
    }
    if (element instanceof UnversionedNode) {
      return untracked.map((c) => new ChangeNode(c, UNVERSIONED));
    }
    return [];
  }

  // --- Drag and drop ---------------------------------------------------------

  handleDrag(source: readonly vscode.TreeItem[], data: vscode.DataTransfer): void {
    // Only tracked files can be dragged; untracked ones stay in their own section.
    const paths = source
      .filter((item): item is ChangeNode => item instanceof ChangeNode && !item.change.untracked)
      .map((item) => item.change.fsPath);
    if (paths.length) data.set(MIME, new vscode.DataTransferItem(paths));
  }

  async handleDrop(target: vscode.TreeItem | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item) return;
    const list = item.value as string[];
    if (!Array.isArray(list) || list.length === 0) return;

    // Resolve the destination changelist from whatever was dropped on.
    let destination: string | undefined;
    if (target instanceof ChangelistNode) destination = target.name;
    else if (target instanceof ChangeNode) destination = target.changelist;
    else destination = this.manager.getActive(); // dropped on empty space

    if (!destination) return;
    for (const fsPath of list) this.manager.moveToChangelist(fsPath, destination);
  }
}
