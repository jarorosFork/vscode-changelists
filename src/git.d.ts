// Minimal subset of the built-in vscode.git extension API.
// Full definitions: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import { Uri, Event, Disposable } from 'vscode';

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly workingTreeChanges: Change[];
  readonly indexChanges: Change[];
  readonly untrackedChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  add(resources: string[]): Promise<void>;
  revert(resources: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  commit(message: string, opts?: { all?: boolean }): Promise<void>;
}
