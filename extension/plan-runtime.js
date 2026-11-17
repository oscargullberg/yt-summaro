import { recordWatchAudio } from "./plan-capture.js";
import { PlanError, requestPlanSummary } from "./plan-auth.js";
import { captionSegments } from "./plan-captions.js";
import { makePlanPrompt, parsePlanSummary } from "./plan-summary.js";
import { resetLocalAsr, transcribeAudio } from "./plan-whisper.js";
import { AsrError } from "./plan-whisper-core.js";

const provider = { id: "chatgpt", label: "ChatGPT plan" };
const jobs = new Map();
let sessionStatus = { connected: false, models: [] };

async function request(type, fields) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...fields });
  if (!response?.ok) throw new AsrError(response?.error?.message || "The extension could not read this tab.", response?.error?.code);
  return response;
}

async function refreshSessionStatus() {
  const response = await request("session-status");
  sessionStatus = {
    connected: Boolean(response.connected),
    models: Array.isArray(response.models) ? response.models.filter((model) => typeof model === "string" && model) : []
  };
  return sessionStatus;
}

function clearSessionStatus() {
  sessionStatus = { connected: false, models: [] };
}

function cancel(entry) {
  if (entry.job.status !== "running" || entry.job.stage === "save") return;
  entry.controller.abort();
  entry.job.status = "cancelled";
  entry.job.error = { code: "CANCELLED", message: "Request cancelled.", provider: provider.id };
  entry.job.stageDetail = "";
  delete entry.job.progress;
}

function updateStage(job, controller, stage, detail, progress) {
  if (controller.signal.aborted) return;
  job.stage = stage;
  job.stageDetail = detail || "";
  if (Number.isFinite(progress)) job.progress = Math.max(0, Math.min(1, progress));
  else delete job.progress;
}

async function startJob({ tabId, input }) {
  const status = await refreshSessionStatus();
  if (!status.connected) throw new PlanError("Connect your ChatGPT plan in YT Summaro Settings first.", "PLAN_DISCONNECTED");
  for (const entry of jobs.values()) {
    if (entry.tabId !== tabId || entry.job.status !== "running") continue;
    if (entry.job.videoId === input.videoId && !input.force) return { job: entry.job };
    cancel(entry);
  }
  if (Array.from(jobs.values()).filter((entry) => entry.job.status === "running").length >= 3) {
    throw new PlanError("Wait for an active transcript or summary to finish.");
  }
  const { models } = status;
  const model = models.includes(input.model) ? input.model : models.includes("gpt-6.1-sol") ? "gpt-6.1-sol" : models[0];
  for (const [id, entry] of jobs) {
    if (entry.job.status !== "running" && (entry.tabId === tabId || jobs.size >= 30)) jobs.delete(id);
  }
  const job = {
    id: `plan:${crypto.randomUUID()}`,
    status: "running",
    stage: "transcript",
    stageDetail: "Reading YouTube captions…",
    provider: provider.id,
    videoId: input.videoId
  };
  const controller = new AbortController();
  jobs.set(job.id, { tabId, job, controller });
  void runJob({ job, controller, model, input, tabId });
  return { job };
}

async function accessToken(signal, force = false) {
  signal.throwIfAborted();
  const response = await request("access-token", { force });
  signal.throwIfAborted();
  if (typeof response.accessToken !== "string" || !response.accessToken) {
    throw new PlanError("Reconnect ChatGPT in YT Summaro Settings.", "PLAN_DISCONNECTED");
  }
  return response.accessToken;
}

