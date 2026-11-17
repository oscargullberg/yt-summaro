// Executed in the YouTube tab. This function must be fully self-contained:
// chrome.scripting.executeScript serializes only the function body.
export async function readYouTubeAudio(videoId, source) {
  if (location.origin !== "https://www.youtube.com" || location.pathname !== "/watch" ||
      new URLSearchParams(location.search).get("v") !== videoId) return null;

  function safeAudioUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.port && !url.username && !url.password &&
        url.pathname === "/videoplayback" &&
        (url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"));
    } catch {
      return false;
    }
  }

  function chooseTracks(streamingData) {
    const formats = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
    const tracks = formats.filter((track) => typeof track?.url === "string" &&
      /^audio\/(?:mp4|webm)(?:;|$)/.test(track.mimeType || "") && safeAudioUrl(track.url));
    const rank = (format) => {
      const bitrate = Number(format.bitrate) || 0;
      return bitrate >= 48_000 ? bitrate - 48_000 : 200_000 + (48_000 - bitrate);
    };
    tracks.sort((a, b) => rank(a) - rank(b));
    // Keep an alternate codec available in case the CDN or decoder rejects the first track.
    const mp4 = tracks.find((track) => track.mimeType.startsWith("audio/mp4"));
    const webm = tracks.find((track) => track.mimeType.startsWith("audio/webm"));
    return [mp4, webm].filter(Boolean);
  }

  function trackResult(details, audio) {
    return {
      videoId,
      title: String(details?.title || document.title.replace(/\s*- YouTube$/, "")).slice(0, 500),
      channel: String(details?.author || "").slice(0, 200),
      duration: Number(details?.lengthSeconds) || Number(audio.approxDurationMs) / 1000 || 0,
      isLive: Boolean(details?.isLive),
      url: audio.url,
      mimeType: String(audio.mimeType || ""),
      bitrate: Number(audio.bitrate) || 0,
      contentLength: Number(audio.contentLength) || 0
    };
  }

  const player = document.getElementById("movie_player");
  let current;
  try { current = player?.getPlayerResponse?.(); } catch { /* The player may still be loading. */ }
  const responses = [current, window.ytInitialPlayerResponse].filter((item) => item?.videoDetails?.videoId === videoId);
  function resultFor(response) {
    const details = response?.videoDetails;
    if (details?.videoId !== videoId) return null;
    return {
      videoId,
      isLive: Boolean(details.isLive),
      tracks: chooseTracks(response.streamingData).map((track) => trackResult(details, track))
    };
  }

  if (source === 0) {
    for (const response of responses) {
      const result = resultFor(response);
      if (result?.isLive || result?.tracks.length) return result;
    }
    return { videoId, tracks: [] };
  }

  const visitorData = typeof window.ytcfg?.get === "function" ? window.ytcfg.get("VISITOR_DATA") : undefined;
  const clients = [
    { clientName: "ANDROID_VR", clientVersion: "1.62.27", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
    { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 35, osName: "Android", osVersion: "15" },
    { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.1.22D72" }
  ];
  const client = clients[source - 1];
  if (!client) return { videoId, tracks: [] };

  try {
    const url = new URL("/youtubei/v1/player?prettyPrint=false", location.origin);
    const response = await fetch(url, {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(4500),
      headers: { "content-type": "application/json", ...(visitorData ? { "x-goog-visitor-id": visitorData } : {}) },
      body: JSON.stringify({
        videoId,
        context: { client: { ...client, hl: document.documentElement.lang || "en", ...(visitorData ? { visitorData } : {}) }, request: { useSsl: true } }
      })
    });
    const result = response.ok ? resultFor(await response.json()) : null;
    if (new URLSearchParams(location.search).get("v") !== videoId) return null;
    return result || { videoId, tracks: [] };
  } catch {
    return { videoId, tracks: [] };
  }
}
