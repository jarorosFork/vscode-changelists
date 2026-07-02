# Git Changelists for VSCode

JetBrains IDEA–style changelists for VSCode. Group your working-tree changes into
named changelists and commit only the ones you choose. Files in the **default**
("Changes") changelist get committed; files you move into another changelist are
held back.

## How it works

Git has no native concept of changelists — JetBrains implements them entirely in
its UI, and so does this extension. All your modified files stay in the working
tree. A changelist is just a local grouping remembered per-workspace. When you
commit a changelist, the extension stages **exactly** that changelist's files
(unstaging everything else first) and commits them. Other changelists are never
touched.

State is stored in `<repo>/.git/changelists.json` — local to your machine, never
committed (nothing under `.git/` ever is), and independent of the extension's own
storage. This means changelists survive extension updates, reinstalls, and even
"delete extension data" prompts, the same way JetBrains keeps changelist
membership in `.idea/workspace.xml` rather than IDE state. Upgrading from a
version before 0.0.9 migrates your existing assignments automatically on first
load.

## Multi-root workspaces

If your workspace has more than one folder with a git repo, the view shows one
top-level node per folder, each with its own **Changes**, custom changelists,
and **Unversioned Files** underneath — completely independent changelist state
per repo (each persists to its own `<repo>/.git/changelists.json`). With a
single repo open, the view stays flat exactly as before — no redundant
top-level wrapper.

Removing a folder from the workspace removes its node from the view
immediately (its `changelists.json` is untouched on disk, so re-adding the
folder later restores its changelists exactly as they were).

Because **Pull**/**Push**/**New Changelist**/**Update from Branch** need to
know *which* repo to act on, they move off the view's title bar and onto each
folder's own row (inline icons + right-click) once there's more than one repo.
With a single repo they stay on the title bar as usual.

## Usage

1. Use the **Pull** / **Push** buttons in the view title bar to sync with the
   remote. Pushing a branch with no upstream yet prompts you to pick a remote
   and sets it up automatically.
   - Pull always fetches, then explicitly **merges** or **rebases** onto your
     upstream — it never runs plain `git pull`, so it never hits git's
     "you have divergent branches, please reconcile" prompt. Which one it
     uses is the **`changelists.pullStrategy`** setting (`merge` by default),
     equivalent to JetBrains' "Update Method". Change it in Settings if you
     prefer rebase.
   - Working on a feature branch and want to catch up with `main`? Use the
     **`...`** menu → **Update from Branch...** — pick the branch (local or
     remote, e.g. `origin/main`), then **Merge** or **Rebase**. It fetches the
     latest first, so you always update against the remote's current state,
     not a stale local copy. On conflicts, resolve them in the Source Control
     view as usual, then continue (rebase) or commit (merge).
2. Open the **Changelists** view in the activity bar (list-tree icon).
3. All current changes appear under the active changelist (default: `Changes`).
4. **New Changelist** (`+` in the view title) to create one.
5. Move files between changelists either by:
   - **Drag and drop** — select one or more files (Cmd/Ctrl- or Shift-click for
     multi-select) and drag them onto a changelist; or
   - Right-click a file → **Move to Changelist…**.

   Dragging an **untracked** file out of Unversioned Files onto a changelist
   adds it to version control first (`git add -N`), same as right-click →
   **Add to Changelist…**. Conversely, dragging a newly-**added** file (status
   `A`, not yet committed) onto Unversioned Files unstages it back to
   untracked (status `U`). Files with real commit history (modified, renamed,
   deleted) can't be moved to Unversioned Files this way — there's no way to
   make a file with history "untracked" without rewriting history, so those
   drops are rejected with an explanation.
6. Right-click a changelist → **Commit Changelist…** (or use the inline check-all
   icon, or the **Commit** button in the view title bar) to open the commit
   dialog: a checkable file list (uncheck to leave a file out of this commit),
   a multi-line commit message, an **Amend previous commit** option, and
   click-to-diff on any file. ⌘/Ctrl+Enter commits.
   - Right-click a changelist → **Show Diff** (or the inline multi-diff icon)
     to open every changed file in that changelist at once, in VSCode's
     multi-file changes editor — the same view used for reviewing a commit.
   - Want to commit just one file, or a handful, without touching the rest of
     the changelist? Select the file(s) (Cmd/Ctrl- or Shift-click for
     multi-select) → right-click → **Commit Selected...** — opens the same
     commit dialog, scoped to just what you selected.
7. Right-click a changelist → **Set as Active** to make new changes land there.

## Develop / run

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** ("Run Extension") to launch an Extension Development Host with the
extension loaded, then open any git repo inside it.

### Package as a .vsix

```bash
npx @vscode/vsce package
```

## Notes / limitations (MVP)

- Move/commit work at file granularity (no partial/hunk staging per changelist).
- Assignments are pruned automatically when a file no longer has changes.
- Dragging a file onto a changelist in a different repo is rejected — a file
  can only belong to a changelist in its own repository.
