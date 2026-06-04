// Bria API Inspector - background service worker.
// Uses chrome.debugger (Chrome DevTools Protocol) to capture full request/response
// payloads on tabs the user has opted into.

const DEBUGGER_PROTOCOL = "1.3";
const MAX_CAPTURES = 50;
const STORAGE_KEY = "bria_captures";
const ATTACHED_TABS_KEY = "bria_attached_tabs";
const CORRELATIONS_KEY = "bria_correlations";
const MAX_CORRELATIONS_PER_TAB = 20;

// Heuristics for async-job correlation.
const ID_KEY_NAMES = new Set([
  "id", "task_id", "request_id", "job_id", "generation_id",
  "tid", "rid", "operation_id", "ref",
]);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RESULT_KEY_RE = /^(result|output|image|images|urls|image_url|result_url|output_url|generated|generated_images?)$/i;
const COMPLETED_STATUSES = new Set(["completed", "succeeded", "finished", "done", "success"]);

// Matches Bria API hosts:
//   engine.prod.bria-api.com     (any *.bria-api.com)
//   platform-api.bria.ai         (any *api*.bria.ai subdomain — covers api., platform-api., etc.)
const BRIA_URL_PATTERNS = [
  /(^|\.)bria-api\.com$/i,
  /(^|\.)[\w-]*api[\w-]*\.bria\.ai$/i,
];

// In-memory pending requests, keyed by `${tabId}:${requestId}`.
// Service workers can be evicted; we re-hydrate on Network events.
const pending = new Map();

function isBriaUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).host;
    return BRIA_URL_PATTERNS.some((p) => p.test(host));
  } catch (_) {
    return false;
  }
}

async function getAttachedTabs() {
  const { [ATTACHED_TABS_KEY]: arr = [] } = await chrome.storage.local.get(ATTACHED_TABS_KEY);
  return new Set(arr);
}

async function setAttachedTabs(set) {
  await chrome.storage.local.set({ [ATTACHED_TABS_KEY]: Array.from(set) });
}

async function markAttached(tabId, attached) {
  const set = await getAttachedTabs();
  if (attached) set.add(tabId);
  else set.delete(tabId);
  await setAttachedTabs(set);
}

async function attachToTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve();
      });
    });
  });
}

async function detachFromTab(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Ignore errors — tab may already be closed or detached.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function parseJsonSafe(body) {
  if (!body || typeof body !== "string") return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

// Walk a parsed JSON value and collect candidate identifiers:
// - any string value under a key in ID_KEY_NAMES
// - any UUID-shaped substring anywhere
function extractIds(parsed) {
  const ids = new Set();
  function walk(value, key) {
    if (value == null) return;
    if (typeof value === "string") {
      if (key && ID_KEY_NAMES.has(String(key).toLowerCase())) ids.add(value);
      const m = value.match(UUID_RE);
      if (m) m.forEach((u) => ids.add(u));
    } else if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  }
  walk(parsed, null);
  return Array.from(ids).filter((s) => s.length >= 8); // ignore short noise like numeric ids
}

// Heuristic: does this response look like a finished result (vs. an in-progress poll)?
function looksLikeResult(parsed) {
  if (parsed == null || typeof parsed !== "object") return false;
  if (parsed.status && COMPLETED_STATUSES.has(String(parsed.status).toLowerCase())) return true;
  function check(value) {
    if (value == null) return false;
    if (typeof value === "string") return /^https?:\/\//i.test(value);
    if (Array.isArray(value)) return value.some(check);
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (RESULT_KEY_RE.test(k) && check(v)) return true;
      }
    }
    return false;
  }
  return check(parsed);
}

async function getCorrelations() {
  const { [CORRELATIONS_KEY]: map = {} } = await chrome.storage.local.get(CORRELATIONS_KEY);
  return map;
}

async function saveCorrelations(map) {
  await chrome.storage.local.set({ [CORRELATIONS_KEY]: map });
}

