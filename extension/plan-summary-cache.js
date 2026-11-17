const keyForVideo = (videoId) => `planSummary:${videoId}`;

export async function readSavedSummary(videoId) {
  try {
    const key = keyForVideo(videoId);
    const result = (await chrome.storage.local.get(key))[key];
    return result?.meta?.videoId === videoId && result.summary?.tldr && result.provider && result.source
      ? { status: "done", stage: "done", videoId, result: { ...result, cached: true } }
      : null;
  } catch {
    return null;
  }
}

export async function saveSummary(videoId, result) {
  try {
    await chrome.storage.local.set({ [keyForVideo(videoId)]: result });
    return true;
  } catch {
    return false;
  }
}

export async function clearSavedSummaries() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith("planSummary:"));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
