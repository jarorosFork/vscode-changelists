import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, WorkingChange } from './gitService';
import { Status } from './git';

interface Row {
  fsPath: string;
  fileName: string;
  dir: string;
  letter: string;
  colorVar: string;
}

function statusInfo(status: Status): { letter: string; colorVar: string } {
  switch (status) {
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
      return { letter: 'A', colorVar: '--vscode-gitDecoration-addedResourceForeground' };
    case Status.DELETED:
    case Status.INDEX_DELETED:
      return { letter: 'D', colorVar: '--vscode-gitDecoration-deletedResourceForeground' };
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return { letter: 'R', colorVar: '--vscode-gitDecoration-renamedResourceForeground' };
    default:
      return { letter: 'M', colorVar: '--vscode-gitDecoration-modifiedResourceForeground' };
  }
}

/**
 * A JetBrains-style commit dialog: a checkable file list plus a multi-line
 * commit message, opened as a webview panel. Singleton — reopening replaces
 * the current contents rather than stacking panels.
 */
export class CommitPanel {
  private static current: CommitPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private rows: Row[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    git: GitService,
    onCommitted: () => void,
    changelistName: string,
    changes: WorkingChange[],
  ) {
    if (CommitPanel.current) {
      CommitPanel.current.panel.reveal(vscode.ViewColumn.Active);
      CommitPanel.current.setContent(changelistName, changes);
      return;
    }
    CommitPanel.current = new CommitPanel(git, onCommitted, changelistName, changes);
  }

  private constructor(
    private readonly git: GitService,
    private readonly onCommitted: () => void,
    changelistName: string,
    changes: WorkingChange[],
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'changelists.commit',
      'Commit Changes',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(
      () => {
        CommitPanel.current = undefined;
        this.disposables.forEach((d) => d.dispose());
      },
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'commit':
          await this.handleCommit(msg.indices, msg.message, msg.amend);
          break;
        case 'diff': {
          const row = this.rows[msg.index];
          if (row) await vscode.commands.executeCommand('changelists.showDiffPath', row.fsPath);
          break;
        }
        case 'requestLastMessage': {
          const last = await this.git.lastCommitMessage();
          this.panel.webview.postMessage({ type: 'lastMessage', message: last ?? '' });
          break;
        }
        case 'cancel':
          this.panel.dispose();
          break;
      }
    }, null, this.disposables);

    this.setContent(changelistName, changes);
  }

  private setContent(changelistName: string, changes: WorkingChange[]) {
    this.panel.title = `Commit: ${changelistName}`;
    this.rows = changes.map((c) => {
      const info = statusInfo(c.status);
      return {
        fsPath: c.fsPath,
        fileName: path.basename(c.fsPath),
        dir: vscode.workspace.asRelativePath(path.dirname(c.fsPath)),
        letter: info.letter,
        colorVar: info.colorVar,
      };
    });
    this.panel.webview.html = this.render(changelistName);
  }

  private async handleCommit(indices: number[], message: string, amend: boolean) {
    const paths = indices.map((i) => this.rows[i]?.fsPath).filter((p): p is string => !!p);
    if (!message.trim() || (paths.length === 0 && !amend)) return;
    try {
      await this.git.commitFiles(paths, message.trim(), { amend });
      this.onCommitted();
      this.panel.dispose();
      const what =
        paths.length === 0 && amend
          ? 'Amended commit message.'
          : `Committed ${paths.length} file${paths.length === 1 ? '' : 's'}${amend ? ' (amended)' : ''}.`;
      vscode.window.showInformationMessage(what);
    } catch (err) {
      this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }

  private render(changelistName: string): string {
    const nonce = String(Date.now());
    const rowsJson = JSON.stringify(this.rows);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100vh;
    box-sizing: border-box;
  }
  h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
  .toolbar { display: flex; gap: 12px; align-items: center; font-size: 12px; }
  .toolbar a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .toolbar a:hover { text-decoration: underline; }
  .spacer { flex: 1; }
  #files {
    flex: 1 1 40%;
    min-height: 80px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row input[type=checkbox] { margin: 0; }
  .letter { width: 14px; text-align: center; font-weight: 700; font-size: 11px; }
  .name { cursor: pointer; }
  .name:hover { text-decoration: underline; }
  .dir { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 80px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .footer { display: flex; align-items: center; gap: 10px; }
  .footer label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .grow { flex: 1; }
  button {
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .primary:disabled { opacity: .5; cursor: not-allowed; }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); font-size: 12px; min-height: 16px; }
</style>
</head>
<body>
  <h2>${escapeHtml(changelistName)}</h2>
  <div class="toolbar">
    <a id="selAll">Select All</a>
    <a id="selNone">Select None</a>
    <span class="spacer"></span>
    <span class="hint" id="count"></span>
  </div>
  <div id="files"></div>
  <textarea id="message" placeholder="Commit message" autofocus></textarea>
  <div class="error" id="error"></div>
  <div class="footer">
    <label><input type="checkbox" id="amend"> Amend previous commit</label>
    <span class="grow"></span>
    <span class="hint">⌘/Ctrl+Enter to commit</span>
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="commit" disabled>Commit</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rows = ${rowsJson};
  const filesEl = document.getElementById('files');
  const messageEl = document.getElementById('message');
  const commitBtn = document.getElementById('commit');
  const countEl = document.getElementById('count');
  const amendEl = document.getElementById('amend');
  const errorEl = document.getElementById('error');

  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = \`
      <input type="checkbox" data-i="\${i}" checked>
      <span class="letter" style="color: var(\${r.colorVar})">\${r.letter}</span>
      <span class="name" data-i="\${i}">\${escapeHtml(r.fileName)}</span>
      <span class="dir">\${escapeHtml(r.dir)}</span>
    \`;
    filesEl.appendChild(row);
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function checkboxes() { return [...filesEl.querySelectorAll('input[type=checkbox]')]; }
  function checkedIndices() { return checkboxes().filter(c => c.checked).map(c => Number(c.dataset.i)); }

  function refresh() {
    const n = checkedIndices().length;
    countEl.textContent = n + ' / ' + rows.length + ' selected';
    const hasMessage = messageEl.value.trim().length > 0;
    commitBtn.disabled = !hasMessage || (n === 0 && !amendEl.checked);
  }

  filesEl.addEventListener('click', (e) => {
    const target = e.target;
    if (target.classList.contains('name')) {
      vscode.postMessage({ type: 'diff', index: Number(target.dataset.i) });
    }
  });
  filesEl.addEventListener('change', refresh);

  document.getElementById('selAll').addEventListener('click', () => { checkboxes().forEach(c => c.checked = true); refresh(); });
  document.getElementById('selNone').addEventListener('click', () => { checkboxes().forEach(c => c.checked = false); refresh(); });

  amendEl.addEventListener('change', () => {
    if (amendEl.checked) vscode.postMessage({ type: 'requestLastMessage' });
    refresh();
  });

  messageEl.addEventListener('input', refresh);
  messageEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCommit();
  });

  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  commitBtn.addEventListener('click', doCommit);

  function doCommit() {
    if (commitBtn.disabled) return;
    errorEl.textContent = '';
    vscode.postMessage({
      type: 'commit',
      indices: checkedIndices(),
      message: messageEl.value,
      amend: amendEl.checked,
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'lastMessage' && !messageEl.value.trim()) {
      messageEl.value = msg.message;
      refresh();
    }
    if (msg.type === 'error') {
      errorEl.textContent = msg.message;
    }
  });

  messageEl.focus();
  refresh();
</script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
