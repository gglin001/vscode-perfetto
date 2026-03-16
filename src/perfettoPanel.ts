import * as path from 'node:path';
import * as vscode from 'vscode';

const VIEW_TYPE = 'vscode-perfetto.viewer';
const CHUNK_SIZE = 256 * 1024;

export class PerfettoPanel implements vscode.Disposable {
  public static currentPanel: PerfettoPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: (message: string) => void;
  private uiUrlOverride: string | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    uiUrlOverride: string | undefined,
    log: (message: string) => void,
  ): PerfettoPanel {
    if (PerfettoPanel.currentPanel) {
      PerfettoPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
      PerfettoPanel.currentPanel.setUiUrl(uiUrlOverride);
      return PerfettoPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Perfetto', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'perfetto-ui'),
      ],
    });

    PerfettoPanel.currentPanel = new PerfettoPanel(panel, extensionUri, uiUrlOverride, log);
    return PerfettoPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    uiUrlOverride: string | undefined,
    log: (message: string) => void,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.uiUrlOverride = uiUrlOverride;
    this.log = log;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message), null, this.disposables);
    this.log(`Created webview panel for ${this.resolveUiTarget(this.panel.webview).label}.`);
  }

  public setUiUrl(uiUrlOverride: string | undefined): void {
    this.uiUrlOverride = uiUrlOverride;
    const target = this.resolveUiTarget(this.panel.webview);
    this.log(`Webview target set to ${target.label}.`);
    void this.panel.webview.postMessage({ type: 'setUiUrl', uiUrl: target.url, uiLabel: target.label });
  }

  public async openTrace(traceUri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const fileName = path.posix.basename(traceUri.path) || traceUri.toString(true);
    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_SIZE));
    const target = this.resolveUiTarget(this.panel.webview);

    this.panel.title = `Perfetto: ${fileName}`;
    this.log(`Sending ${fileName} to webview in ${totalChunks} chunk(s) using ${target.label}.`);

    await this.panel.webview.postMessage({
      type: 'openTraceStart',
      transferId,
      uiUrl: target.url,
      uiLabel: target.label,
      fileName,
      totalChunks,
      totalBytes: bytes.byteLength,
    });

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);

      await this.panel.webview.postMessage({
        type: 'openTraceChunk',
        transferId,
        index,
        data: Buffer.from(bytes.subarray(start, end)).toString('base64'),
      });
    }

    await this.panel.webview.postMessage({
      type: 'openTraceEnd',
      transferId,
    });

    this.log(`Finished posting ${fileName} to the webview.`);
  }

  public dispose(): void {
    PerfettoPanel.currentPanel = undefined;
    this.log('Webview panel disposed.');

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const nonce = getNonce();
    const target = this.resolveUiTarget(this.panel.webview);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${this.panel.webview.cspSource} https: http:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Perfetto</title>
    <style>
      html, body {
        height: 100%;
        margin: 0;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
      }
      body {
        display: grid;
        grid-template-rows: auto 1fr;
      }
      #status {
        padding: 8px 12px;
        font-size: 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      #frame {
        width: 100%;
        height: 100%;
        border: 0;
      }
    </style>
  </head>
  <body>
    <div id="status">Connecting to ${escapeHtml(target.label)}...</div>
    <iframe id="frame" title="Perfetto UI"></iframe>
    <script nonce="${nonce}">
      window.__PERFETTO_UI_URL__ = ${JSON.stringify(target.url)};
      window.__PERFETTO_UI_LABEL__ = ${JSON.stringify(target.label)};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private handleWebviewMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const type = 'type' in message ? message.type : undefined;
    if (type !== 'log') {
      return;
    }

    const text = 'message' in message ? message.message : undefined;
    if (typeof text === 'string' && text.length > 0) {
      this.log(`Webview: ${text}`);
    }
  }

  private resolveUiTarget(webview: vscode.Webview): { url: string; label: string } {
    if (this.uiUrlOverride) {
      return {
        url: this.uiUrlOverride,
        label: this.uiUrlOverride,
      };
    }

    return {
      url: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'perfetto-ui', 'index.html')).toString(),
      label: 'bundled Perfetto UI',
    };
  }
}

function getNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
