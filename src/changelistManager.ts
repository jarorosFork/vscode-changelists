import * as vscode from 'vscode';

export const DEFAULT_CHANGELIST = 'Changes';

interface PersistedState {
  // Ordered list of changelist names. DEFAULT_CHANGELIST is always present.
  names: string[];
  // file fsPath -> changelist name. Files not listed belong to the active changelist.
  assignments: Record<string, string>;
  // Changelist that newly-seen (unassigned) changes are shown in.
  active: string;
}

const STORAGE_KEY = 'changelists.state.v1';

/**
 * Owns the changelist model and persists it to workspace state.
 * Git knows nothing about this — it is a pure local grouping, exactly like
 * JetBrains changelists.
 */
export class ChangelistManager {
  private names: string[] = [DEFAULT_CHANGELIST];
  private assignments = new Map<string, string>();
  private active = DEFAULT_CHANGELIST;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly memento: vscode.Memento) {
    this.load();
  }

  private load() {
    const raw = this.memento.get<PersistedState>(STORAGE_KEY);
    if (!raw) return;
    this.names = raw.names?.length ? [...raw.names] : [DEFAULT_CHANGELIST];
    if (!this.names.includes(DEFAULT_CHANGELIST)) this.names.unshift(DEFAULT_CHANGELIST);
    this.assignments = new Map(Object.entries(raw.assignments ?? {}));
    this.active = this.names.includes(raw.active) ? raw.active : DEFAULT_CHANGELIST;
  }

  private save() {
    const state: PersistedState = {
      names: this.names,
      assignments: Object.fromEntries(this.assignments),
      active: this.active,
    };
    void this.memento.update(STORAGE_KEY, state);
    this._onDidChange.fire();
  }

  getChangelists(): string[] {
    return [...this.names];
  }

  getActive(): string {
    return this.active;
  }

  setActive(name: string) {
    if (!this.names.includes(name)) return;
    this.active = name;
    this.save();
  }

  /** Changelist a given file currently belongs to. */
  changelistOf(fsPath: string): string {
    const assigned = this.assignments.get(fsPath);
    if (assigned && this.names.includes(assigned)) return assigned;
    return this.active;
  }

  createChangelist(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed || this.names.includes(trimmed)) return false;
    this.names.push(trimmed);
    this.save();
    return true;
  }

  renameChangelist(oldName: string, newName: string): boolean {
    const trimmed = newName.trim();
    if (oldName === DEFAULT_CHANGELIST) return false;
    if (!trimmed || !this.names.includes(oldName) || this.names.includes(trimmed)) return false;
    this.names = this.names.map((n) => (n === oldName ? trimmed : n));
    for (const [path, cl] of this.assignments) {
      if (cl === oldName) this.assignments.set(path, trimmed);
    }
    if (this.active === oldName) this.active = trimmed;
    this.save();
    return true;
  }

  deleteChangelist(name: string): boolean {
    if (name === DEFAULT_CHANGELIST || !this.names.includes(name)) return false;
    this.names = this.names.filter((n) => n !== name);
    // Files in the removed changelist fall back to the default.
    for (const [path, cl] of this.assignments) {
      if (cl === name) this.assignments.set(path, DEFAULT_CHANGELIST);
    }
    if (this.active === name) this.active = DEFAULT_CHANGELIST;
    this.save();
    return true;
  }

  moveToChangelist(fsPath: string, name: string) {
    if (!this.names.includes(name)) return;
    this.assignments.set(fsPath, name);
    this.save();
  }

  /** Drop assignments for files that are no longer changed, to avoid leaks. */
  prune(existingPaths: Set<string>) {
    let changed = false;
    for (const path of this.assignments.keys()) {
      if (!existingPaths.has(path)) {
        this.assignments.delete(path);
        changed = true;
      }
    }
    if (changed) {
      // Persist silently without firing a refresh storm.
      void this.memento.update(STORAGE_KEY, {
        names: this.names,
        assignments: Object.fromEntries(this.assignments),
        active: this.active,
      } satisfies PersistedState);
    }
  }
}
