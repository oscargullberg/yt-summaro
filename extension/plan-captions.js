// Executed in the YouTube tab. Only caption data crosses into the extension.
export async function readYouTubeCaptions(videoId) {
  if (location.origin !== "https://www.youtube.com" || location.pathname !== "/watch" ||
      new URLSearchParams(location.search).get("v") !== videoId) return null;
  const player = document.getElementById("movie_player");
  let current;
  try { current = player?.getPlayerResponse?.(); } catch { /* Player may still be loading. */ }
  const response = [current, window.ytInitialPlayerResponse].find((item) => item?.videoDetails?.videoId === videoId);
  const details = response?.videoDetails;
  const title = String(details?.title || document.title.replace(/\s*- YouTube$/, "")).slice(0, 500);
  const onVideo = () => new URLSearchParams(location.search).get("v") === videoId;
  const watch = document.querySelector("ytd-watch-flexy");
  const ownsWatch = () => onVideo() && watch?.isConnected && watch.getAttribute("video-id") === videoId;

  async function readBody(result) {
    if (!result.ok || Number(result.headers.get("content-length")) > 4_000_000) throw new Error("Unreadable caption response");
    const reader = result.body?.getReader();
    if (!reader) throw new Error("Empty caption response");
    const decode = new TextDecoder();
    let body = "", bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4_000_000) throw new Error("Caption response too large");
        body += decode.decode(value, { stream: true });
      }
      return body + decode.decode();
    } finally { void reader.cancel().catch(() => {}); }
  }

  function* objects(root) {
    const pending = [root], seen = new WeakSet();
    for (let i = 0; i < pending.length; i++) {
      if (i >= 100_000) throw new Error("Transcript data too complex");
      const node = pending[i];
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      yield node;
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") pending.push(value);
      }
    }
  }

  function transcriptParams(data) {
    // Search only the current video's panels, never commands for recommended videos.
    for (const node of objects(data?.engagementPanels)) {
      const params = node.getTranscriptEndpoint?.params;
      if (typeof params === "string" && params.length > 0 && params.length <= 16_384) return params;
    }
    return null;
  }

  function structuredBody(data) {
    if (data?.error) return null;
    const events = [], seen = new Set();
    const textOf = (value) => typeof value === "string" ? value :
      typeof value?.simpleText === "string" ? value.simpleText :
      typeof value?.content === "string" ? value.content :
      Array.isArray(value?.runs) ? value.runs.map((run) => typeof run?.text === "string" ? run.text : "").join("") : "";
    for (const node of objects(data)) {
      const list = node.transcriptSegmentListRenderer;
      // A paginated response must not become a successful but incomplete transcript.
      if (list?.continuations?.length || list?.initialSegments?.some((item) => item?.continuationItemRenderer)) return null;
      const segment = node.transcriptSegmentRenderer || node.transcriptSegmentViewModel;
      if (!segment || !/^(?:\d+)(?:\.\d+)?$/.test(String(segment.startMs ?? ""))) continue;
      const start = Number(segment.startMs);
      const text = textOf(segment.snippet || segment.text).replace(/\s+/g, " ").trim().slice(0, 2000);
      if (!Number.isFinite(start) || !text) continue;
      const key = `${start}\n${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ tStartMs: start, segs: [{ utf8: text }] });
      if (events.length > 20_000) throw new Error("Too many transcript segments");
    }
    if (!events.length) return null;
    const body = JSON.stringify({ events });
    if (body.length > 4_000_000) throw new Error("Transcript response too large");
    return body;
  }

  async function readStructuredTranscript() {
    try {
      if (!ownsWatch()) return null;
      const config = (name) => typeof window.ytcfg?.get === "function" ? window.ytcfg.get(name) : undefined;
      const context = config("INNERTUBE_CONTEXT");
      if (!context?.client?.clientVersion || !context.client.clientName) return null;
      // Share one deadline across discovery and retrieval; never invent client versions or params.
      const signal = AbortSignal.timeout(5000);
      const post = async (endpoint, fields) => {
        if (!ownsWatch()) throw new Error("Video changed");
        const url = new URL(`/youtubei/v1/${endpoint}?prettyPrint=false`, location.origin);
        const apiKey = config("INNERTUBE_API_KEY");
        if (typeof apiKey === "string" && apiKey.length <= 256) url.searchParams.set("key", apiKey);
        const result = await fetch(url, {
          method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, ...fields })
        });
        const body = await readBody(result);
        if (!ownsWatch()) throw new Error("Video changed");
        return JSON.parse(body.replace(/^\)\]\}'\s*/, ""));
      };
      const currentId = (data) => data?.currentVideoEndpoint?.watchEndpoint?.videoId;
      // ytInitialData can still describe the previous video after YouTube SPA navigation.
      let data = [watch.data, window.ytInitialData].find((item) => currentId(item) === videoId);
      if (!data) data = await post("next", { videoId });
      if (currentId(data) && currentId(data) !== videoId) return null;
      const params = transcriptParams(data);
      if (!params) return null;
      const transcript = await post("get_transcript", { params });
      if (currentId(transcript) && currentId(transcript) !== videoId) return null;
      return structuredBody(transcript);
    } catch { return null; /* The native panel can succeed when a direct request is rejected. */ }
  }

  const transcriptTargets = ["PAmodern_transcript_view", "engagement-panel-searchable-transcript"];
  const expanded = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const segmentSelector = "transcript-segment-view-model, ytd-transcript-segment-renderer";
  // YouTube also puts the transcript target on a nested renderer, leaving the panel unlabelled.
  const transcriptContentSelector = transcriptTargets.map((target) => `[data-target-id="${target}"]`).join(", ");
  const findPanel = () => Array.from(watch?.querySelectorAll("ytd-engagement-panel-section-list-renderer") || [])
    .find((panel) => panel.getAttribute("visibility") === expanded && (
      transcriptTargets.includes(panel.getAttribute("target-id")) ||
      panel.querySelector(transcriptContentSelector) || panel.querySelector(segmentSelector)
    ));
  const readPanel = (panel) => {
    if (!panel || !ownsWatch()) return [];
    return Array.from(panel.querySelectorAll(segmentSelector)).slice(0, 20_000).map((node) => ({
      timestamp: String(node.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp")?.textContent || "").trim().slice(0, 16),
      text: String(node.querySelector("span[role='text'], .segment-text")?.textContent || "").trim().slice(0, 2000)
    })).filter((cue) => cue.timestamp && cue.text);
  };

  async function readNativeTranscript() {
    if (!ownsWatch()) return [];
    const existing = findPanel();
    const loaded = readPanel(existing);
    if (loaded.length) return loaded;

    const description = watch.querySelector("ytd-watch-metadata ytd-text-inline-expander");
    const findOpener = () => watch.querySelector("ytd-video-description-transcript-section-renderer button");
    let didExpand = false;
    let didOpen = false;
    try {
      if (!existing) {
        if (description && !description.hasAttribute("is-expanded")) {
          const expand = description.querySelector("#expand");
          if (expand && (findOpener() || !description.querySelector("ytd-structured-description-content-renderer"))) {
            expand.click();
            didExpand = true;
          }
        }

        const deadline = performance.now() + 700;
        while (ownsWatch() && !findOpener() && didExpand && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const opener = findOpener();
        if (!ownsWatch() || !opener || opener.disabled || opener.getAttribute("aria-disabled") === "true") return [];
        opener.click();
        didOpen = true;
      }
      const deadline = performance.now() + 8000;
      while (ownsWatch()) {
        const panel = findPanel();
        const cues = readPanel(panel);
        if (cues.length || performance.now() >= deadline || panel?.querySelector("ytd-message-renderer, yt-message-view-model")) return cues;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return [];
    } finally {
      if (ownsWatch()) {
        const panel = didOpen ? findPanel() : null;
        panel?.querySelector("ytd-engagement-panel-title-header-renderer #visibility-button button, button[aria-label='Close']")?.click();
        if (didExpand) description.querySelector("#collapse")?.click();
      }
    }
  }
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const candidates = Array.isArray(tracks) ? tracks.filter((track) => typeof track?.baseUrl === "string") : [];
  candidates.sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
  const meta = { videoId, title, channel: String(details?.author || "").slice(0, 200), duration: Number(details?.lengthSeconds) || 0, isLive: Boolean(details?.isLive) };

  const structured = await readStructuredTranscript();
  if (!onVideo()) return null;
  if (structured) return { ...meta, body: structured };

  // Use the player's own transcript UI when it offers one, including videos with the CC control disabled.
  const native = await readNativeTranscript().catch(() => []);
  if (!onVideo()) return null;
  if (native.length) return { ...meta, visible: native };

  for (const track of candidates.slice(0, 3)) {
    try {
      const url = new URL(track.baseUrl);
      if (url.origin !== location.origin || url.pathname !== "/api/timedtext" || url.searchParams.get("v") !== videoId) continue;
      url.searchParams.set("fmt", "json3");
      const captions = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error", credentials: "same-origin" });
      const body = await readBody(captions);
      if (!/^\s*(?:\{|<\?xml|<transcript|<timedtext)/i.test(body)) continue;
      if (body.trimStart().startsWith("{") && !JSON.parse(body)?.events?.some((event) => event?.segs?.some((segment) => segment?.utf8?.trim()))) continue;
      if (!onVideo()) return null;
      return { ...meta, body, lang: String(track.languageCode || "").slice(0, 32), auto: track.kind === "asr" };
    } catch { /* Try another caption track. */ }
  }
  return onVideo() ? { ...meta, visible: [] } : null;
}

export function captionSegments(data) {
  let cues;
  if (!data) return [];
  if (Array.isArray(data.visible)) {
    cues = data.visible.map(({ timestamp, text }) => ({
      seconds: /^\d{1,3}:(?:\d\d:)?\d\d$/.test(timestamp) ? timestamp.split(":").reduce((time, part) => time * 60 + Number(part), 0) : NaN,
      text
    }));
  } else if (data.body?.trimStart().startsWith("{")) {
    let events;
    try { events = JSON.parse(data.body)?.events; } catch { return []; }
    cues = (Array.isArray(events) ? events : []).map((event) => ({
      seconds: Number(event?.tStartMs) / 1000,
      text: Array.isArray(event?.segs) ? event.segs.map((segment) => segment?.utf8 || "").join("") : ""
    }));
  } else if (data.body) {
    const xml = new DOMParser().parseFromString(data.body, "application/xml");
    cues = Array.from(xml.querySelectorAll("text[start], p[t]")).map((node) => ({
      seconds: node.hasAttribute("start") ? Number(node.getAttribute("start")) : Number(node.getAttribute("t")) / 1000,
      text: node.textContent
    }));
  } else return [];

  const blocks = [];
  let previous = "";
  for (const cue of cues.sort((a, b) => a.seconds - b.seconds)) {
    const text = typeof cue.text === "string" ? cue.text.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
    if (!Number.isFinite(cue.seconds) || cue.seconds < 0 || !text || text === previous) continue;
    const last = blocks.at(-1);
    if (last && cue.seconds - last.seconds < 18 && last.text.length + text.length < 380) last.text += ` ${text}`;
    else blocks.push({ id: blocks.length + 1, seconds: cue.seconds, text });
    previous = text;
  }
  return blocks;
}
