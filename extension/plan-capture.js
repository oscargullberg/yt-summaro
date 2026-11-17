import { AsrError } from "./plan-whisper-core.js";
import { MAX_AUDIO_SECONDS } from "./plan-download.js";

const MAX_BYTES = 128 * 1024 * 1024;

export async function recordWatchAudio({ request, videoId, tabId, signal, onStage }) {
  const captureId = crypto.randomUUID();
  const playback = async (command) => (await request("playback", { command, tabId, videoId, captureId })).result;
  const playbackError = (message) => new AsrError(message || "The video player is unavailable.", "AUDIO_CAPTURE_PLAYBACK");

  async function waitFor(operation, timeout, message, discard) {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    let stop;
    const interrupted = new Promise((_, reject) => {
      stop = () => reject(signal.aborted ? signal.reason : playbackError(message));
      if (limit.aborted) stop();
      else limit.addEventListener("abort", stop, { once: true });
    });
    const result = operation.then((value) => {
      if (limit.aborted) discard?.(value);
      return value;
    });
    try {
      return await Promise.race([interrupted, result]);
    } finally {
      limit.removeEventListener("abort", stop);
    }
  }

  async function waitForPlayback(command, timeout) {
    const deadline = performance.now() + timeout;
    while (true) {
      signal.throwIfAborted();
      const state = await waitFor(playback(command), 4000, "YouTube’s player stopped responding.");
      if (state?.ok && (command === "inspect" || state.ready)) return state;
      if ((!state?.ok && !state?.waiting) || performance.now() >= deadline) {
        throw playbackError(state?.message || "The start of the video did not buffer.");
      }
      onStage?.("capture", state?.message || "Waiting for the start of the video to buffer…");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  let stream, context, recorder, poll, preparedPlayback;
  const chunks = [];
  let size = 0;
  let fail;
  const abort = () => fail?.(signal.reason);
  signal.addEventListener("abort", abort, { once: true });

  try {
    const initial = await waitForPlayback("inspect", 15_000);
    if (initial.duration > MAX_AUDIO_SECONDS) throw new AsrError("Local transcription supports videos up to 2 hours.", "AUDIO_TOO_LONG");
    preparedPlayback = true;
    const prepared = await waitFor(playback("prepare"), 4000, "YouTube’s player did not respond to the seek.");
    if (!prepared?.ok) throw playbackError(prepared?.message);
    await waitForPlayback("ready", 10_000);
    const { streamId } = await waitFor(
      request("capture-token", { tabId, videoId }), 4000, "Chrome did not authorize tab audio capture."
    );
    signal.throwIfAborted();
    const media = navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false
    });
    stream = await waitFor(media, 5000, "Chrome did not start sharing tab audio.", (lateStream) => {
      lateStream.getTracks().forEach((track) => track.stop());
    });
    signal.throwIfAborted();
    context = new AudioContext();
    context.createMediaStreamSource(stream).connect(context.destination);
    if (context.state === "suspended") {
      // Audio routing is independent of capture. The recorder can still run if autoplay blocks monitoring.
      void context.resume().catch(() => {});
    }
    signal.throwIfAborted();

    recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64_000 });
    const recorded = new Promise((resolve, reject) => {
      fail = reject;
      recorder.ondataavailable = ({ data }) => {
        size += data.size;
        if (size > MAX_BYTES) reject(new AsrError("The recording exceeded the audio size limit.", "AUDIO_TOO_LARGE"));
        else if (data.size) chunks.push(data);
      };
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.onerror = () => reject(new AsrError("Chrome stopped recording tab audio.", "AUDIO_CAPTURE_PLAYBACK"));
      stream.getAudioTracks()[0].addEventListener("ended", () => reject(new AsrError("Chrome stopped sharing tab audio.", "AUDIO_CAPTURE_PLAYBACK")), { once: true });
    });
    void recorded.catch(() => {});

    onStage("capture", "Recording this tab at normal playback speed…", 0);
    const recordedAt = performance.now();
    recorder.start(1000);
    const start = await waitFor(
      Promise.race([playback("start"), recorded.then(() => undefined)]),
      4000, "YouTube did not start playing. Let the video buffer and try again."
    );
    if (!start?.ok) throw new AsrError(start?.message || "Chrome could not start playback.", "AUDIO_CAPTURE_PLAYBACK");
    const now = performance.now();
    const leadIn = Math.max(0, (now - recordedAt) / 1000 - start.time);
    if (!Number.isFinite(leadIn) || leadIn > 3) throw playbackError("Playback took too long to start recording. Try again after the video buffers.");
    const startedAt = recordedAt + leadIn * 1000;
    let lastTime = start.time;
    let lastProgressAt = now;
    async function checkPlayback() {
      try {
        const state = await waitFor(playback("status"), 3500, "YouTube’s player stopped responding during capture.");
        if (recorder.state !== "recording") return;
        if (!state?.ok) throw new AsrError(state?.message || "Playback changed while recording.", "AUDIO_CAPTURE_PLAYBACK");
        const now = performance.now();
        // Audio samples are timestamped against wall time. Fail instead of indexing a stalled recording incorrectly.
        if (state.time > lastTime) lastProgressAt = now;
        if (now - startedAt > (MAX_AUDIO_SECONDS + 15) * 1000 || now - lastProgressAt > 3000 || Math.abs((now - startedAt) / 1000 - state.time) > 3) {
          throw new AsrError("Playback stalled during recording. Let the video buffer and try again.", "AUDIO_CAPTURE_PLAYBACK");
        }
        lastTime = state.time;
        onStage("capture", "Recording this tab at normal playback speed…", state.time / initial.duration);
        if (state.ended) recorder.stop();
        else poll = setTimeout(checkPlayback, 500);
      } catch (error) { fail(error); }
    }
    poll = setTimeout(checkPlayback, 500);
    const blob = await recorded;
    signal.throwIfAborted();
    if (!blob.size) throw new AsrError("Chrome captured no audio from the tab.", "AUDIO_CAPTURE_PLAYBACK");
    return { bytes: await blob.arrayBuffer(), duration: initial.duration, leadIn };
  } catch (error) {
    if (signal.aborted || error instanceof AsrError) throw error;
    throw new AsrError("Chrome could not capture the tab audio. Keep this video active and try again from the toolbar.", "AUDIO_CAPTURE_PLAYBACK");
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(poll);
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => {});
    if (preparedPlayback) void playback("restore").catch(() => {});
  }
}
