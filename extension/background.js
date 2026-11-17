import { exchangeCode, listPlanModels, PlanError, revokeSession, validateConnection } from "./plan-auth.js";
import { readYouTubeCaptions } from "./plan-captions.js";
import { readYouTubeAudio } from "./plan-audio.js";
import { connectSession, disconnectSession, getAccessToken, getSessionStatus, setPersistence } from "./plan-session.js";
import { clearSavedSummaries, readSavedSummary, saveSummary } from "./plan-summary-cache.js";
import { clearSavedTranscripts, readSavedTranscript, saveTranscript } from "./plan-transcript-cache.js";
import { AsrError, WHISPER_MODELS } from "./plan-whisper-core.js";

const DEFAULT_SETTINGS = {
  style: "standard",
  language: "en",
  localAsr: { enabled: true, model: "base" },
  models: { chatgpt: "" },
  rememberSession: true
};

const STYLES = ["brief", "standard", "detailed"];
const LANGUAGES = ["en", "auto", "system"];
const LEGACY_LANGUAGES = { sv: "system" };
const runtimeUrl = chrome.runtime.getURL("plan-runtime.html");
const RUNTIME_CONNECT_ATTEMPTS = 6;
const RUNTIME_CONNECT_DELAY_MS = 60;
let creatingRuntime;
let connectingSession = false;
let settingsWrite = Promise.resolve();

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(() => console.warn("Could not restrict extension storage access."));

function normalizeSettings(stored = {}) {
  const localAsr = stored.localAsr && typeof stored.localAsr === "object" ? stored.localAsr : {};
  const models = stored.models && typeof stored.models === "object" ? stored.models : {};
  const storedLanguage = LEGACY_LANGUAGES[stored.language] || stored.language;
  return {
    style: STYLES.includes(stored.style) ? stored.style : DEFAULT_SETTINGS.style,
    language: LANGUAGES.includes(storedLanguage) ? storedLanguage : DEFAULT_SETTINGS.language,
    localAsr: {
      enabled: typeof localAsr.enabled === "boolean" ? localAsr.enabled : DEFAULT_SETTINGS.localAsr.enabled,
      model: Object.hasOwn(WHISPER_MODELS, localAsr.model) ? localAsr.model : DEFAULT_SETTINGS.localAsr.model
    },
    models: {
      chatgpt: typeof models.chatgpt === "string" ? models.chatgpt.trim().slice(0, 160) : ""
    },
    rememberSession: stored.rememberSession !== false
  };
}

async function getSettings() {
  return normalizeSettings(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS)));
}

async function setSettings(patch) {
  const next = await getSettings();
  if (STYLES.includes(patch.style)) next.style = patch.style;
  if (LANGUAGES.includes(patch.language)) next.language = patch.language;
  if (typeof patch.localAsr?.enabled === "boolean") next.localAsr.enabled = patch.localAsr.enabled;
  if (Object.hasOwn(WHISPER_MODELS, patch.localAsr?.model)) next.localAsr.model = patch.localAsr.model;
  if (typeof patch.models?.chatgpt === "string") next.models.chatgpt = patch.models.chatgpt.trim().slice(0, 160);
  const persistence = typeof patch.rememberSession === "boolean" ? patch.rememberSession : null;
  if (persistence !== null) {
    await setPersistence(persistence);
    next.rememberSession = persistence;
  }
  await chrome.storage.local.set(next);
  return next;
}

function errorPayload(error) {
  return { ok: false, error: { message: error.message, code: error.code || "EXTENSION_ERROR" } };
}

function isRuntimeConnectionError(error) {
  return /could not establish connection|receiving end does not exist/i.test(String(error?.message || error));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntime() {
  if (!creatingRuntime) {
    creatingRuntime = chrome.offscreen.createDocument({
      url: "plan-runtime.html",
      reasons: ["DOM_PARSER", "USER_MEDIA", "WORKERS"],
      justification: "Read caption XML and run local Whisper. Use tab audio only when the user starts playback transcription."
    }).catch((error) => {
      // Another extension context can win the create race after a reload.
      if (!/single offscreen document/i.test(String(error?.message || error))) throw error;
    }).finally(() => { creatingRuntime = undefined; });
  }
  await creatingRuntime;
}

async function planRuntime(type, input = {}) {
  const message = { target: "plan-runtime", type, ...input };
  for (let attempt = 0; attempt < RUNTIME_CONNECT_ATTEMPTS; attempt++) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [runtimeUrl] });
    if (!contexts.length) {
      if (type === "get" || type === "cancel") {
        throw new AsrError("This browser summary is no longer available.", "PLAN_JOB_GONE");
      }
      if (["tab-closed", "navigation", "disconnect"].includes(type)) return { ok: true };
      if (type !== "start" && type !== "asr-reset") return { ok: true };
      await createRuntime();
    }
    try {
      return await chrome.runtime.sendMessage(message) ||
        errorPayload(new Error("The browser summary runtime did not respond."));
    } catch (error) {
      // The offscreen document can exist before its message listener is ready.
      if (attempt === RUNTIME_CONNECT_ATTEMPTS - 1 || !isRuntimeConnectionError(error)) throw error;
      await wait(RUNTIME_CONNECT_DELAY_MS * (attempt + 1));
    }
  }
  throw new Error("The browser summary runtime could not be started.");
}

