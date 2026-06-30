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

## Usage

1. Open the **Changelists** view in the activity bar (list-tree icon).
2. All current changes appear under the active changelist (default: `Changes`).
3. **New Changelist** (`+` in the view title) to create one.
4. Move files between changelists either by:
   - **Drag and drop** — select one or more files (Cmd/Ctrl- or Shift-click for
     multi-select) and drag them onto a changelist; or
   - Right-click a file → **Move to Changelist…**.
5. Right-click a changelist → **Commit Changelist…** (or use the inline check-all
   icon, or the **Commit** button in the view title bar) to open the commit
   dialog: a checkable file list (uncheck to leave a file out of this commit),
   a multi-line commit message, an **Amend previous commit** option, and
   click-to-diff on any file. ⌘/Ctrl+Enter commits.
6. Right-click a changelist → **Set as Active** to make new changes land there.

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

- Operates on the first repository in the workspace (no multi-repo picker yet).
- Move/commit work at file granularity (no partial/hunk staging per changelist).
- Assignments are pruned automatically when a file no longer has changes.
