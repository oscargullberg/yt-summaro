import { signInToPlan } from "./plan-settings.js";

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  plan: null,
  toastTimer: null
};

const DEFAULTS = {
  style: "standard",
  language: "en",
  localAsr: { enabled: true, model: "base" },
  models: { chatgpt: "" },
  rememberSession: true
};

async function send(type, payload) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
  } catch (error) {
    throw new Error(
      /context invalidated/i.test(String(error && error.message))
        ? "The extension was reloaded. Reopen this page."
        : "The extension background worker is not responding."
    );
  }
  if (!response) throw new Error("The extension background worker did not respond.");
  if (!response.ok) throw new Error((response.error && response.error.message) || "Request failed.");
  return response;
}

function showToast(message, kind = "ok") {
  const toast = $("toast");
  toast.textContent = message;
  toast.dataset.state = kind;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3800);
}

function option(value, label, selected) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  if (selected) node.selected = true;
  return node;
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || "Working…";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function renderSettings() {
  const settings = state.settings || DEFAULTS;
  const local = settings.localAsr || DEFAULTS.localAsr;
  $("style").value = settings.style;
  $("language").value = settings.language;
  $("local-asr-enabled").checked = Boolean(local.enabled);
  $("local-asr-model").value = local.model;
  $("plan-remember").checked = settings.rememberSession !== false;
  populateModels();
  void refreshLocalAsr();
}

function populateModels() {
  const select = $("model");
  const saved = state.settings?.models?.chatgpt || "";
  const models = state.plan?.models || [];

  select.replaceChildren(option("", "Default model", !saved));
  if (saved && !models.includes(saved)) select.append(option(saved, saved, true));
  for (const name of models) select.append(option(name, name, name === saved));
  select.value = saved;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

async function refreshLocalAsr() {
  const local = state.settings?.localAsr || DEFAULTS.localAsr;
  const badge = $("local-asr-status");
  badge.dataset.state = local.enabled ? "ok" : "warn";
  $("local-asr-state").textContent = local.enabled ? "On" : "Off";

  let used = 0;
  let hasModel = false;
  let transcripts = 0;
  try { used = (await navigator.storage.estimate()).usage || 0; } catch { /* Storage estimate is optional. */ }
  try { hasModel = await caches.has("transformers-cache"); } catch { /* Cache API may be unavailable. */ }
  try {
    const stored = await chrome.storage.local.get("asrTranscriptIndex");
    transcripts = Array.isArray(stored.asrTranscriptIndex) ? stored.asrTranscriptIndex.length : 0;
  } catch { /* Storage may be unavailable during reload. */ }

  const model = hasModel ? "Whisper model cached" : "Model downloads on first use";
  const saved = `${transcripts} local transcript${transcripts === 1 ? "" : "s"} saved`;
  $("local-asr-info").textContent = `${model} · ${saved} · ${formatBytes(used)} used by the extension`;
}

async function saveLocalAsr() {
  const button = $("save-local-asr");
  setButtonBusy(button, true, "Saving…");
  try {
    const response = await send("settings:set", {
      patch: { localAsr: { enabled: $("local-asr-enabled").checked, model: $("local-asr-model").value } }
    });
    state.settings = response.settings;
    void refreshLocalAsr();
    showToast("Local Whisper settings saved.", "ok");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function clearLocalAsr() {
  if (!confirm("Remove the downloaded Whisper models and all saved local transcripts? The next transcription will download the model again.")) return;
  const button = $("clear-local-asr");
  setButtonBusy(button, true, "Clearing…");
  try {
    await send("asr:reset");
    showToast("Local Whisper models and transcripts cleared.", "ok");
    await refreshLocalAsr();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshPlan() {
  const status = $("plan-status");
  try {
    state.plan = await send("plan:status");
    status.dataset.state = state.plan.connected ? "ok" : "neutral";
    status.textContent = !state.plan.connected
      ? "Not connected"
      : state.plan.persisted
        ? "Connected · saved on this device"
        : "Connected · this Chrome session only";
    $("plan-connect").disabled = Boolean(state.plan.hasSession);
    $("plan-connect").hidden = Boolean(state.plan.hasSession);
    $("plan-disconnect").disabled = !state.plan.hasSession;
    $("plan-disconnect").hidden = !state.plan.hasSession;
    populateModels();
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error.message;
    $("plan-connect").hidden = false;
    $("plan-connect").disabled = false;
  }
}

function setupPlan() {
  $("plan-connect").addEventListener("click", async () => {
    $("plan-connect").disabled = true;
    $("plan-status").dataset.state = "loading";
    $("plan-status").textContent = "Complete sign-in in the ChatGPT tab…";
    try {
      await signInToPlan(send);
    } catch (error) { showToast(error.message, "error"); }
    finally { await refreshPlan(); }
  });
  $("plan-disconnect").addEventListener("click", async () => {
    if (!confirm("Disconnect ChatGPT from YT Summaro? Saved summaries stay on this device, but new summaries will need a new sign-in.")) return;
    $("plan-disconnect").disabled = true;
    try {
      const result = await send("plan:disconnect");
      if (result.localCleared === false) {
        showToast("Chrome could not remove all saved sign-in data. You can remove access in ChatGPT Settings.", "error");
      } else if (result.revoked === false) {
        showToast("Local session cleared. OpenAI did not confirm revocation. You can remove access in ChatGPT Settings.", "error");
      }
    } catch (error) { showToast(error.message, "error"); }
    finally { await refreshPlan(); }
  });
  $("plan-remember").addEventListener("change", async () => {
    const box = $("plan-remember");
    const enabled = box.checked;
    box.disabled = true;
    try {
      state.settings = (await send("settings:set", { patch: { rememberSession: enabled } })).settings;
      showToast(enabled
        ? "ChatGPT sign-in will be saved on this device."
        : "ChatGPT sign-in will be kept for this Chrome session only.", "ok");
      await refreshPlan();
    } catch (error) {
      box.checked = !enabled;
      showToast(error.message, "error");
    } finally {
      box.disabled = false;
    }
  });
  void refreshPlan();
}

async function init() {
  $("extension-version").textContent = `v${chrome.runtime.getManifest().version}`;
  try {
    state.settings = (await send("settings:get")).settings;
  } catch (error) {
    state.settings = structuredClone(DEFAULTS);
    showToast(error.message, "error");
  }
  renderSettings();
  setupPlan();
  $("save-local-asr").addEventListener("click", () => void saveLocalAsr());
  $("clear-local-asr").addEventListener("click", () => void clearLocalAsr());
  $("save-settings").addEventListener("click", async () => {
    const button = $("save-settings");
    setButtonBusy(button, true, "Saving…");
    try {
      state.settings = (await send("settings:set", { patch: {
        style: $("style").value,
        language: $("language").value,
        models: { chatgpt: $("model").value }
      } })).settings;
      showToast("Summary defaults saved.");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  });
  $("clear-summaries").addEventListener("click", async () => {
    if (!confirm("Remove every saved summary from this Chrome profile? This cannot be undone.")) return;
    const button = $("clear-summaries");
    setButtonBusy(button, true, "Clearing…");
    try {
      const { removed } = await send("summary:clear");
      showToast(removed
        ? `Removed ${removed} saved summar${removed === 1 ? "y" : "ies"}.`
        : "There were no saved summaries to remove.", "ok");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setButtonBusy(button, false);
    }
  });
}

void init();