async function connectPlan({ tx, callback }) {
  if (connectingSession) throw new PlanError("Wait for sign-in to finish.");
  connectingSession = true;
  let tokens;
  try {
    tokens = await exchangeCode(tx, callback);
    const { expiresAt } = await validateConnection(tokens, tx, callback.clientId);
    const models = await listPlanModels(tokens.access_token);
    if (!models.length) throw new PlanError("This account did not list any models for ChatGPT plan access.");
    const settings = await getSettings();
    return await connectSession({
      tokens,
      clientId: callback.clientId,
      models,
      expiresAt,
      persist: settings.rememberSession
    });
  } catch (error) {
    if (tokens && await revokeSession(tokens, callback.clientId) === false) {
      throw new PlanError("Could not connect or confirm session revocation. You can remove YT Summaro access in ChatGPT Settings.");
    }
    throw error;
  } finally {
    connectingSession = false;
  }
}

async function notifyWatchTabs(type) {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" }).catch(() => []);
  await Promise.allSettled(tabs.map(({ id }) =>
    chrome.tabs.sendMessage(id, { type }, { frameId: 0 })
  ));
}

function watchTab(sender, videoId) {
  const url = new URL(sender.url || "about:blank");
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || url.origin !== "https://www.youtube.com" ||
      url.pathname !== "/watch" || (videoId && url.searchParams.get("v") !== videoId)) {
    throw new AsrError("Open the video on YouTube first.", "INVALID_VIDEO_TAB");
  }
  return sender.tab.id;
}

async function startJob(input, sender) {
  if (!/^[\w-]{11}$/.test(input?.videoId || "") || !STYLES.includes(input.style) || !LANGUAGES.includes(input.language)) {
    throw new Error("Invalid video, summary style, or language.");
  }
  const tabId = watchTab(sender, input.videoId);
  if (input.force !== true) {
    const job = await readSavedSummary(input.videoId);
    if (job) return { ok: true, job };
  }
  const session = await getSessionStatus();
  if (!session.connected) {
    throw new PlanError("Connect your ChatGPT plan in YT Summaro Settings first.", "PLAN_DISCONNECTED");
  }
  await settingsWrite;
  const settings = await getSettings();
  return planRuntime("start", {
    tabId,
    input: {
      videoId: input.videoId,
      style: input.style,
      language: input.language,
      model: settings.models.chatgpt,
      asrModel: settings.localAsr.model,
      asrEnabled: settings.localAsr.enabled,
      force: input.force === true,
      capture: input.capture === true,
      preferPlayback: input.capture === true && input.preferPlayback === true
    }
  });
}

async function readSource({ tabId, videoId, source, candidate }) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: source === "audio" ? readYouTubeAudio : readYouTubeCaptions, args: source === "audio" ? [videoId, candidate] : [videoId]
  });
  if (!result || result.videoId !== videoId) {
    throw new AsrError("The video changed before YouTube could be read.", "INVALID_VIDEO_TAB");
  }
  if (source === "captions") {
    const visibleChars = Array.isArray(result.visible)
      ? result.visible.reduce((total, cue) => total + (typeof cue?.text === "string" ? cue.text.length : 0), 0)
      : 0;
    if ((typeof result.body === "string" && result.body.length > 4_000_000) ||
        (Array.isArray(result.visible) && (result.visible.length > 20_000 || visibleChars > 4_000_000))) {
      throw new AsrError("The caption response exceeded the browser limit.", "CAPTIONS_TOO_LARGE");
    }
  }
  return { result };
}