async function recordPostCorrelation(entry) {
  const ids = extractIds(parseJsonSafe(entry.responseBody));
  if (!ids.length) return;
  const map = await getCorrelations();
  const key = String(entry.tabId);
  if (!map[key]) map[key] = [];
  map[key].unshift({
    parentRequestId: entry.requestId,
    parentTimestamp: entry.requestTimestamp,
    ids,
  });
  if (map[key].length > MAX_CORRELATIONS_PER_TAB) {
    map[key].length = MAX_CORRELATIONS_PER_TAB;
  }
  await saveCorrelations(map);
}

async function findParent(tabId, url) {
  const map = await getCorrelations();
  const candidates = map[String(tabId)] || [];
  for (const c of candidates) {
    for (const id of c.ids) {
      if (id && url.includes(id)) return c;
    }
  }
  return null;
}

async function appendCapture(entry) {
  // Correlate before persisting.
  const parsedResponse = parseJsonSafe(entry.responseBody);
  entry.isResult = !!looksLikeResult(parsedResponse);

  if (entry.method === "POST") {
    await recordPostCorrelation(entry);
  } else {
    const parent = await findParent(entry.tabId, entry.url);
    if (parent) {
      entry.parentRequestId = parent.parentRequestId;
      entry.parentTimestamp = parent.parentTimestamp;
    }
  }

  const { [STORAGE_KEY]: list = [] } = await chrome.storage.local.get(STORAGE_KEY);
  list.unshift(entry);
  if (list.length > MAX_CAPTURES) list.length = MAX_CAPTURES;
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

function getResponseBody(tabId, requestId) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId },
      (result) => {
        if (chrome.runtime.lastError || !result) {
          return resolve({ body: null, base64Encoded: false });
        }
        resolve({ body: result.body, base64Encoded: !!result.base64Encoded });
      },
    );
  });
}

// CDP events arrive here for every attached tab.
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!source.tabId) return;
  const key = `${source.tabId}:${params.requestId}`;

  if (method === "Network.requestWillBeSent") {
    if (!isBriaUrl(params.request?.url)) return;
    pending.set(key, {
      tabId: source.tabId,
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers || {},
      requestBody: params.request.postData ?? null,
      requestTimestamp: Date.now(),
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const entry = pending.get(key);
    if (!entry) return;
    entry.status = params.response?.status ?? null;
    entry.statusText = params.response?.statusText ?? "";
    entry.responseHeaders = params.response?.headers || {};
    entry.mimeType = params.response?.mimeType ?? "";
    return;
  }

  if (method === "Network.loadingFinished") {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    const { body, base64Encoded } = await getResponseBody(source.tabId, params.requestId);
    entry.responseBody = body;
    entry.responseBase64 = base64Encoded;
    entry.responseTimestamp = Date.now();
    await appendCapture(entry);
  }

  if (method === "Network.loadingFailed") {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    entry.error = params.errorText || "Loading failed";
    entry.responseTimestamp = Date.now();
    await appendCapture(entry);
  }
});

// If the user closes DevTools or the tab, debugger detaches automatically.
chrome.debugger.onDetach.addListener(async (source) => {
  if (source.tabId != null) await markAttached(source.tabId, false);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await markAttached(tabId, false);
  const map = await getCorrelations();
  if (map[String(tabId)]) {
    delete map[String(tabId)];
    await saveCorrelations(map);
  }
});

// Message API for popup/options.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "GET_STATUS") {
        const set = await getAttachedTabs();
        sendResponse({ attachedTabs: Array.from(set) });
        return;
      }
      if (msg.type === "START_CAPTURE") {
        await attachToTab(msg.tabId);
        await markAttached(msg.tabId, true);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "STOP_CAPTURE") {
        await detachFromTab(msg.tabId);
        await markAttached(msg.tabId, false);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "GET_CAPTURES") {
        const { [STORAGE_KEY]: list = [] } = await chrome.storage.local.get(STORAGE_KEY);
        sendResponse({ captures: list });
        return;
      }
      if (msg.type === "CLEAR_CAPTURES") {
        await chrome.storage.local.set({ [STORAGE_KEY]: [], [CORRELATIONS_KEY]: {} });
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ error: "Unknown message type" });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true; // async response
});
