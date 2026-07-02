import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { Repo, WorkingChange } from './repo';
import { Status } from './git';

export class RepoNode extends vscode.TreeItem {
  constructor(public readonly repo: Repo) {
    super(repo.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'repo';
    this.resourceUri = repo.repository.rootUri;
    this.iconPath = vscode.ThemeIcon.Folder;
    this.tooltip = repo.rootFsPath;
  }
}

export class ChangelistNode extends vscode.TreeItem {
  constructor(public readonly repo: Repo, public readonly name: string, isActive: boolean, count: number) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'changelist';
    this.iconPath = new vscode.ThemeIcon(isActive ? 'circle-filled' : 'circle-outline');
    this.description = `${count} file${count === 1 ? '' : 's'}${isActive ? ' · active' : ''}`;
    this.tooltip = isActive ? `${name} (active changelist)` : name;
  }
}

export const UNVERSIONED = 'Unversioned Files';

export class UnversionedNode extends vscode.TreeItem {
  constructor(public readonly repo: Repo, count: number) {
    super(UNVERSIONED, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'unversioned';
    this.iconPath = new vscode.ThemeIcon('question');
    this.description = `${count} file${count === 1 ? '' : 's'}`;
    this.tooltip = 'Untracked files — not part of any changelist and not committed.';
  }
}

export class ChangeNode extends vscode.TreeItem {
  constructor(public readonly repo: Repo, public readonly change: WorkingChange, public readonly changelist: string) {
    super(path.basename(change.fsPath), vscode.TreeItemCollapsibleState.None);
    // Untracked files live in their own section and cannot be moved into a changelist.
    this.contextValue = change.untracked ? 'unversioned-change' : 'change';
    this.resourceUri = change.uri;
    this.description = vscode.workspace.asRelativePath(path.dirname(change.fsPath));
    this.tooltip = change.fsPath;
    this.iconPath = letterIcon(change.status);
    this.command = {
      command: 'changelists.showDiff',
      title: 'Show Diff',
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

interface DragItem {
  repoRoot: string;
  fsPath: string;
  untracked: boolean;
  status: Status;
}

export class ChangelistTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Drag-and-drop wiring.
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(private readonly git: GitService) {
    this.git.onDidChange(() => this.refresh());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /** Tracked changes grouped by changelist, plus untracked files kept apart — for one repo. */
  private group(repo: Repo): { groups: Map<string, WorkingChange[]>; untracked: WorkingChange[] } {
    const changes = repo.getChanges();
    const tracked = changes.filter((c) => !c.untracked);
    const untracked = changes.filter((c) => c.untracked);
    // Only tracked files are ever assigned to changelists.
    repo.manager.prune(new Set(tracked.map((c) => c.fsPath)));
    const groups = new Map<string, WorkingChange[]>();
    for (const name of repo.manager.getChangelists()) groups.set(name, []);
    for (const change of tracked) {
      const cl = repo.manager.changelistOf(change.fsPath);
      if (!groups.has(cl)) groups.set(cl, []);
      groups.get(cl)!.push(change);
    }
    return { groups, untracked };
  }

  /** Changes/Unversioned Files nodes for one repo — the "usual structure". */
  private repoChildren(repo: Repo): vscode.TreeItem[] {
    const { groups, untracked } = this.group(repo);
    const active = repo.manager.getActive();
    const nodes: vscode.TreeItem[] = repo.manager
      .getChangelists()
      .map((name) => new ChangelistNode(repo, name, name === active, groups.get(name)?.length ?? 0));
    // "Unversioned Files" always sorts last, and only shows when non-empty.
    if (untracked.length) nodes.push(new UnversionedNode(repo, untracked.length));
    return nodes;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const repos = this.git.repos;
    if (repos.length === 0) {
      const item = new vscode.TreeItem('No git repository in this workspace');
      return element ? [] : [item];
    }
    if (!element) {
      // Single repo: flat structure, same as always. Multiple repos: one
      // top-level node per folder, each expanding into its own usual structure.
      return repos.length === 1 ? this.repoChildren(repos[0]) : repos.map((r) => new RepoNode(r));
    }
    if (element instanceof RepoNode) {
      return this.repoChildren(element.repo);
    }
    if (element instanceof ChangelistNode) {
      const { groups } = this.group(element.repo);
      return (groups.get(element.name) ?? []).map((c) => new ChangeNode(element.repo, c, element.name));
    }
    if (element instanceof UnversionedNode) {
      const { untracked } = this.group(element.repo);
      return untracked.map((c) => new ChangeNode(element.repo, c, UNVERSIONED));
    }
    return [];
  }

  // --- Drag and drop ---------------------------------------------------------

  handleDrag(source: readonly vscode.TreeItem[], data: vscode.DataTransfer): void {
    const items: DragItem[] = source
      .filter((item): item is ChangeNode => item instanceof ChangeNode)
      .map((item) => ({
        repoRoot: item.repo.rootFsPath,
        fsPath: item.change.fsPath,
        untracked: item.change.untracked,
        status: item.change.status,
      }));
    if (items.length) data.set(MIME, new vscode.DataTransferItem(items));
  }

  async handleDrop(target: vscode.TreeItem | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item) return;
    const allDragged = item.value as DragItem[];
    if (!Array.isArray(allDragged) || allDragged.length === 0) return;

    // Resolve the destination repo from whatever was dropped on, and drop any
    // dragged files that don't belong to that repo — a changelist assignment
    // is meaningless for a file that isn't a change in that repository.
    const targetRepo =
      target instanceof RepoNode
        ? target.repo
        : target instanceof ChangelistNode || target instanceof UnversionedNode || target instanceof ChangeNode
          ? target.repo
          : undefined;
    const list = targetRepo ? allDragged.filter((i) => i.repoRoot === targetRepo.rootFsPath) : allDragged;
    if (list.length === 0) return;
    // Dropped on empty space with multiple repos open: nothing to resolve a
    // destination against, so there's nothing sensible to do.
    if (!targetRepo && this.git.repos.length > 1) return;
    const repo = targetRepo ?? this.git.repos[0];
    if (!repo) return;

    // Dropping on "Unversioned Files" (or one of its rows) reverts newly-added
    // files back to untracked — the mirror image of dragging an untracked
    // file into a changelist.
    const droppedOnUnversioned =
      target instanceof UnversionedNode || (target instanceof ChangeNode && target.changelist === UNVERSIONED);
    if (droppedOnUnversioned) {
      await this.moveToUnversioned(repo, list);
      return;
    }

    // Resolve the destination changelist from whatever was dropped on.
    let destination: string | undefined;
    if (target instanceof ChangelistNode) destination = target.name;
    else if (target instanceof ChangeNode) destination = target.changelist;
    else destination = repo.manager.getActive(); // dropped on empty space or a RepoNode
    if (!destination) return;

    // Dragging an untracked file into a changelist implicitly adds it to
    // version control first (git add -N), same as "Add to Changelist...".
    const untrackedPaths = list.filter((i) => i.untracked).map((i) => i.fsPath);
    if (untrackedPaths.length) {
      try {
        await repo.intentToAdd(untrackedPaths);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to add file(s) to version control: ${(err as Error).message}`);
        return;
      }
    }
    for (const i of list) repo.manager.moveToChangelist(i.fsPath, destination);
  }

  private async moveToUnversioned(repo: Repo, list: DragItem[]) {
    // Only newly-added files (no HEAD version) can cleanly become untracked
    // again via a plain unstage. A modified/renamed/deleted file has real
    // history — unstaging it would not make it untracked, just unstaged.
    const isNewlyAdded = (s: Status) => s === Status.INDEX_ADDED || s === Status.INTENT_TO_ADD;
    const revertible = list.filter((i) => !i.untracked && isNewlyAdded(i.status)).map((i) => i.fsPath);
    const ineligible = list.filter((i) => !i.untracked && !isNewlyAdded(i.status));

    if (ineligible.length) {
      const names = ineligible.map((i) => path.basename(i.fsPath)).join(', ');
      vscode.window.showWarningMessage(
        `Only newly-added files can move to Unversioned Files: ${names} already has commit history.`,
      );
    }
    if (revertible.length === 0) return;
    try {
      await repo.unstage(revertible);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to unstage file(s): ${(err as Error).message}`);
    }
  }
}
