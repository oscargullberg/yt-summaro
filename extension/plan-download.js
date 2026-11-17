import { AsrError } from "./plan-whisper-core.js";

const FIRST_RANGE = 256 * 1024;
const RANGE_BYTES = 1024 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_RANGES = 1024;
export const MAX_AUDIO_SECONDS = 2 * 60 * 60;

function trackInfo(track) {
  let url;
  try { url = new URL(track.url); } catch {
    throw new AsrError("The video's audio URL is invalid.", "AUDIO_UNAVAILABLE");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/videoplayback" ||
      !(url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"))) {
    throw new AsrError("The video's audio URL is not a supported YouTube media endpoint.", "AUDIO_UNAVAILABLE");
  }
  const duration = Number(track.duration) || 0;
  if (duration > MAX_AUDIO_SECONDS) {
    throw new AsrError("Local transcription is limited to videos up to 2 hours.", "AUDIO_TOO_LONG");
  }
  const length = Number(track.contentLength);
  if (length > MAX_BYTES) throw new AsrError("The audio exceeds the browser's download limit.", "AUDIO_TOO_LARGE");
  return { url, duration, length: Number.isSafeInteger(length) && length > 0 ? length : 0 };
}

async function readRange(response, start, end, expectedTotal) {
  const header = response.headers.get("content-range");
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header || "");
  const full = response.status === 200 && header === null;
  const rangeEnd = Number(range?.[2]);
  const rangeTotal = Number(range?.[3]) || 0;
  const total = expectedTotal || rangeTotal;
  const bytes = full ? (total || MAX_BYTES) : rangeEnd - start + 1;
  let reader;

  try {
    if (response.status === 403 || response.status === 410) {
      throw new AsrError("YouTube refused this audio URL.", "AUDIO_EXPIRED");
    }
    if (!response.ok) {
      const error = new AsrError(`YouTube returned HTTP ${response.status} for this audio track.`, "AUDIO_FETCH");
      error.retryable = response.status >= 500 && response.status <= 599;
      throw error;
    }
    if (!full && (!range || Number(range[1]) !== start || rangeEnd < start || rangeEnd > end ||
        (total && (rangeEnd >= total || (rangeTotal && rangeTotal !== total))))) {
      throw new AsrError("YouTube returned an unexpected audio byte range.", "AUDIO_FETCH");
    }
    if (total > MAX_BYTES || Number(response.headers.get("content-length")) > bytes) {
      throw new AsrError("The audio exceeds the browser's download limit.", "AUDIO_TOO_LARGE");
    }
    reader = response.body?.getReader();
    if (!reader) throw new AsrError("YouTube returned an empty audio stream.", "AUDIO_FETCH");
    const parts = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > bytes) throw new AsrError("The audio response exceeded its advertised size.", "AUDIO_TOO_LARGE");
      parts.push(value);
    }
    if (!received || ((!full || total) && received !== bytes)) {
      const error = new AsrError("The audio download ended before the whole track arrived.", "AUDIO_FETCH");
      error.retryable = true;
      throw error;
    }
    return { parts, received, total: full ? received : total, full };
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      await response.body?.cancel().catch(() => {});
    }
  }
}

async function fetchRange(url, start, end, total, signal, fetcher) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(url, {
        headers: { range: `bytes=${start}-${end}` },
        redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      });
      return await readRange(response, start, end, total);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AsrError && (!error.retryable || attempt)) throw error;
      if (attempt) throw new AsrError("The audio download stalled.", "AUDIO_FETCH");
    }
  }
}

export async function downloadTrack(track, signal, onProgress, fetcher = fetch) {
  const { url, duration, length } = trackInfo(track);
  let total = length;
  let offset = 0;
  let parts = [];
  let ranges = 0;
  do {
    if (++ranges > MAX_RANGES) throw new AsrError("YouTube returned too many small ranges for this track.", "AUDIO_FETCH");
    const size = offset ? RANGE_BYTES : FIRST_RANGE;
    const end = Math.min(offset + size, total || MAX_BYTES) - 1;
    if (end < offset) throw new AsrError("The audio exceeds the browser's download limit.", "AUDIO_TOO_LARGE");
    const range = await fetchRange(url, offset, end, total, signal, fetcher);
    if (range.full) {
      parts = range.parts;
      offset = range.received;
    } else {
      for (const part of range.parts) parts.push(part);
      offset += range.received;
    }
    total = range.total;
    onProgress?.(total ? offset / total : undefined);
  } while (offset !== total);

  return { bytes: await new Blob(parts).arrayBuffer(), duration };
}
