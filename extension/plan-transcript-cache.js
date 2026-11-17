const CACHE_VERSION = 2;
const STORAGE_PREFIX = "asrTranscript:";
const INDEX_KEY = "asrTranscriptIndex";
const CACHE_LIMIT = 24;
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export async function readSavedTranscript(videoId, model) {
  const key = `${STORAGE_PREFIX}${videoId}:${model}`;
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored?.version !== CACHE_VERSION || !Array.isArray(stored.segments) || !stored.segments.length) return null;
  if (!Number.isFinite(stored.createdAt) || Date.now() - stored.createdAt > CACHE_MAX_AGE) return null;
  return stored;
}

export async function saveTranscript(videoId, model, transcript) {
  const key = `${STORAGE_PREFIX}${videoId}:${model}`;
  const value = { ...transcript, videoId, model, version: CACHE_VERSION, createdAt: Date.now() };
  const stored = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY];
  const index = (Array.isArray(stored) ? stored : []).filter((item) => item?.key && item.key !== key);
  index.unshift({ key, createdAt: value.createdAt });
  await chrome.storage.local.set({ [key]: value, [INDEX_KEY]: index.slice(0, CACHE_LIMIT) });
  const drop = index.slice(CACHE_LIMIT);
  if (drop.length) await chrome.storage.local.remove(drop.map((item) => item.key));
}

export async function clearSavedTranscripts() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key === INDEX_KEY || key.startsWith(STORAGE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
