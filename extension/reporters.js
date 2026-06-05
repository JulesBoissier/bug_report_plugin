// Reporter skeletons. Wire these up to your real Excel/Jira integrations later.
//
// Both functions read configuration from chrome.storage.sync. The URLs are set
// on the options page. For now, they POST a JSON envelope to the configured
// endpoint and return { ok: true } or { ok: false, error }.

(function () {
  async function getConfig() {
    const defaults = {
      excelUrl: "",
      jiraUrl: "",
      jiraProjectKey: "",
      jiraEmail: "",
      jiraApiToken: "",
    };
    const cfg = await chrome.storage.sync.get(defaults);
    return cfg;
  }

  function buildPayload(capture) {
    const payload = {
      capturedAt: new Date(capture.requestTimestamp).toISOString(),
      method: capture.method,
      url: capture.url,
      status: capture.status,
      statusText: capture.statusText,
      requestHeaders: capture.requestHeaders,
      requestBody: capture.requestBody,
      responseHeaders: capture.responseHeaders,
      responseBody: capture.responseBase64 ? "[binary omitted]" : capture.responseBody,
      error: capture.error || null,
    };
    // If popup correlated polling GETs to this POST, include the resolved result.
    if (capture.correlated) {
      const r = capture.correlated.finalResult;
      payload.async = {
        pollCount: capture.correlated.pollCount,
        finalResultUrl: r ? r.url : null,
        finalResultStatus: r ? r.status : null,
        finalResultBody: r ? (r.responseBase64 ? "[binary omitted]" : r.responseBody) : null,
      };
    }
    return payload;
  }

  // --- Excel reporter (skeleton) ---------------------------------------------
  // Point `excelUrl` at a webhook that appends a row to a spreadsheet:
  //   - Microsoft Power Automate "When a HTTP request is received" → "Add a row"
  //   - Zapier / Make webhook → Google Sheets / Excel Online
  //   - A small server of your own
  // The payload below is what your webhook will receive.
  async function sendToExcel(capture) {
    const { excelUrl } = await getConfig();
    if (!excelUrl) {
      return { ok: false, error: "Excel webhook URL not configured (Settings → Excel)." };
    }
    try {
      const res = await fetch(excelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(capture)),
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // --- Jira reporter (skeleton) ----------------------------------------------
  // Real wiring will POST to `${jiraUrl}/rest/api/3/issue` with Basic auth
  // (`base64(email:apiToken)`) and an ADF-formatted description. Stubbed here
  // so this file stays a skeleton — fill in when you're ready.
  async function sendToJira(capture) {
    const cfg = await getConfig();
    if (!cfg.jiraUrl || !cfg.jiraProjectKey || !cfg.jiraEmail || !cfg.jiraApiToken) {
      return { ok: false, error: "Jira not fully configured (Settings → Jira)." };
    }

    // TODO: implement real Jira issue creation.
    // const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
    // const body = {
    //   fields: {
    //     project: { key: cfg.jiraProjectKey },
    //     summary: `Bria API ${capture.method} ${new URL(capture.url).pathname}`,
    //     issuetype: { name: "Bug" },
    //     description: { /* ADF document built from buildPayload(capture) */ },
    //   },
    // };
    // const res = await fetch(`${cfg.jiraUrl.replace(/\/$/, "")}/rest/api/3/issue`, {
    //   method: "POST",
    //   headers: {
    //     "Authorization": `Basic ${auth}`,
    //     "Content-Type": "application/json",
    //     "Accept": "application/json",
    //   },
    //   body: JSON.stringify(body),
    // });
    // if (!res.ok) return { ok: false, error: "HTTP " + res.status };
    // const json = await res.json();
    // return { ok: true, key: json.key };

    void buildPayload(capture);
    return { ok: false, error: "Jira reporter is a skeleton — wire up rest/api/3/issue in reporters.js." };
  }

  // --- Clipboard reporter ---------------------------------------------------
  async function copyToClipboard(capture) {
    function fmtTimestamp(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    function fmtBody(body, isBase64) {
      if (isBase64) return "(binary data)";
      if (!body || body === "") return "(empty)";
      try { return JSON.stringify(JSON.parse(body), null, 2); } catch (_) { return String(body); }
    }

    const lines = [];

    lines.push(`[${capture.method}] ${capture.url}`);
    lines.push(`Time: ${fmtTimestamp(capture.requestTimestamp)}`);
    lines.push("");
    lines.push("--- Request ---");
    lines.push(fmtBody(capture.requestBody, false));
    lines.push("");
    lines.push(`--- Response (${capture.status ?? "?"}) ---`);
    lines.push(fmtBody(capture.responseBody, !!capture.responseBase64));

    if (capture.correlated?.finalResult) {
      const r = capture.correlated.finalResult;
      const pollCount = capture.correlated.pollCount;
      lines.push("");
      lines.push(`--- Final Result (after ${pollCount} poll${pollCount === 1 ? "" : "s"}) ---`);
      lines.push(`[GET] ${r.url}`);
      lines.push(`Time: ${fmtTimestamp(r.requestTimestamp)}`);
      lines.push("");
      lines.push(`--- Response (${r.status ?? "?"}) ---`);
      lines.push(fmtBody(r.responseBody, r.responseBase64));
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  window.BriaReporters = { sendToExcel, sendToJira, copyToClipboard };
})();