async function handleRuntimeRequest(message) {
  if (message.type === "read-source") return readSource(message);
  if (message.type === "session-status") return getSessionStatus();
  if (message.type === "access-token") return getAccessToken({ force: message.force === true });
  if (message.type === "save-summary") {
    const { result } = message;
    const videoId = result?.meta?.videoId;
    if (!/^[\w-]{11}$/.test(videoId || "") || typeof result.summary?.tldr !== "string") {
      throw new Error("Invalid video summary.");
    }
    return { saved: await saveSummary(videoId, result) };
  }
  if (message.type === "clear-transcripts") {
    await clearSavedTranscripts();
    return {};
  }
  if (message.type === "read-transcript" || message.type === "save-transcript") {
    const { videoId, model } = message;
    if (!/^[\w-]{11}$/.test(videoId || "") || !Object.hasOwn(WHISPER_MODELS, model)) {
      throw new Error("Invalid local transcript.");
    }
    if (message.type === "read-transcript") return { transcript: await readSavedTranscript(videoId, model) };
    await saveTranscript(videoId, model, message.transcript);
    return {};
  }
  if (message.type === "capture-token") {
    const tab = await chrome.tabs.get(message.tabId);
    const url = new URL(tab.url || "about:blank");
    if (!tab.active || url.origin !== "https://www.youtube.com" || url.pathname !== "/watch" || url.searchParams.get("v") !== message.videoId) {
      throw new AsrError("Keep the YouTube video active and click YT Summaro in the Chrome toolbar.", "AUDIO_CAPTURE_REQUIRED");
    }
    try {
      return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }) };
    } catch {
      throw new AsrError("Click YT Summaro in the Chrome toolbar to allow audio capture for this tab.", "AUDIO_CAPTURE_REQUIRED");
    }
  }
  if (message.type === "playback") {
    return { result: await chrome.tabs.sendMessage(message.tabId, {
      type: "playback", command: message.command, videoId: message.videoId, captureId: message.captureId
    }, { frameId: 0 }) };
  }
  throw new Error("Unknown runtime request.");
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "settings:get": return { ok: true, settings: await getSettings() };
    case "settings:set": {
      const patch = message.patch || {};
      if (sender.url === chrome.runtime.getURL("options.html")) {
        if (sender.frameId !== 0) throw new Error("Open YT Summaro Settings.");
      } else {
        watchTab(sender);
        if (Object.hasOwn(patch, "rememberSession")) throw new Error("Change sign-in persistence in YT Summaro Settings.");
      }
      const update = settingsWrite.then(() => setSettings(patch));
      settingsWrite = update.catch(() => {});
      const settings = await update;
      await notifyWatchTabs("settings:changed");
      return { ok: true, settings };
    }
    case "plan:status":
      return { ok: true, ...(await getSessionStatus()) };
    case "asr:reset":
      if (sender.url !== chrome.runtime.getURL("options.html") || sender.frameId !== 0) throw new Error("Open YT Summaro Settings.");
      return planRuntime("asr-reset");
    case "plan:connect": {
      if (sender.url !== chrome.runtime.getURL("options.html") || sender.frameId !== 0) throw new Error("Open YT Summaro Settings.");
      const result = await connectPlan(message);
      await notifyWatchTabs("plan:changed");
      return { ok: true, ...result };
    }
    case "plan:disconnect": {
      if (sender.url !== chrome.runtime.getURL("options.html") || sender.frameId !== 0) throw new Error("Open YT Summaro Settings.");
      const result = await disconnectSession();
      void planRuntime("disconnect").catch(() => {});
      await notifyWatchTabs("plan:changed");
      return { ok: true, ...result };
    }
    case "summary:get": {
      if (!/^[\w-]{11}$/.test(message.videoId || "")) throw new Error("Invalid video.");
      watchTab(sender, message.videoId);
      return { ok: true, job: await readSavedSummary(message.videoId) };
    }
    case "summary:clear": {
      if (sender.url !== chrome.runtime.getURL("options.html") || sender.frameId !== 0) throw new Error("Open YT Summaro Settings.");
      return { ok: true, removed: await clearSavedSummaries() };
    }
    case "job:create": return startJob(message.input, sender);
    case "job:get":
    case "job:cancel":
      return planRuntime(message.type === "job:get" ? "get" : "cancel", {
        id: message.id,
        tabId: watchTab(sender),
        videoId: new URL(sender.url).searchParams.get("v")
      });
    case "openOptions":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default: throw new Error("Unknown extension request.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.target === "plan-runtime" || message?.type === "plan-callback") return false;
  if (message?.target === "background" && (sender.url !== runtimeUrl || sender.tab)) return false;
  const task = message?.target === "background"
    ? handleRuntimeRequest(message).then((result) => ({ ok: true, ...result }))
    : handleMessage(message, sender);
  task.then(reply, (error) => reply(errorPayload(error)));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
  void planRuntime("tab-closed", { tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, { url }) => {
  if (!url) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const videoId = parsed.origin === "https://www.youtube.com" && parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
  void planRuntime("navigation", { tabId, videoId }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/watch?")) return;
  const message = { type: "trigger" };
  try {
    await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    } catch { /* The tab may have navigated away. */ }
  }
});
