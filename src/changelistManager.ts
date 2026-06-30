import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './gitService';

export const DEFAULT_CHANGELIST = 'Changes';

interface PersistedState {
  // Ordered list of changelist names. DEFAULT_CHANGELIST is always present.
  names: string[];
  // file fsPath -> changelist name. Files not listed belong to the active changelist.
  assignments: Record<string, string>;
  // Changelist that newly-seen (unassigned) changes are shown in.
  active: string;
}

const FILE_NAME = 'changelists.json';
const LEGACY_MEMENTO_KEY = 'changelists.state.v1';

/**
 * Owns the changelist model and persists it to a JSON file inside the repo's
 * `.git` directory — local-only, never committed, and independent of the
 * extension's own lifecycle, so changelists survive extension updates,
 * reinstalls, and even "clear extension data" prompts. Mirrors how JetBrains
 * keeps changelist membership in `.idea/workspace.xml` rather than IDE state.
 *
 * Git itself knows nothing about this — it is a pure local grouping.
 */
export class ChangelistManager {
  private names: string[] = [DEFAULT_CHANGELIST];
  private assignments = new Map<string, string>();
  private active = DEFAULT_CHANGELIST;

  // Tracks which repo root the in-memory state was loaded from, so we can
  // detect when it's stale (e.g. the workspace's repo only became available
  // after construction) and reload from the right file.
  private loadedForRoot: string | undefined | null = null;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly git: GitService,
    private readonly legacyMemento?: vscode.Memento,
  ) {
    this.ensureLoaded();
  }

  private get statePath(): string | undefined {
    const root = this.git.repository?.rootUri.fsPath;
    return root ? path.join(root, '.git', FILE_NAME) : undefined;
  }

  /** Reload from disk if the active repo root has changed since the last load. */
  ensureLoaded() {
    const root = this.git.repository?.rootUri.fsPath;
    if (root === this.loadedForRoot) return;
    this.loadedForRoot = root;
    this.load();
  }

  private load() {
    this.names = [DEFAULT_CHANGELIST];
    this.assignments = new Map();
    this.active = DEFAULT_CHANGELIST;

    const file = this.statePath;
    if (!file) return; // no repo open yet

    const raw = this.readFile(file) ?? this.migrateLegacy();
    if (!raw) return;
    this.applyState(raw);
    if (!this.readFile(file)) this.save(); // persist a migrated-in legacy state
  }

  private readFile(file: string): PersistedState | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined; // missing or unreadable — treat as empty
    }
  }

  /** One-time migration from the pre-0.0.9 workspaceState-backed storage. */
  private migrateLegacy(): PersistedState | undefined {
    const raw = this.legacyMemento?.get<PersistedState>(LEGACY_MEMENTO_KEY);
    if (raw) void this.legacyMemento?.update(LEGACY_MEMENTO_KEY, undefined);
    return raw;
  }

  private applyState(raw: PersistedState) {
    this.names = raw.names?.length ? [...raw.names] : [DEFAULT_CHANGELIST];
    if (!this.names.includes(DEFAULT_CHANGELIST)) this.names.unshift(DEFAULT_CHANGELIST);
    this.assignments = new Map(Object.entries(raw.assignments ?? {}));
    this.active = this.names.includes(raw.active) ? raw.active : DEFAULT_CHANGELIST;
  }

  /** Write current state to disk without notifying listeners. */
  private persist() {
    const file = this.statePath;
    if (!file) return;
    const state: PersistedState = {
      names: this.names,
      assignments: Object.fromEntries(this.assignments),
      active: this.active,
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Changelists: could not save state to ${file}: ${(err as Error).message}`,
      );
    }
  }

  private save() {
    this.persist();
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
    for (const [fsPath, cl] of this.assignments) {
      if (cl === oldName) this.assignments.set(fsPath, trimmed);
    }
    if (this.active === oldName) this.active = trimmed;
    this.save();
    return true;
  }

  deleteChangelist(name: string): boolean {
    if (name === DEFAULT_CHANGELIST || !this.names.includes(name)) return false;
    this.names = this.names.filter((n) => n !== name);
    // Files in the removed changelist fall back to the default.
    for (const [fsPath, cl] of this.assignments) {
      if (cl === name) this.assignments.set(fsPath, DEFAULT_CHANGELIST);
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
    for (const fsPath of this.assignments.keys()) {
      if (!existingPaths.has(fsPath)) {
        this.assignments.delete(fsPath);
        changed = true;
      }
    }
    if (changed) this.persist(); // no onDidChange — avoids a refresh storm mid-refresh
  }
}