async function runJob({ job, controller, model, input, tabId }) {
  const { signal } = controller;
  const { videoId } = input;
  const onStage = (stage, detail, progress) => updateStage(job, controller, stage, detail, progress);
  try {
    const { result: captions } = await request("read-source", { tabId, videoId, source: "captions" });
    signal.throwIfAborted();
    if (captions.isLive) throw new AsrError("Live streams cannot be transcribed.", "AUDIO_LIVE");
    let usedSegments = captionSegments(captions);
    const meta = {
      title: captions.title || "YouTube video",
      channel: captions.channel || "",
      videoId,
      webpageUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
    let source = { label: captions.auto ? "YouTube auto-captions" : "YouTube transcript", lang: captions.lang || "" };
    if (!usedSegments.length) {
      if (!input.asrEnabled) throw new AsrError("Enable local Whisper in Settings to transcribe videos without captions.", "NO_BROWSER_CAPTIONS");
      const transcript = await transcribeAudio({
        videoId, model: input.asrModel, signal, onStage,
        request,
        getAudio: async (candidate) => (await request("read-source", { tabId, videoId, source: "audio", candidate })).result,
        preferPlayback: input.preferPlayback,
        record: input.capture ? () => recordWatchAudio({ request, videoId, tabId, signal, onStage }) : undefined
      });
      usedSegments = transcript.segments;
      source = { label: `Local Whisper (${transcript.model})`, lang: transcript.language || "", local: true };
    }
    if (controller.signal.aborted) return;

    const prompt = makePlanPrompt(meta, usedSegments, input.style, input.language);
    if (prompt.input.length + prompt.instructions.length > 250_000) throw new PlanError("This video's transcript is too long for a browser summary.");
    updateStage(job, controller, "summarize", "Summarizing with ChatGPT…", undefined);
    let token = await accessToken(signal);
    let text;
    try {
      text = await requestPlanSummary(token, model, prompt, signal);
    } catch (error) {
      if (error?.code !== "PLAN_DISCONNECTED" || signal.aborted) throw error;
      token = await accessToken(signal, true);
      text = await requestPlanSummary(token, model, prompt, signal);
    }
    signal.throwIfAborted();
    const summary = parsePlanSummary(text, usedSegments);
    if (!summary) throw new PlanError("OpenAI did not return a readable summary. Try again.");
    const result = { summary, provider: { ...provider, model }, meta, source, generatedAt: new Date().toISOString() };
    updateStage(job, controller, "save", "Saving summary…", undefined);
    const save = await request("save-summary", { result }).catch(() => null);
    job.result = { ...result, saved: save?.saved === true };
    job.status = "done";
    job.stage = "done";
    job.stageDetail = "";
    delete job.progress;
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.code === "PLAN_DISCONNECTED") clearSessionStatus();
    job.status = "error";
    job.stageDetail = "";
    delete job.progress;
    const friendly = error instanceof PlanError || error instanceof AsrError;
    job.error = {
      code: error.code || "PLAN_REQUEST",
      message: friendly ? error.message : "The browser could not complete this request.",
      provider: provider.id
    };
  }
}

async function handle(message) {
  switch (message.type) {
    case "status": return refreshSessionStatus();
    case "disconnect": {
      for (const entry of jobs.values()) cancel(entry);
      jobs.clear();
      clearSessionStatus();
      return {};
    }
    case "start": return startJob(message);
    case "asr-reset":
      for (const entry of jobs.values()) {
        if (["queued", "download", "capture", "decode", "model", "transcribe"].includes(entry.job.stage)) cancel(entry);
      }
      await resetLocalAsr(request);
      return {};
    case "get":
    case "cancel": {
      const entry = jobs.get(message.id);
      if (!entry || entry.tabId !== message.tabId || entry.job.videoId !== message.videoId) throw new PlanError("This browser summary is no longer available.", "PLAN_JOB_GONE");
      if (message.type === "cancel") cancel(entry);
      return { job: entry.job };
    }
    case "navigation":
    case "tab-closed": {
      for (const [id, entry] of jobs) {
        if (entry.tabId !== message.tabId || entry.job.videoId === message.videoId) continue;
        cancel(entry);
        jobs.delete(id);
      }
      return {};
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "plan-runtime" || sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL("background.js"))) return false;
  handle(message).then((result) => reply({ ok: true, ...result })).catch((error) => reply({
    ok: false, error: { code: error.code || "PLAN_ERROR", message: (error instanceof PlanError || error instanceof AsrError) ? error.message : "The browser request could not complete.", provider: provider.id }
  }));
  return true;
});
