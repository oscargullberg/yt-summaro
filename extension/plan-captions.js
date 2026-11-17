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
  const panelSelector = [
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
  ].join(",");
  const expanded = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const segmentSelector = "transcript-segment-view-model, ytd-transcript-segment-renderer";
  const findPanel = () => Array.from(watch?.querySelectorAll(panelSelector) || [])
    .find((panel) => panel.getAttribute("visibility") === expanded);
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

  // Use the player's own transcript UI when it offers one, including videos with the CC control disabled.
  const native = await readNativeTranscript();
  if (!onVideo()) return null;
  if (native.length) return { ...meta, visible: native };

  for (const track of candidates.slice(0, 3)) {
    try {
      const url = new URL(track.baseUrl);
      if (url.origin !== location.origin || url.pathname !== "/api/timedtext" || url.searchParams.get("v") !== videoId) continue;
      url.searchParams.set("fmt", "json3");
      const captions = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error", credentials: "same-origin" });
      if (!captions.ok) continue;
      const reader = captions.body?.getReader();
      if (!reader) continue;
      let body = "";
      let bytes = 0;
      const decode = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4_000_000) throw new Error("Caption response too large");
          body += decode.decode(value, { stream: true });
        }
        body += decode.decode();
      } finally { void reader.cancel().catch(() => {}); }
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
