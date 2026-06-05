const FIELDS = ["sheetsUrl", "jiraUrl", "jiraProjectKey", "jiraEmail", "jiraApiToken"];

async function load() {
  const cfg = await chrome.storage.sync.get(FIELDS);
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el) el.value = cfg[id] || "";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const update = {};
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    update[id] = el ? el.value.trim() : "";
  }
  await chrome.storage.sync.set(update);
  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});

load();
