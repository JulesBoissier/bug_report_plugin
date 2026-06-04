# Bria API Inspector — Chrome Extension

Captures recent Bria API requests + responses from any tab you opt into, and lets
you ship each call into Excel (via a webhook) or Jira (skeleton).

## Install (unpacked, dev mode)

1. Open `chrome://extensions/` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select this `extension/` folder.

The extension's icon appears in the toolbar (you may need to pin it from the
puzzle-piece menu).

## Use it

1. Open a tab that calls Bria — e.g. `platform.bria.ai`, an app of yours, or
   `docs.bria.ai`'s playground.
2. Click the extension icon → **Start Capture**.
   - Chrome shows a yellow "Bria API Inspector started debugging this browser"
     banner. That's expected — it's the only way an extension can read response
     bodies. Click **Cancel** on the banner to keep capturing.
3. Trigger Bria API calls in the page (e.g. generate an image).
4. Each capture appears in the popup with method, path, status. Click a row to
   expand and see the raw request and response payloads.
5. Per capture: **Send to Excel** posts the JSON envelope to your configured
   webhook. **Send to Jira** is wired as a skeleton — fill in `reporters.js`
   when ready.

## Configure reporting URLs

Open the extension's **Settings** page (gear icon in the popup, or
`chrome://extensions/` → Details → Extension options):

- **Excel webhook URL** — any HTTPS endpoint that accepts a JSON POST. The
  easiest end-to-end path is a Power Automate flow with a "When a HTTP request
  is received" trigger followed by "Add a row into a table". Zapier and Make
  webhooks work the same way.
- **Jira** — base URL (e.g. `https://your-org.atlassian.net`), project key,
  account email, and an API token from
  `https://id.atlassian.com/manage-profile/security/api-tokens`. The reporter
  currently returns a "skeleton" error — see `reporters.js` for the commented-
  out `rest/api/3/issue` call to enable.

## What it captures

Any request whose host matches `*.bria-api.com` or whose URL contains
`bria.ai/api`. The CDP `Network` domain provides:

- request URL, method, headers, body (`postData`)
- response status, headers, mime type, body (decoded; binary marked
  `responseBase64`)

Captures are stored in `chrome.storage.local` (last 50, ring buffer).

## Files

```
extension/
├── manifest.json         MV3 manifest
├── background.js         service worker — debugger attach + capture
├── popup.html/.css/.js   toolbar popup UI
├── reporters.js          Excel POST + Jira skeleton
├── options.html/.js      settings page
└── README.md
```

## Limitations / notes

- Uses `chrome.debugger`, so DevTools cannot be open on the same tab while
  capturing. (Chrome only allows one debugger client per tab.)
- The yellow banner is mandatory whenever any extension uses `chrome.debugger`.
- Capture state is per-tab; closing the tab detaches automatically.
- The Jira reporter is intentionally left as a skeleton per the build brief.
