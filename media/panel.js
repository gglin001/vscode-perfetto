const vscode = acquireVsCodeApi();
const frame = document.getElementById('frame');
const status = document.getElementById('status');

let uiUrl = window.__PERFETTO_UI_URL__ || '';
let uiLabel = window.__PERFETTO_UI_LABEL__ || 'bundled Perfetto UI';
let uiOrigin = getOrigin(uiUrl);
let ready = false;
let traceReceiverReady = false;
let transfer = undefined;
let pendingTrace = undefined;
let waitStartedAt = 0;
let lastWaitLogAt = -1;

setUiUrl(uiUrl, uiLabel);
log(`Panel initialized. Target UI: ${uiLabel}.`);

window.addEventListener('message', (event) => {
  if (isPerfettoUiLogMessage(event.data) && isFrameEvent(event)) {
    log(`Perfetto UI ${event.data.__vscodePerfettoLog__.level}: ${event.data.__vscodePerfettoLog__.message}`);
    return;
  }

  if (isPerfettoUiStateMessage(event.data) && isFrameEvent(event)) {
    if (event.data.__vscodePerfettoState__.code === 'trace_ready') {
      traceReceiverReady = true;
      openPendingTrace();
    }
    log(`Perfetto UI state: ${event.data.__vscodePerfettoState__.message}`);
    return;
  }

  if (event.source === frame.contentWindow) {
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
      totalChunks: message.totalChunks,
      receivedChunks: 0,
      buffer: new Uint8Array(message.totalBytes),
    };
    log(`Receiving trace ${message.fileName}, ${message.totalBytes} bytes in ${message.totalChunks} chunk(s).`);
    setStatus(`Loading ${message.fileName}...`);
    return;
  }

  if (message.type === 'openTraceChunk' && transfer && message.transferId === transfer.transferId) {
    const chunk = toUint8Array(message.data);
    if (!chunk || typeof message.start !== 'number') {
      log(`Ignoring invalid chunk for ${transfer.fileName}.`);
      return;
    }

    const start = message.start;
    const end = start + chunk.byteLength;
    if (start < 0 || end > transfer.buffer.byteLength) {
      log(`Ignoring out-of-range chunk for ${transfer.fileName}.`);
      return;
    }

    transfer.buffer.set(chunk, start);
    transfer.receivedChunks += 1;
    return;
  }

  if (message.type === 'openTraceEnd' && transfer && message.transferId === transfer.transferId) {
    if (transfer.receivedChunks !== transfer.totalChunks) {
      log(`Trace ${transfer.fileName} ended with ${transfer.receivedChunks}/${transfer.totalChunks} chunk(s) received.`);
    }

    pendingTrace = {
      fileName: transfer.fileName,
      buffer: transfer.buffer.buffer,
    };
    log(`Trace ${transfer.fileName} is buffered in the webview.`);
    transfer = undefined;
    openPendingTrace();
  }
});

frame.addEventListener('load', () => {
  ready = true;
  setStatus(`Opened ${uiLabel}`);
  log(`Iframe loaded for ${uiLabel}.`);
  openPendingTrace();
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
  traceReceiverReady = false;
  waitStartedAt = Date.now();
  lastWaitLogAt = -1;
  setStatus(`Connecting to ${uiLabel}...`);
  log(`Connecting iframe to ${uiLabel}.`);

  if (!sameUrl(frame.src, uiUrl)) {
    frame.src = uiUrl;
  } else {
    if (frame.contentWindow) {
      ready = true;
      updateWaitingStatus();
      openPendingTrace();
    }
  }
}

function openPendingTrace() {
  if (!pendingTrace || !frame.contentWindow) {
    return;
  }

  if (!ready || !traceReceiverReady) {
    updateWaitingStatus();
    return;
  }

  try {
    frame.contentWindow.postMessage(
      {
        __vscodePerfettoOpenTrace__: true,
        buffer: pendingTrace.buffer,
        title: pendingTrace.fileName,
      },
      uiOrigin,
      [pendingTrace.buffer],
    );
  } catch (error) {
    log(`Failed to post trace ${pendingTrace.fileName}: ${toErrorMessage(error)}`);
    updateWaitingStatus();
    return;
  }

  log(`Trace ${pendingTrace.fileName} sent to Perfetto UI.`);
  setStatus(`Opened ${pendingTrace.fileName}`);
  pendingTrace = undefined;
}

function setStatus(text) {
  status.textContent = text;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return undefined;
}

function getOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return window.location.origin;
  }
}

function isPerfettoUiLogMessage(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    '__vscodePerfettoLog__' in value &&
    value.__vscodePerfettoLog__ &&
    typeof value.__vscodePerfettoLog__ === 'object' &&
    typeof value.__vscodePerfettoLog__.level === 'string' &&
    typeof value.__vscodePerfettoLog__.message === 'string'
  );
}

function isPerfettoUiStateMessage(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    '__vscodePerfettoState__' in value &&
    value.__vscodePerfettoState__ &&
    typeof value.__vscodePerfettoState__ === 'object' &&
    typeof value.__vscodePerfettoState__.code === 'string' &&
    typeof value.__vscodePerfettoState__.message === 'string'
  );
}

function isFrameEvent(event) {
  return event.source === frame.contentWindow || (event.source === null && event.origin === uiOrigin);
}

function sameUrl(left, right) {
  if (!left || !right) {
    return left === right;
  }

  try {
    return new URL(left, window.location.href).toString() === new URL(right, window.location.href).toString();
  } catch {
    return left === right;
  }
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function updateWaitingStatus() {
  const elapsedSeconds = waitStartedAt > 0 ? Math.floor((Date.now() - waitStartedAt) / 1000) : 0;
  const debugSuffix = elapsedSeconds >= 5 ? ' See Perfetto output for details.' : '';

  if (!ready) {
    const traceSuffix = pendingTrace ? ' Trace is ready and will open automatically.' : '';
    setStatus(`Waiting for ${uiLabel}... ${elapsedSeconds}s.${traceSuffix}${debugSuffix}`);
  } else if (!traceReceiverReady) {
    setStatus(`Waiting for ${uiLabel} to accept traces... ${elapsedSeconds}s.${debugSuffix}`.trim());
  } else {
    return;
  }

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
