// Popup script. Talks to the background service worker via chrome.runtime.sendMessage.

const $ = (sel) => document.querySelector(sel);
const sendMsg = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const RESTRICTED_URL_RE = /^(chrome|edge|brave|about|devtools|view-source|chrome-extension):/i;

function whyNotAttachable(tab) {
  if (!tab || !tab.url) return "No active tab.";
  if (RESTRICTED_URL_RE.test(tab.url)) {
    return "Chrome doesn't allow debugging this page. Switch to an http(s) tab (e.g. platform.bria.ai) and try again.";
  }
  if (tab.url.startsWith("https://chrome.google.com/webstore") ||
      tab.url.startsWith("https://chromewebstore.google.com")) {
    return "Chrome Web Store pages can't be debugged. Switch to another tab.";
  }
  return null;
}

function shortenPath(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || "");
    return path.length > 60 ? path.slice(0, 57) + "…" : path;
  } catch (_) {
    return url;
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function tryPretty(body) {
  if (body == null || body === "") return "(empty)";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch (_) {
    return String(body);
  }
}

async function refreshStatus() {
  const tab = await getActiveTab();
  const { attachedTabs = [] } = (await sendMsg({ type: "GET_STATUS" })) || {};
  const isOn = tab && attachedTabs.includes(tab.id);
  const btn = $("#toggle-capture");
  const status = $("#status");
  const blockedReason = isOn ? null : whyNotAttachable(tab);

  if (isOn) {
    btn.textContent = "Stop Capture";
    btn.classList.add("on");
    btn.disabled = false;
    status.textContent = "capturing on tab " + tab.id;
    status.classList.add("on");
  } else if (blockedReason) {
    btn.textContent = "Start Capture";
    btn.classList.remove("on");
    btn.disabled = true;
    btn.title = blockedReason;
    status.textContent = blockedReason;
    status.classList.remove("on");
  } else {
    btn.textContent = "Start Capture";
    btn.classList.remove("on");
    btn.disabled = false;
    btn.title = "";
    status.textContent = "idle";
    status.classList.remove("on");
  }
  return { tab, isOn };
}

function renderBody(cap) {
  return cap.responseBase64
    ? "(binary response, " + (cap.responseBody?.length || 0) + " base64 chars)"
    : tryPretty(cap.responseBody);
}

function buildExport(cap, children) {
  if (!children.length) return cap;
  const result = children.find((c) => c.isResult) || null;
  return {
    ...cap,
    correlated: {
      pollCount: result ? children.length - 1 : children.length,
      finalResult: result
        ? {
            url: result.url,
            status: result.status,
            requestTimestamp: result.requestTimestamp,
            responseBody: result.responseBody,
            responseBase64: !!result.responseBase64,
          }
        : null,
    },
  };
}

function populateDetails(node, cap, children) {
  node.querySelector(".request").textContent = tryPretty(cap.requestBody);
  node.querySelector(".response").textContent = renderBody(cap);

  node.querySelectorAll(".dynamic-section").forEach((n) => n.remove());
  if (!children.length) return;

  const detailsEl = node.querySelector(".details");
  const firstStaticDetails = detailsEl.querySelector("details");

  const resultChild = children.find((c) => c.isResult);
  if (resultChild) {
    const wrap = document.createElement("div");
    wrap.className = "final-result dynamic-section";
    const header = document.createElement("div");
    header.className = "final-result-header";
    header.innerHTML = `Final result <small></small>`;
    header.querySelector("small").textContent =
      `(GET ${shortenPath(resultChild.url)} → ${resultChild.status ?? "?"})`;
    wrap.appendChild(header);
    const pre = document.createElement("pre");
    pre.textContent = renderBody(resultChild);
    wrap.appendChild(pre);
    detailsEl.insertBefore(wrap, firstStaticDetails);
  }

  const polls = children.filter((c) => c !== resultChild);
  if (polls.length) {
    const det = document.createElement("details");
    det.className = "polls dynamic-section";
    const sum = document.createElement("summary");
    sum.textContent = `${polls.length} polling request${polls.length === 1 ? "" : "s"}`;
    det.appendChild(sum);
    const ul = document.createElement("ul");
    ul.className = "poll-list";
    polls.forEach((p) => {
      const li = document.createElement("li");
      li.className = "poll-row";
      const m = document.createElement("span");
      m.className = "method " + (p.method || "");
      m.textContent = p.method || "—";
      const path = document.createElement("span");
      path.className = "path";
      path.title = p.url;
      path.textContent = shortenPath(p.url);
      const st = document.createElement("span");
      st.className = "status-code " + (p.status >= 200 && p.status < 400 ? "ok" : "err");
      st.textContent = p.status ?? "?";
      const t = document.createElement("span");
      t.className = "time";
      t.textContent = fmtTime(p.requestTimestamp);
      li.append(m, path, st, t);
      ul.appendChild(li);
    });
    det.appendChild(ul);
    detailsEl.insertBefore(det, firstStaticDetails);
  }
}

function renderCaptureNode(cap, children) {
  const tpl = $("#capture-template");
  const node = tpl.content.firstElementChild.cloneNode(true);

  const method = node.querySelector(".method");
  method.textContent = cap.method || "—";
  method.classList.add(cap.method || "");
  const path = node.querySelector(".path");
  path.textContent = shortenPath(cap.url);
  path.title = cap.url;
  const statusEl = node.querySelector(".status-code");
  if (cap.error) {
    statusEl.textContent = "ERR";
    statusEl.classList.add("err");
  } else if (cap.status != null) {
    statusEl.textContent = cap.status;
    statusEl.classList.add(cap.status >= 200 && cap.status < 400 ? "ok" : "err");
  }
  node.querySelector(".time").textContent = fmtTime(cap.requestTimestamp);

  if (children.length) {
    const badge = document.createElement("span");
    badge.className = "group-badge";
    const hasResult = children.some((c) => c.isResult);
    const pollCount = hasResult ? children.length - 1 : children.length;
    badge.textContent = hasResult
      ? `+${pollCount} polls + result`
      : `+${pollCount} polls`;
    node.querySelector(".row").insertBefore(badge, node.querySelector(".time"));
  }

  const details = node.querySelector(".details");
  node.querySelector(".row").addEventListener("click", () => {
    details.hidden = !details.hidden;
    if (!details.hidden) populateDetails(node, cap, children);
  });

  node.querySelector(".send-excel").addEventListener("click", async (e) => {
    e.stopPropagation();
    const out = node.querySelector(".send-status");
    out.textContent = "sending…";
    try {
      const res = await window.BriaReporters.sendToExcel(buildExport(cap, children));
      out.textContent = res.ok ? "sent to Excel ✓" : "Excel error: " + res.error;
    } catch (err) {
      out.textContent = "Excel error: " + (err.message || err);
    }
  });

  node.querySelector(".send-jira").addEventListener("click", async (e) => {
    e.stopPropagation();
    const out = node.querySelector(".send-status");
    out.textContent = "sending…";
    try {
      const res = await window.BriaReporters.sendToJira(buildExport(cap, children));
      out.textContent = res.ok ? "filed in Jira ✓" : "Jira error: " + res.error;
    } catch (err) {
      out.textContent = "Jira error: " + (err.message || err);
    }
  });

  return node;
}

async function renderCaptures() {
  const { captures = [] } = (await sendMsg({ type: "GET_CAPTURES" })) || {};
  const list = $("#captures");
  const empty = $("#empty");
  list.innerHTML = "";
  if (!captures.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Group children by parentRequestId.
  const childrenByParent = new Map();
  const childIds = new Set();
  for (const c of captures) {
    if (c.parentRequestId) {
      if (!childrenByParent.has(c.parentRequestId)) childrenByParent.set(c.parentRequestId, []);
      childrenByParent.get(c.parentRequestId).push(c);
      childIds.add(c.requestId);
    }
  }
  // Order children oldest-first within each group (so polls are chronological).
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.requestTimestamp - b.requestTimestamp);
  }

  for (const cap of captures) {
    if (childIds.has(cap.requestId)) continue; // rendered inside its parent
    const children = childrenByParent.get(cap.requestId) || [];
    list.appendChild(renderCaptureNode(cap, children));
  }
}

$("#toggle-capture").addEventListener("click", async () => {
  const { tab, isOn } = await refreshStatus();
  if (!tab) return;
  if (isOn) {
    await sendMsg({ type: "STOP_CAPTURE", tabId: tab.id });
  } else {
    const blocked = whyNotAttachable(tab);
    if (blocked) {
      $("#status").textContent = blocked;
      return;
    }
    const res = await sendMsg({ type: "START_CAPTURE", tabId: tab.id });
    if (res?.error) {
      $("#status").textContent = "Could not start capture: " + res.error;
    }
  }
  await refreshStatus();
});

$("#clear").addEventListener("click", async () => {
  await sendMsg({ type: "CLEAR_CAPTURES" });
  await renderCaptures();
});

$("#open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Live-refresh the list while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bria_captures) renderCaptures();
});

refreshStatus();
renderCaptures();
