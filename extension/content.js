(() => {
  if (location.hostname !== "www.youtube.com") return;
  if (window.__ytsSummaroLoaded) return;
  window.__ytsSummaroLoaded = true;

  const CARD_ID = "yts-summaro-card";
  const STYLES = {
    brief: "Brief",
    standard: "Standard",
    detailed: "Detailed"
  };
  const LANGUAGES = {
    en: "English",
    auto: "Video language",
    system: "Browser language"
  };
  const FALLBACK_SETTINGS = {
    style: "standard",
    language: "en",
    localAsr: { enabled: true, model: "base" },
    models: { chatgpt: "" }
  };

  const SPARKLE_PATH =
    "M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2zm6.2 12.2l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.4z";
  const CHECK_PATH = "M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.4-1.4z";
  const ERROR_PATH =
    "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z";

  const state = {
    settings: null,
    plan: null,
    videoId: null,
    job: null,
    jobId: null,
    result: null,
    seq: 0,
    busy: false,
    planCheckedAt: 0,
    planRequestId: 0,
    refs: null
  };

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }

  function scrollToNode(node) {
    node?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgIcon(pathData, size = 18) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function option(value, label, selected) {
    const node = el("option", null, label);
    node.value = value;
    if (selected) node.selected = true;
    return node;
  }

  function select(className, label, entries) {
    const node = el("select", `yts-select ${className}`);
    node.setAttribute("aria-label", label);
    for (const [value, text] of Object.entries(entries)) node.append(option(value, text));
    return node;
  }

  function actionButton(label, className, onClick) {
    const button = el("button", `yts-btn ${className || ""}`.trim(), label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  async function send(type, payload) {
    if (!chrome.runtime || !chrome.runtime.id) {
      throw Object.assign(new Error("The extension was reloaded. Reload this YouTube tab."), {
        code: "EXTENSION_CONTEXT"
      });
    }
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    } catch (error) {
      throw Object.assign(
        new Error(
          /context invalidated/i.test(String(error && error.message))
            ? "The extension was reloaded. Reload this YouTube tab."
            : "The extension background worker is not responding."
        ),
        { code: "EXTENSION_CONTEXT", detail: String(error && error.message) }
      );
    }
    if (!response) {
      throw Object.assign(new Error("The extension background worker did not respond."), {
        code: "EXTENSION_CONTEXT"
      });
    }
    if (!response.ok) {
      const info = response.error || {};
      throw Object.assign(new Error(info.message || "Request failed."), info);
    }
    return response;
  }

  async function loadSettings() {
    try {
      const response = await send("settings:get");
      state.settings = response.settings;
    } catch {
      if (!state.settings) state.settings = structuredClone(FALLBACK_SETTINGS);
    }
    return state.settings;
  }

  async function saveSettings(patch) {
    const response = await send("settings:set", { patch });
    state.settings = response.settings;
    updateFooter();
    return state.settings;
  }

  function getVideoId() {
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return null;
    }
    if (url.pathname !== "/watch") return null;
    const id = url.searchParams.get("v") || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function isLive() {
    const flexy = document.querySelector("ytd-watch-flexy");
    if (flexy && flexy.hasAttribute("is-live")) return true;
    const badge = document.querySelector(".ytp-live-badge");
    if (badge) {
      const style = getComputedStyle(badge);
      if (style.display !== "none" && style.visibility !== "hidden" && badge.getClientRects().length) {
        return true;
      }
    }
    const video = document.querySelector("video");
    if (video && video.duration === Infinity) return true;
    return false;
  }

  function cleanupDom() {
    document.getElementById(CARD_ID)?.remove();
    for (const node of document.querySelectorAll(".yts-pill")) node.remove();
    state.refs = null;
  }

  function resetForVideo(videoId) {
    state.seq++;
    activePlayback?.watch.abort();
    activePlayback = undefined;
    state.videoId = videoId;
    state.job = null;
    state.jobId = null;
    state.result = null;
    state.busy = false;
    cleanupDom();
  }

  function setBusy(busy) {
    state.busy = busy;
    const refs = state.refs;
    if (!refs) return;
    refs.card.setAttribute("aria-busy", busy ? "true" : "false");
    for (const control of [refs.model, refs.style, refs.language]) {
      control.disabled = busy;
    }
    refs.go.hidden = busy;
    refs.cancel.hidden = !busy;
    refs.cancel.disabled = !state.jobId;
  }

  function setStatus(kind, message, options = {}) {
    const refs = state.refs;
    if (!refs) return;
    const status = refs.status;
    status.hidden = false;
    status.dataset.kind = kind;
    status.dataset.errorCode = options.errorCode || "";
    status.replaceChildren();

    if (options.spinner) {
      const spinner = el("span", "yts-spinner");
      spinner.setAttribute("aria-hidden", "true");
      status.append(spinner);
    } else if (kind === "ok") {
      status.append(svgIcon(CHECK_PATH, 17));
    } else if (kind === "error") {
      status.append(svgIcon(ERROR_PATH, 17));
    }

    const text = el("span", "yts-status-text", message);
    status.append(text);

    for (const badge of options.badges || []) {
      status.append(el("span", "yts-badge", badge));
    }

    if (options.retry) {
      const retry = actionButton("Retry connection", "yts-btn-ghost yts-small", options.retry);
      status.append(retry);
    }
  }

  function clearStatus() {
    if (!state.refs) return;
    state.refs.status.hidden = true;
    delete state.refs.status.dataset.errorCode;
    state.refs.status.replaceChildren();
  }

  function seek(seconds) {
    const video = document.querySelector("video");
    if (!video || !Number.isFinite(seconds)) return;
    const max = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.max(0, Math.min(seconds, max));
    scrollToNode(video);
    video.play().catch(() => {});
  }

  function timestampButton(timestamp, seconds) {
    const button = el("button", "yts-ts", timestamp);
    button.type = "button";
    button.title = `Jump to ${timestamp}`;
    button.setAttribute("aria-label", `Jump to ${timestamp}`);
    button.addEventListener("click", () => seek(seconds));
    return button;
  }

  function section(title) {
    const wrap = el("section", "yts-section");
    wrap.append(el("h3", "yts-section-title", title));
    return wrap;
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function createCard() {
    const card = el("section", "yts-card");
    card.id = CARD_ID;
    card.dataset.videoId = state.videoId || "";
    card.setAttribute("aria-label", "YT Summaro");

    const head = el("div", "yts-head");
    const brand = el("div", "yts-brand");
    brand.append(svgIcon(SPARKLE_PATH, 22), el("h2", "yts-title", "Summarize this video"));

    const controls = el("div", "yts-controls");
    const model = el("select", "yts-select yts-model");
    model.setAttribute("aria-label", "Model");
    const style = select("yts-style", "Summary style", STYLES);
    const language = select("yts-language", "Summary language", LANGUAGES);
    const go = actionButton("Summarize", "yts-primary", () => {
      const force = Boolean(state.result);
      void startSummarize({ force });
    });
    const cancel = actionButton("Cancel", "yts-btn-ghost yts-cancel", () => void cancelCurrent());
    cancel.hidden = true;

    controls.append(model, style, language, go, cancel);
    head.append(brand, controls);

    const status = el("div", "yts-status");
    status.hidden = true;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");

    const body = el("div", "yts-body");

    const footer = el("div", "yts-foot");
    const healthDot = el("span", "yts-dot");
    healthDot.title = "ChatGPT plan status";
    healthDot.setAttribute("aria-hidden", "true");
    const planLabel = el("span", "yts-foot-provider", "");
    const spacer = el("span", "yts-foot-spacer");
    const settingsButton = actionButton("Settings", "yts-btn-ghost yts-small", () => {
      void send("openOptions").catch(() => {});
    });
    footer.append(healthDot, planLabel, spacer, settingsButton);

    card.append(head, status, body, footer);
    state.refs = { card, model, style, language, go, cancel, status, body, healthDot, planLabel };

    model.addEventListener("change", () => {
      void saveSettings({ models: { chatgpt: model.value } }).catch((error) => {
        setStatus("error", error.message || "Could not save the model.");
      });
    });
    style.addEventListener("change", () => {
      void saveSettings({ style: style.value }).catch((error) => {
        setStatus("error", error.message || "Could not save the style.");
      });
    });
    language.addEventListener("change", () => {
      void saveSettings({ language: language.value }).catch((error) => {
        setStatus("error", error.message || "Could not save the language.");
      });
    });

    const settings = state.settings || FALLBACK_SETTINGS;
    style.value = settings.style;
    language.value = settings.language;
    populateModels();
    updateFooter();

    return card;
  }

  function populateModels() {
    const refs = state.refs;
    if (!refs) return;
    const settings = state.settings || FALLBACK_SETTINGS;
    const models = state.plan?.models || [];
    const current = settings.models?.chatgpt || "";

    refs.model.replaceChildren();
    refs.model.append(option("", "Default model", !current));
    if (current && !models.includes(current)) refs.model.append(option(current, current, true));
    for (const name of models) {
      refs.model.append(option(name, name, name === current));
    }
    refs.model.value = current;
    refs.model.disabled = state.busy || (!models.length && !current);
  }

  function updateFooter() {
    const refs = state.refs;
    if (!refs) return;
    const connected = state.plan?.connected === true;
    refs.planLabel.textContent = connected
      ? "ChatGPT plan · connected"
      : state.plan
        ? "ChatGPT plan · not connected"
        : "ChatGPT plan";
    refs.healthDot.dataset.state = state.plan ? (connected ? "ok" : "warn") : "";
    refs.healthDot.title = state.plan
      ? (connected ? "ChatGPT plan is connected" : "Connect ChatGPT in Settings")
      : "Checking the ChatGPT plan connection";
  }

  function updatePlanHint() {
    const refs = state.refs;
    if (!refs) return;
    const hint = refs.body.querySelector(".yts-connect-hint");
    if (hint) hint.hidden = state.plan?.connected !== false;
  }

  function renderIdle() {
    const refs = state.refs;
    if (!refs) return;
    setBusy(false);
    refs.go.textContent = "Summarize";
    clearStatus();
    const intro = el("div", "yts-intro");
    intro.append(el("p", null, "Uses YouTube captions when available. Whisper transcribes missing captions in Chrome. The transcript goes to ChatGPT for the summary."));
    const hint = el("p", "yts-muted yts-connect-hint", "Connect your ChatGPT plan in Settings to start summarizing.");
    hint.hidden = state.plan?.connected !== false;
    intro.append(hint);
    refs.body.replaceChildren(intro);
  }

  function renderBusy(message, progress) {
    const refs = state.refs;
    if (!refs) return;
    setBusy(true);
    refs.go.textContent = "Summarize";
    const percent = Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : "";
    const label = `${message}${percent}`;
    if (refs.status.dataset.kind === "busy" && refs.status.querySelector(".yts-status-text")?.textContent === label) return;
    setStatus("busy", label, { spinner: true });
    if (state.result) {
      refs.body.querySelector(".yts-error-box")?.remove();
      return;
    }
    if (refs.body.firstElementChild?.classList.contains("yts-skeleton")) return;
    const skeleton = el("div", "yts-skeleton");
    skeleton.setAttribute("aria-hidden", "true");
    for (const width of ["92%", "100%", "76%", "88%", "58%"]) {
      const line = el("span");
      line.style.width = width;
      skeleton.append(line);
    }
    refs.body.replaceChildren(skeleton);
  }

  function normalizeError(error) {
    if (!error) return { code: "UNKNOWN", message: "Something went wrong." };
    return {
      code: error.code || "UNKNOWN",
      message: error.message || String(error),
      detail: error.detail
    };
  }

  function renderError(error, status) {
    const refs = state.refs;
    if (!refs) return;
    const info = normalizeError(error);
    setBusy(false);
    refs.go.textContent = state.result ? "Regenerate" : "Try again";
    if (info.code === "PLAN_DISCONNECTED") {
      state.plan = { connected: false, models: [] };
      populateModels();
      refreshPlanSoon(true);
    }

    if (status === "cancelled" || info.code === "CANCELLED") {
      setStatus("warn", "Request cancelled.");
      if (state.result) return;
      const box = el("div", "yts-error-box");
      box.append(el("p", null, "You can retry whenever you’re ready."));
      const row = el("div", "yts-actions-row");
      row.append(actionButton("Retry", "yts-primary", () => void startSummarize()));
      box.append(row);
      refs.body.replaceChildren(box);
      return;
    }

    setStatus("error", info.message, { errorCode: info.code });
    refs.body.querySelector(".yts-error-box")?.remove();
    const box = el("div", "yts-error-box");

    const row = el("div", "yts-actions-row");
    if (info.code === "AUDIO_CAPTURE_REQUIRED" || info.code === "AUDIO_CAPTURE_PLAYBACK") {
      box.append(el("p", "yts-error-hint", "Click the YT Summaro icon in the Chrome toolbar to transcribe during playback. Keep the video open and let it play from the beginning."));
    }
    row.append(actionButton(info.code === "PLAN_DISCONNECTED" ? "Connect ChatGPT in Settings" : "Open settings", "yts-btn-ghost", () => void send("openOptions").catch(() => {})));
    box.append(row);

    if (info.detail) {
      const details = el("details", "yts-details");
      details.append(el("summary", null, "Technical details"));
      const pre = el("pre", null, String(info.detail).slice(0, 4000));
      details.append(pre);
      box.append(details);
    }

    if (state.result) refs.body.prepend(box);
    else refs.body.replaceChildren(box);
    updateFooter();
  }

  function renderDone(result) {
    const refs = state.refs;
    if (!refs) return;
    setBusy(false);
    refs.go.textContent = "Regenerate";
    const badges = [];
    if (result.cached) badges.push("saved");
    if (result.chunked) badges.push("long transcript");
    if (result.source?.local) badges.push("local transcript");
    if (result.saved === false) setStatus("warn", "Summary ready. Chrome couldn’t save it locally.", { badges });
    else setStatus("ok", "Summary ready", { badges });

    const body = el("div", "yts-summary");
    const summary = result.summary || {};

    if (summary.tldr) body.append(el("p", "yts-tldr", summary.tldr));

    if (Array.isArray(summary.chapters) && summary.chapters.length) {
      const chapters = section("Chapters");
      const list = el("ol", "yts-chapters");
      for (const chapter of summary.chapters) {
        const item = el("li", "yts-chapter");
        const head = el("div", "yts-chapter-head");
        head.append(timestampButton(chapter.timestamp, chapter.seconds));
        head.append(el("span", "yts-chapter-title", chapter.title || ""));
        item.append(head);
        if (chapter.summary) item.append(el("p", "yts-chapter-summary", chapter.summary));
        list.append(item);
      }
      chapters.append(list);
      body.append(chapters);
    }

    if (Array.isArray(summary.key_points) && summary.key_points.length) {
      const points = section("Key points");
      const list = el("ul", "yts-points");
      for (const point of summary.key_points) {
        const item = el("li");
        item.append(timestampButton(point.timestamp, point.seconds));
        const pointBody = el("div");
        pointBody.append(el("span", null, point.text || ""));
        if (point.sourceExcerpt) {
          const source = el("details", "yts-source-excerpt");
          source.append(el("summary", null, "Transcript excerpt"), el("p", null, point.sourceExcerpt));
          pointBody.append(source);
        }
        item.append(pointBody);
        list.append(item);
      }
      points.append(list);
      body.append(points);
    }

    if (Array.isArray(summary.quotes) && summary.quotes.length) {
      const quotes = section("Quotes");
      for (const quote of summary.quotes) {
        const block = el("blockquote", "yts-quote");
        block.append(el("p", null, quote.text || ""));
        block.append(timestampButton(quote.timestamp, quote.seconds));
        quotes.append(block);
      }
      body.append(quotes);
    }

    if (Array.isArray(summary.action_items) && summary.action_items.length) {
      const actions = section("Action items");
      const list = el("ul", "yts-actions");
      for (const action of summary.action_items) list.append(el("li", null, action));
      actions.append(list);
      body.append(actions);
    }

    if (Array.isArray(summary.topics) && summary.topics.length) {
      const topics = el("div", "yts-topics");
      for (const topic of summary.topics) topics.append(el("span", "yts-topic", topic));
      body.append(topics);
    }

    const meta = el("div", "yts-result-meta");
    meta.append(el("span", null, `${result.provider.label} · ${result.provider.model}`));
    const lang = result.source.lang ? ` (${result.source.lang})` : "";
    meta.append(el("span", null, `${result.source.label}${lang}`));
    meta.append(el("span", null, formatDate(result.generatedAt)));
    body.append(meta);

    const row = el("div", "yts-actions-row yts-result-actions");
    row.append(
      actionButton("Copy summary", "yts-btn-ghost", (event) => {
        const button = event.currentTarget;
        void (async () => {
          const ok = await copyText(summaryToText(result));
          if (ok) {
            button.textContent = "Copied";
            setTimeout(() => {
              button.textContent = "Copy summary";
            }, 1500);
          } else {
            setStatus("warn", "Could not copy to the clipboard.");
          }
        })();
      })
    );
    row.append(actionButton("Open settings", "yts-btn-ghost", () => void send("openOptions").catch(() => {})));
    body.append(row);

    refs.body.replaceChildren(body);
    updateFooter();
  }

  function summaryToText(result) {
    const summary = result.summary || {};
    const lines = [];
    const title = result.meta?.title || "YouTube video";
    lines.push(title);
    if (result.meta?.webpageUrl) lines.push(result.meta.webpageUrl);
    lines.push("");
    if (summary.tldr) lines.push(summary.tldr, "");
    if (summary.chapters?.length) {
      lines.push("Chapters");
      for (const chapter of summary.chapters) {
        lines.push(`${chapter.timestamp} — ${chapter.title}${chapter.summary ? ` — ${chapter.summary}` : ""}`);
      }
      lines.push("");
    }
    if (summary.key_points?.length) {
      lines.push("Key points");
      for (const point of summary.key_points) lines.push(`${point.timestamp} ${point.text}`);
      lines.push("");
    }
    if (summary.quotes?.length) {
      lines.push("Quotes");
      for (const quote of summary.quotes) lines.push(`${quote.timestamp} "${quote.text}"`);
      lines.push("");
    }
    if (summary.action_items?.length) {
      lines.push("Action items");
      for (const action of summary.action_items) lines.push(`- ${action}`);
      lines.push("");
    }
    if (summary.topics?.length) lines.push(`Topics: ${summary.topics.join(", ")}`);
    lines.push("");
    lines.push(`Summary by ${result.provider.label} (${result.provider.model})`);
    lines.push(`${result.source.label} · ${formatDate(result.generatedAt)}`);
    return lines.join("\n").trim();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = el("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function stageText(job) {
    if (job.stageDetail) return job.stageDetail;
    const labels = {
      queued: "Preparing the summary…",
      metadata: "Reading video metadata…",
      transcript: "Fetching captions…",
      download: "Downloading the audio from YouTube…",
      decode: "Decoding the audio on this device…",
      model: "Loading the local Whisper model…",
      transcribe: "Transcribing locally with Whisper…",
      summarize: "Summarizing…",
      done: "Done"
    };
    return labels[job.stage] || "Working…";
  }

  function handleJob(job) {
    state.job = job;
    if (!job) {
      renderIdle();
      return;
    }
    if (job.status === "done" && job.result) {
      state.result = job.result;
      renderDone(state.result);
      return;
    }
    if (job.status === "error") {
      renderError(job.error);
      return;
    }
    if (job.status === "cancelled") {
      renderError(job.error, "cancelled");
      return;
    }
    renderBusy(stageText(job), job.progress);
    if (job.stage === "save" && state.refs) state.refs.cancel.disabled = true;
  }

  async function startSummarize(options = {}) {
    if (!state.videoId || state.busy) return;
    const videoId = state.videoId;
    const seq = ++state.seq;
    setBusy(true);
    renderBusy(options.force ? "Regenerating…" : "Starting…");
    if (!state.settings) await loadSettings();
    if (seq !== state.seq) return;
    if (!state.settings) {
      renderError({ code: "EXTENSION_CONTEXT", message: "The extension is not ready. Reload this tab." });
      return;
    }

    state.job = null;
    state.jobId = null;

    try {
      const response = await send("job:create", {
        input: {
          videoId,
          style: state.refs?.style.value || state.settings.style,
          language: state.refs?.language.value || state.settings.language,
          capture: options.capture === true,
          preferPlayback: options.preferPlayback === true,
          force: Boolean(options.force)
        }
      });
      if (seq !== state.seq) return;
      const job = response.job;
      state.job = job;
      state.jobId = job.id;
      handleJob(job);
      refreshPlanSoon(true);
      if (job.status === "queued" || job.status === "running") {
        void pollJob(seq, job.id);
      }
    } catch (error) {
      if (seq !== state.seq) return;
      renderError(error);
    }
  }

  async function pollJob(seq, id) {
    let failures = 0;
    while (seq === state.seq) {
      await sleep(900);
      if (seq !== state.seq) return;
      try {
        const response = await send("job:get", { id });
        if (seq !== state.seq) return;
        failures = 0;
        const job = response.job;
        state.job = job;
        handleJob(job);
        if (job.status === "done" || job.status === "error" || job.status === "cancelled") return;
      } catch (error) {
        if (seq !== state.seq) return;
        failures++;
        if (["PLAN_JOB_GONE", "PLAN_DISCONNECTED", "INVALID_VIDEO_TAB"].includes(error.code) || failures >= 10) {
          renderError(error);
          return;
        }
        setStatus("warn", `Reconnecting to the browser summary… (${failures}/9)`);
      }
    }
  }

  async function cancelCurrent() {
    if (!state.jobId || !state.refs) return;
    const seq = ++state.seq; // Invalidate any in-flight poll before cancelling.
    const id = state.jobId;
    state.refs.cancel.disabled = true;
    setStatus("warn", "Cancelling…", { spinner: true });
    try {
      const response = await send("job:cancel", { id });
      if (seq !== state.seq) return;
      state.job = response.job;
      handleJob(response.job);
    } catch (error) {
      if (seq !== state.seq) return;
      renderError(error);
      void pollJob(seq, id);
    }
  }

  async function refreshPlan() {
    const requestId = ++state.planRequestId;
    const plan = await send("plan:status").catch(() => null);
    if (requestId !== state.planRequestId) return;
    state.plan = plan;
    populateModels();
    updateFooter();
    updatePlanHint();
    if (plan?.connected && !state.busy && state.refs?.status.dataset.errorCode === "PLAN_DISCONNECTED") {
      state.job = null;
      state.jobId = null;
      if (state.result) renderDone(state.result);
      else renderIdle();
    }
  }

  function refreshPlanSoon(force = false) {
    const now = Date.now();
    if (!force && now - state.planCheckedAt < 3000) return;
    state.planCheckedAt = now;
    void refreshPlan();
  }

  function createPill() {
    const pill = el("button", "yts-pill");
    pill.type = "button";
    pill.title = "Summarize with YT Summaro";
    pill.setAttribute("aria-label", "Summarize this video with YT Summaro");
    pill.append(svgIcon(SPARKLE_PATH, 18), el("span", null, "Summarize"));
    pill.addEventListener("click", () => {
      const card = document.getElementById(CARD_ID);
      scrollToNode(card);
      if (!state.result && (!state.job || state.job.status === "error" || state.job.status === "cancelled")) {
        void startSummarize();
      }
    });
    return pill;
  }

  async function restoreSavedSummary(videoId, seq) {
    try {
      const { job } = await send("summary:get", { videoId });
      if (job && seq === state.seq && getVideoId() === videoId) handleJob(job);
    } catch {
      // Starting a summary checks the cache again.
    }
  }

  async function ensureMounted() {
    if (!state.videoId) return;
    const videoId = state.videoId;

    let metadata = null;
    let actionBar = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (state.videoId !== videoId || videoId !== getVideoId()) return;
      metadata = document.querySelector("ytd-watch-metadata");
      actionBar = document.querySelector("#top-level-buttons-computed");
      if (metadata?.isConnected) break;
      await sleep(250);
    }
    if (!metadata?.isConnected || state.videoId !== videoId || getVideoId() !== videoId) return;

    let card = document.getElementById(CARD_ID);
    if (!card || !card.isConnected || card.dataset.videoId !== state.videoId) {
      cleanupDom();
      card = createCard();
      metadata.insertAdjacentElement("afterend", card);
      if (state.result) renderDone(state.result);
      if (state.job) handleJob(state.job);
      else if (state.busy) renderBusy("Starting…");
      else if (!state.result) {
        renderIdle();
        void restoreSavedSummary(videoId, state.seq);
      }
    }

    if (actionBar && !actionBar.querySelector(".yts-pill")) {
      actionBar.append(createPill());
    }

    refreshPlanSoon();
  }

  async function onNavigate() {
    const videoId = getVideoId();
    if (!videoId || isLive()) {
      if (state.videoId !== null) resetForVideo(null);
      else cleanupDom();
      return;
    }

    if (state.videoId !== videoId) resetForVideo(videoId);

    await ensureMounted();
  }

  let navigateTimer = null;
  function scheduleNavigate() {
    clearTimeout(navigateTimer);
    navigateTimer = setTimeout(() => void onNavigate(), 150);
  }

  document.addEventListener("yt-navigate-finish", scheduleNavigate, true);
  document.addEventListener("yt-page-data-updated", scheduleNavigate, true);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleNavigate();
    }
  }, 1000);

  let activePlayback;

  async function handlePlayback({ command, videoId, captureId }) {
    const video = document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("ytd-player video.html5-main-video") ||
      document.querySelector("#movie_player video");
    const hasAd = () => Boolean(document.querySelector("#movie_player.ad-showing"));
    const sameVideo = () => {
      const mountedId = video?.closest("ytd-watch-flexy")?.getAttribute("video-id");
      return getVideoId() === videoId && video?.isConnected && (!mountedId || mountedId === videoId);
    };
    const fail = (message) => ({ ok: false, message });
    if (command === "restore") {
      if (activePlayback?.captureId !== captureId) return { ok: true };
      const before = activePlayback;
      before.watch.abort();
      activePlayback = undefined;
      if (sameVideo() && before.video === video && !hasAd()) {
        video.currentTime = before.time;
        video.playbackRate = before.rate;
        if (before.paused) video.pause();
        else void video.play().catch(() => {});
      }
      return { ok: true };
    }
    const waiting = (message) => ({ ok: false, waiting: command === "inspect" || command === "ready", message });
    if (getVideoId() !== videoId) return fail("The watch page changed while preparing to record.");
    if (!sameVideo()) return waiting("Waiting for the YouTube player to load…");
    if (hasAd()) return waiting("Waiting for the ad to finish before recording…");
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return waiting("Waiting for the video to load. You can start playback to help it load.");
    }
    if (command === "inspect") {
      if (video.muted || video.volume === 0) return fail("Unmute the video before transcribing playback.");
      return { ok: true, duration: video.duration };
    }
    if (command === "prepare") {
      activePlayback?.watch.abort();
      const watch = new AbortController();
      activePlayback = {
        captureId, video, time: video.currentTime, rate: video.playbackRate, paused: video.paused,
        watch
      };
      video.pause();
      video.playbackRate = 1;
      video.currentTime = 0;
      return { ok: true };
    }
    if (activePlayback?.captureId !== captureId || activePlayback.video !== video) return fail("The video changed.");
    if (command === "start") {
      if (video.seeking || video.currentTime > 0.25) return fail("Wait for the beginning of the video to buffer, then try again.");
      const current = activePlayback;
      for (const event of ["seeking", "ratechange", "emptied", "volumechange"]) {
        video.addEventListener(event, () => { current.interrupted = true; }, { signal: current.watch.signal });
      }
      try { await video.play(); } catch { return fail("Chrome could not start playback."); }
      if (activePlayback !== current || current.interrupted || !sameVideo() || hasAd()) return fail("Playback changed before recording began.");
      return { ok: true, time: video.currentTime };
    }
    if (command === "ready") return { ok: true, ready: !video.seeking && video.readyState >= 2 };
    if (activePlayback.interrupted || video.seeking || video.playbackRate !== 1 || video.muted || video.volume === 0 || (video.paused && !video.ended)) {
      return fail("Playback changed while recording. Let the video play at normal speed.");
    }
    return { ok: true, time: video.currentTime, ended: video.ended };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "plan:changed") {
      if (state.videoId) refreshPlanSoon(true);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "settings:changed") {
      if (state.videoId) void refreshSettings();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "playback") {
      handlePlayback(message).then(sendResponse, () => sendResponse({ ok: false, message: "The video player is unavailable." }));
      return true;
    }
    if (message?.type === "trigger") {
      void (async () => {
        await onNavigate();
        const card = document.getElementById(CARD_ID);
        scrollToNode(card);
        const retryCapture = ["AUDIO_CAPTURE_REQUIRED", "AUDIO_CAPTURE_PLAYBACK"].includes(state.job?.error?.code);
        if (retryCapture || (!state.result && (!state.job || state.job.status === "error" || state.job.status === "cancelled"))) {
          await startSummarize({ capture: true, preferPlayback: retryCapture, force: Boolean(state.result) });
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
    return false;
  });

  async function refreshSettings() {
    await loadSettings();
    if (!state.refs) return;
    state.refs.style.value = state.settings.style;
    state.refs.language.value = state.settings.language;
    populateModels();
  }

  window.addEventListener?.("focus", () => {
    if (!state.busy) refreshPlanSoon();
  });

  void (async () => {
    await loadSettings();
    scheduleNavigate();
  })();
})();
