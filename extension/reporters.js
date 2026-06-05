// Reporter skeletons. Wire these up to your real Jira integration later.
//
// sendToSheets reads `sheetsUrl` from chrome.storage.sync (set on the options
// page) and appends a parsed row to the configured Google Sheet via the
// Sheets API v4, using the signed-in Chrome user's OAuth token.

(function () {
  async function getConfig() {
    const defaults = {
      sheetsUrl: "",
      jiraUrl: "",
      jiraProjectKey: "",
      jiraEmail: "",
      jiraApiToken: "",
    };
    return chrome.storage.sync.get(defaults);
  }

  // ---------------------------------------------------------------------------
  // Column parsing
  // ---------------------------------------------------------------------------

  function parseCaptureToRow(capture) {
    function tryParse(s) {
      if (!s || typeof s !== "string") return null;
      try { return JSON.parse(s); } catch (_) { return null; }
    }

    const req = tryParse(capture.requestBody) || {};
    // Prefer correlated final result (async jobs) over the initial response
    const finalBody = capture.correlated?.finalResult?.responseBody ?? capture.responseBody;
    const resp = tryParse(finalBody) || {};

    // B: Endpoint/Model — URL path without the /vN/ version prefix
    let endpointModel = "";
    try {
      endpointModel = new URL(capture.url).pathname
        .replace(/^\/+v\d+\/+/, "")
        .replace(/\/$/, "");
    } catch (_) {
      endpointModel = capture.url;
    }

    // D: Input image link — first http URL under known image-input field names
    const INPUT_IMG_FIELDS = [
      "image_url", "image", "input_image", "source_image",
      "img", "init_image", "reference_image", "bg_image", "mask_url",
    ];
    let inputImageLink = "";
    for (const f of INPUT_IMG_FIELDS) {
      if (typeof req[f] === "string" && req[f].startsWith("http")) {
        inputImageLink = req[f];
        break;
      }
    }

    // E: Prompt
    const inputPrompt = String(req.prompt || req.text || req.caption || "");

    // F: Seed
    const inputSeed = req.seed != null ? String(req.seed) : "";

    // G: Mode / control type
    const inputMode = String(
      req.mode || req.control_type || req.controlnet_type ||
      req.guidance_type || req.style || req.pipeline || ""
    );

    // I: Output image link — walk common Bria API response shapes
    let outputImageLink = "";
    const candidates = [
      resp.result_url,
      resp.image_url,
      resp.output_url,
      resp.url,
      Array.isArray(resp.result) ? resp.result[0]?.urls?.[0] : null,
      Array.isArray(resp.result) ? resp.result[0]?.url : null,
      Array.isArray(resp.result) && typeof resp.result[0] === "string" ? resp.result[0] : null,
      Array.isArray(resp.images) ? resp.images[0]?.url : null,
      Array.isArray(resp.images) && typeof resp.images[0] === "string" ? resp.images[0] : null,
      Array.isArray(resp.urls) ? resp.urls[0] : null,
    ];
    for (const v of candidates) {
      if (typeof v === "string" && v.startsWith("http")) { outputImageLink = v; break; }
    }

    return [
      "",                              // A: Reported issue  (left for the reporter)
      endpointModel,                   // B: Endpoint/Model
      inputImageLink ? "Yes" : "No",  // C: Image input
      inputImageLink,                  // D: Input image link
      inputPrompt,                     // E: Input Prompt
      inputSeed,                       // F: Input Seed
      inputMode,                       // G: Input Mode (Control)
      outputImageLink ? "Yes" : "No", // H: Image output
      outputImageLink,                 // I: Output image link
      "",                              // J: Use case  (left for the reporter)
    ];
  }

  // ---------------------------------------------------------------------------
  // Model Feedback Hub reporter (Google Sheets)
  // ---------------------------------------------------------------------------

  async function sendToSheets(capture) {
    const { sheetsUrl } = await getConfig();
    if (!sheetsUrl) {
      return { ok: false, error: "Google Sheet URL not configured. Open Settings → Model Feedback Hub." };
    }

    let spreadsheetId;
    try {
      const m = sheetsUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (!m) throw new Error();
      spreadsheetId = m[1];
    } catch (_) {
      return { ok: false, error: "Settings → Model Feedback Hub: URL doesn't look like a Google Sheet." };
    }

    let token;
    try {
      token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (t) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!t) return reject(new Error("No token returned — is the OAuth client ID configured in manifest.json?"));
          resolve(t);
        });
      });
    } catch (err) {
      return { ok: false, error: "Google auth failed: " + err.message };
    }

    const row = parseCaptureToRow(capture);

    try {
      const range = encodeURIComponent("A1");
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ values: [row] }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: `Sheets API ${res.status}: ${body?.error?.message || res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // --- Jira reporter (skeleton) ----------------------------------------------
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

  async function sendToJira(capture) {
    const cfg = await getConfig();
    if (!cfg.jiraUrl || !cfg.jiraProjectKey || !cfg.jiraEmail || !cfg.jiraApiToken) {
      return { ok: false, error: "Jira not fully configured (Settings → Jira)." };
    }
    void buildPayload(capture);
    return { ok: false, error: "Jira reporter is a skeleton — wire up rest/api/3/issue in reporters.js." };
  }

<<<<<<< Updated upstream
  window.BriaReporters = { sendToExcel, sendToJira };
=======
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

    // HTTP/2 pseudo-headers and length headers curl rejects or auto-sets
    const SKIP_HEADERS = new Set([":authority", ":method", ":path", ":scheme", "content-length"]);

    function buildCurl(method, url, headers, body) {
      const lines = [`curl -X ${method} "${url}"`];
      for (const [k, v] of Object.entries(headers || {})) {
        if (SKIP_HEADERS.has(k.toLowerCase())) continue;
        lines.push(`  -H "${k}: ${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
      }
      if (body) {
        lines.push(`  -d '${fmtBody(body, false).replace(/'/g, "'\\''")}'`);
      }
      return lines.join(" \\\n");
    }

    const DIVIDER = "=".repeat(80);
    const SEP = "-".repeat(40);
    const blocks = [];

    blocks.push([
      DIVIDER,
      `${capture.method} ${capture.url}`,
      `Time: ${fmtTimestamp(capture.requestTimestamp)}`,
      SEP,
      buildCurl(capture.method, capture.url, capture.requestHeaders, capture.requestBody),
      SEP,
      `Response: ${capture.status ?? "?"} ${capture.statusText || ""}`.trimEnd(),
      fmtBody(capture.responseBody, !!capture.responseBase64),
      DIVIDER,
    ].join("\n"));

    if (capture.correlated?.finalResult) {
      const r = capture.correlated.finalResult;
      const pollCount = capture.correlated.pollCount;
      blocks.push([
        DIVIDER,
        `GET ${r.url}  [final result after ${pollCount} poll${pollCount === 1 ? "" : "s"}]`,
        `Time: ${fmtTimestamp(r.requestTimestamp)}`,
        SEP,
        buildCurl("GET", r.url, r.requestHeaders, null),
        SEP,
        `Response: ${r.status ?? "?"}`,
        fmtBody(r.responseBody, r.responseBase64),
        DIVIDER,
      ].join("\n"));
    }

    try {
      await navigator.clipboard.writeText(blocks.join("\n\n"));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

<<<<<<< HEAD
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
=======
  window.BriaReporters = { sendToSheets, sendToJira, copyToClipboard };
>>>>>>> Stashed changes
>>>>>>> b85ecac (Framework for google OAuth)
})();
