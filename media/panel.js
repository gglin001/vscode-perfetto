const vscode = acquireVsCodeApi();
const frame = document.getElementById('frame');
const status = document.getElementById('status');

let uiUrl = window.__PERFETTO_UI_URL__ || 'https://ui.perfetto.dev';
let uiLabel = window.__PERFETTO_UI_LABEL__ || 'Perfetto UI';
let uiOrigin = getOrigin(uiUrl);
let ready = false;
let pingTimer = undefined;
let transfer = undefined;
let pendingTrace = undefined;
let waitStartedAt = 0;
let lastWaitLogAt = -1;

setUiUrl(uiUrl, uiLabel);
log(`Panel initialized. Target UI: ${uiLabel}`);

window.addEventListener('message', (event) => {
  if (event.source === frame.contentWindow && event.origin === uiOrigin) {
    if (event.data === 'PONG') {
      ready = true;
      stopPing();
      const waitMs = waitStartedAt > 0 ? Date.now() - waitStartedAt : 0;
      log(`Received PONG from Perfetto UI after ${waitMs} ms.`);
      openPendingTrace();
    }
    return;
  }

  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'setUiUrl') {
    setUiUrl(message.uiUrl, message.uiLabel);
    return;
  }

  if (message.type === 'openTraceStart') {
    setUiUrl(message.uiUrl, message.uiLabel);
    transfer = {
      transferId: message.transferId,
      fileName: message.fileName,
      totalBytes: message.totalBytes,
      chunks: new Array(message.totalChunks),
    };
    log(`Receiving trace ${message.fileName}, ${message.totalBytes} bytes in ${message.totalChunks} chunk(s).`);
    setStatus(`Loading ${message.fileName}...`);
    return;
  }

  if (message.type === 'openTraceChunk' && transfer && message.transferId === transfer.transferId) {
    transfer.chunks[message.index] = decodeBase64(message.data);
    return;
  }

  if (message.type === 'openTraceEnd' && transfer && message.transferId === transfer.transferId) {
    pendingTrace = {
      fileName: transfer.fileName,
      buffer: joinChunks(transfer.chunks, transfer.totalBytes),
    };
    log(`Trace ${transfer.fileName} is buffered in the webview.`);
    transfer = undefined;
    openPendingTrace();
  }
});

frame.addEventListener('load', () => {
  ready = false;
  waitStartedAt = Date.now();
  lastWaitLogAt = -1;
  log(`Iframe loaded for ${uiLabel}. Waiting for PONG.`);
  startPing();
});

function setUiUrl(nextUiUrl, nextUiLabel) {
  if (typeof nextUiUrl !== 'string' || nextUiUrl.length === 0) {
    return;
  }

  uiUrl = nextUiUrl;
  if (typeof nextUiLabel === 'string' && nextUiLabel.length > 0) {
    uiLabel = nextUiLabel;
  }
  uiOrigin = getOrigin(uiUrl);
  ready = false;
  stopPing();
  setStatus(`Connecting to ${uiLabel}...`);
  log(`Connecting iframe to ${uiLabel}`);

  if (frame.src !== uiUrl) {
    frame.src = uiUrl;
  } else {
    startPing();
  }
}

function startPing() {
  stopPing();
  ping();
  pingTimer = window.setInterval(ping, 1000);
}

function stopPing() {
  if (pingTimer === undefined) {
    return;
  }

  window.clearInterval(pingTimer);
  pingTimer = undefined;
}

function ping() {
  if (!frame.contentWindow) {
    return;
  }

  updateWaitingStatus();

  try {
    frame.contentWindow.postMessage('PING', uiOrigin);
  } catch {
    setStatus(`Connecting to ${uiLabel}...`);
  }
}

function openPendingTrace() {
  if (!ready || !pendingTrace || !frame.contentWindow) {
    if (pendingTrace) {
      updateWaitingStatus();
    }
    return;
  }

  frame.contentWindow.postMessage(
    {
      perfetto: {
        buffer: pendingTrace.buffer,
        title: pendingTrace.fileName,
      },
    },
    uiOrigin,
    [pendingTrace.buffer],
  );

  log(`Trace ${pendingTrace.fileName} sent to Perfetto UI.`);
  setStatus(`Opened ${pendingTrace.fileName}`);
  pendingTrace = undefined;
}

function setStatus(text) {
  status.textContent = text;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function joinChunks(chunks, totalBytes) {
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }

    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'https://ui.perfetto.dev';
  }
}

function updateWaitingStatus() {
  if (ready) {
    return;
  }

  const elapsedSeconds = waitStartedAt > 0 ? Math.floor((Date.now() - waitStartedAt) / 1000) : 0;
  const traceSuffix = pendingTrace ? ' Trace is ready and will open automatically.' : '';
  const debugSuffix = elapsedSeconds >= 5 ? ' See Perfetto output for details.' : '';
  setStatus(`Waiting for ${uiLabel}... ${elapsedSeconds}s.${traceSuffix}${debugSuffix}`);

  if (elapsedSeconds >= 5 && elapsedSeconds % 5 === 0 && elapsedSeconds !== lastWaitLogAt) {
    lastWaitLogAt = elapsedSeconds;
    log(`Still waiting for ${uiLabel}. ${elapsedSeconds}s elapsed.${pendingTrace ? ' Trace is buffered.' : ''}`);
  }
}

function log(message) {
  vscode.postMessage({
    type: 'log',
    message,
  });
}
