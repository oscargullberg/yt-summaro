import { downloadTrack, MAX_AUDIO_SECONDS } from "./plan-download.js";
import { AsrError, mergeWhisperChunks, resolveModel } from "./plan-whisper-core.js";

const SAMPLE_RATE = 16_000;
const SLICE_SECONDS = 90;
const SLICE_OVERLAP_SECONDS = 4;

let transformersPromise;
let transcriptionQueue = Promise.resolve();
const pipelines = new Map();
const webgpuFailures = new Set();

function abortError() {
  return new DOMException("Transcription cancelled.", "AbortError");
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function loadTransformers() {
  if (!transformersPromise) {
    transformersPromise = import("./vendor/whisper.bundle.js").then((module) => {
      const { env } = module;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      // A cached WASM module is loaded through a blob: URL, which MV3 CSP blocks.
      env.useWasmCache = false;
      env.backends.onnx.wasm.wasmPaths = {
        wasm: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.wasm"),
        mjs: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.mjs")
      };
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      if (env.backends.onnx.webgpu) {
        env.backends.onnx.webgpu.powerPreference = "high-performance";
      }
      return module;
    }).catch((error) => {
      transformersPromise = undefined;
      throw new AsrError(`The local Whisper runtime could not be loaded. ${shortError(error)}`, "MODEL_LOAD");
    });
  }
  return transformersPromise;
}

async function chooseDevice() {
  if (!navigator.gpu?.requestAdapter) return "wasm";
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    return adapter?.features.has("shader-f16") ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

async function createTranscriber(model, device, onProgress) {
  const key = `${model.id}@${model.revision}:${device}`;
  const existing = pipelines.get(key);
  if (existing) return existing.promise;
  await disposePipelines();
  const entry = {};
  entry.promise = loadTransformers()
    .then(({ pipeline }) => pipeline("automatic-speech-recognition", model.id, {
      revision: model.revision,
      device,
      dtype: device === "webgpu"
        ? { encoder_model: "fp16", decoder_model_merged: "fp16" }
        : "q8",
      progress_callback: (event) => {
        if (event?.status === "progress_total" && Number.isFinite(event.progress)) {
          onProgress?.(Math.max(0, Math.min(1, event.progress / 100)));
        }
      }
    }))
    .catch((error) => {
      pipelines.delete(key);
      throw error;
    });
  pipelines.set(key, entry);
  return entry.promise;
}

async function loadTranscriber(model, onProgress) {
  const modelId = model.id;
  let device = webgpuFailures.has(modelId) ? "wasm" : await chooseDevice();
  let webgpuError;
  if (device === "webgpu") {
    try {
      const transcriber = await createTranscriber(model, "webgpu", onProgress);
      return { transcriber, device: "webgpu" };
    } catch (error) {
      webgpuError = error;
      webgpuFailures.add(modelId);
      device = "wasm";
    }
  }
  try {
    const transcriber = await createTranscriber(model, "wasm", onProgress);
    return { transcriber, device };
  } catch (error) {
    const detail = shortError(webgpuError && webgpuError !== error ? webgpuError : error);
    throw new AsrError(
      `The Whisper model could not be loaded. Check your connection and free disk space, then try again.${detail ? ` (${detail})` : ""}`,
      "MODEL_LOAD"
    );
  }
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

async function decodeMono(bytes, signal) {
  checkAborted(signal);
  let decoded;
  try {
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    decoded = await context.decodeAudioData(bytes);
  } catch {
    throw new AsrError("Chrome could not decode this video's audio. Another video may work.", "AUDIO_DECODE");
  }
  checkAborted(signal);
  if (!decoded.length) throw new AsrError("The decoded audio was empty.", "AUDIO_DECODE");
  if (decoded.duration > MAX_AUDIO_SECONDS + 5) {
    throw new AsrError("Local transcription is limited to videos up to 2 hours long.", "AUDIO_TOO_LONG");
  }
  if (decoded.sampleRate !== SAMPLE_RATE) {
    throw new AsrError("Chrome decoded the audio at an unexpected sample rate.", "AUDIO_DECODE");
  }
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);
  const channels = Math.max(1, decoded.numberOfChannels);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    for (let index = 0; index < mono.length; index++) mono[index] += samples[index] / channels;
  }
  return mono;
}

async function disposePipelines() {
  const entries = Array.from(pipelines.values());
  pipelines.clear();
  for (const entry of entries) {
    try {
      const transcriber = await entry.promise;
      await transcriber.dispose?.();
    } catch {
      // Already gone or never finished loading.
    }
  }
}

async function detectLanguage(transcriber, audio) {
  const { model, processor } = transcriber;
  const config = model.generation_config;
  const languages = Object.entries(config?.lang_to_id || {});
  if (!languages.length) return "en";

  const maxSamples = 30 * SAMPLE_RATE;
  const searchLength = Math.min(audio.length, 60 * SAMPLE_RATE);
  let firstSound = -1;
  for (let index = 0; index < searchLength; index++) {
    if (Math.abs(audio[index]) > 0.008) {
      firstSound = index;
      break;
    }
  }
  const start = firstSound >= 0 ? Math.max(0, firstSound - SAMPLE_RATE) : 0;
  const { input_features: features } = await processor(audio.subarray(start, start + maxSamples));
  let tokens;
  try {
    tokens = await model.generate({
      inputs: features,
      decoder_input_ids: [config.decoder_start_token_id],
      max_new_tokens: 1,
      num_beams: 1,
      do_sample: false,
      return_timestamps: false,
      return_dict_in_generate: false,
      suppress_tokens: null,
      begin_suppress_tokens: null,
      forced_eos_token_id: null,
      logits_processor: [(_ids, logits) => {
        const scores = logits[0].data;
        const allowed = languages.map(([, id]) => scores[id]);
        scores.fill(-Infinity);
        languages.forEach(([, id], index) => { scores[id] = allowed[index]; });
        return logits;
      }]
    });
    const id = Number(tokens.tolist()[0].at(-1));
    return languages.find(([, token]) => token === id)?.[0].slice(2, -2) || "en";
  } finally {
    features.dispose?.();
    tokens?.dispose?.();
  }
}

function enqueue(task) {
  const next = transcriptionQueue.then(task);
  transcriptionQueue = next.catch(() => {});
  return next;
}

export function resetLocalAsr(request) {
  return enqueue(async () => {
    await disposePipelines();
    webgpuFailures.clear();
    await request("clear-transcripts");
    await caches.delete("transformers-cache");
  });
}

export function transcribeAudio(options) {
  options.onStage?.("queued", "Waiting for local Whisper…");
  return enqueue(() => transcribe(options));
}

async function readDirectAudio(getAudio, signal, onStage) {
  const attempted = new Set();
  let lastError;
  for (let candidate = 0; candidate < 4; candidate++) {
    onStage?.("download", "Looking for a YouTube audio track…");
    signal.throwIfAborted();
    const data = await getAudio(candidate);
    signal.throwIfAborted();
    if (data.isLive) throw new AsrError("Live streams cannot be transcribed.", "AUDIO_LIVE");
    for (const track of data.tracks) {
      if (attempted.has(track.url)) continue;
      attempted.add(track.url);
      try {
        const { bytes, duration } = await downloadTrack(track, signal, (progress) => {
          onStage?.("download", "Downloading the audio from YouTube…", progress);
        });
        onStage?.("decode", "Decoding the audio on this device…");
        const mono = await decodeMono(bytes, signal);
        if (duration > 0 && Math.abs(mono.length / SAMPLE_RATE - duration) > Math.max(2, duration * 0.005)) {
          throw new AsrError("The downloadable audio does not cover the whole video.", "AUDIO_FETCH");
        }
        return mono;
      } catch (error) {
        signal.throwIfAborted();
        if (error.code === "AUDIO_TOO_LONG") throw error;
        lastError = error;
      }
    }
  }
  throw lastError || new AsrError("YouTube did not provide a downloadable track.", "AUDIO_UNAVAILABLE");
}

async function transcribe({ videoId, getAudio, record, preferPlayback, model: modelKey, signal, onStage, request }) {
  checkAborted(signal);
  const model = resolveModel(modelKey);
  const cache = await request("read-transcript", { videoId, model: model.key }).catch(() => null);
  const cached = cache?.transcript;
  checkAborted(signal);
  if (cached) {
    onStage?.("transcribe", "Using the saved local transcript…", 1);
    return { segments: cached.segments, model: model.key, cached: true, language: cached.language };
  }

  const startedAt = performance.now();
  let mono;
  if (!preferPlayback || !record) {
    try {
      mono = await readDirectAudio(getAudio, signal, onStage);
    } catch (error) {
      signal.throwIfAborted();
      if (["AUDIO_LIVE", "AUDIO_TOO_LONG", "INVALID_VIDEO_TAB"].includes(error.code)) throw error;
      if (!record) {
        throw new AsrError("YouTube did not provide a readable transcript or downloadable audio.", "AUDIO_CAPTURE_REQUIRED");
      }
    }
  }
  if (!mono) {
    const { bytes, duration, leadIn } = await record();
    onStage?.("decode", "Decoding the recorded audio…");
    const decoded = await decodeMono(bytes, signal);
    if (decoded.length / SAMPLE_RATE < duration + leadIn - 0.8) {
      throw new AsrError("The recording ended before the video finished.", "AUDIO_CAPTURE_PLAYBACK");
    }
    mono = decoded.subarray(Math.round(leadIn * SAMPLE_RATE), Math.round((leadIn + duration) * SAMPLE_RATE));
  }

  const duration = mono.length / SAMPLE_RATE;
  if (duration > MAX_AUDIO_SECONDS + 1) throw new AsrError("Local transcription supports videos up to 2 hours.", "AUDIO_TOO_LONG");
  checkAborted(signal);
  onStage?.("model", `Loading ${model.label}…`, 0);
  const loaded = await loadTranscriber(model, (progress) => {
    onStage?.("model", `Loading ${model.label}…`, progress);
  });
  let { transcriber, device } = loaded;
  onStage?.("model", `Loading ${model.label}${deviceLabel(device)}…`, 1);
  checkAborted(signal);

  onStage?.("transcribe", `Transcribing locally with ${model.label}…`, 0);
  const raw = [];
  let language;
  const step = SLICE_SECONDS - SLICE_OVERLAP_SECONDS;
  for (let start = 0; start < duration; start += step) {
    checkAborted(signal);
    const end = Math.min(duration, start + SLICE_SECONDS);
    const slice = mono.subarray(Math.round(start * SAMPLE_RATE), Math.round(end * SAMPLE_RATE));
    if (!slice.some((sample) => Math.abs(sample) > 0.001)) {
      onStage?.("transcribe", `Transcribing locally with ${model.label}…`, end / duration);
      if (end >= duration) break;
      continue;
    }
    const options = { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 };
    let output;
    try {
      try {
        language ||= await detectLanguage(transcriber, mono.subarray(Math.round(start * SAMPLE_RATE)));
        checkAborted(signal);
        output = await transcriber(slice, { ...options, language });
      } catch (error) {
        checkAborted(signal);
        if (device !== "webgpu") throw error;
        webgpuFailures.add(model.id);
        onStage?.("model", "Switching Whisper to WebAssembly…");
        transcriber = await createTranscriber(model, "wasm");
        device = "wasm";
        checkAborted(signal);
        language ||= await detectLanguage(transcriber, mono.subarray(Math.round(start * SAMPLE_RATE)));
        checkAborted(signal);
        output = await transcriber(slice, { ...options, language });
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new AsrError(`Whisper could not transcribe this audio. ${shortError(error)}`, "TRANSCRIBE_FAILED");
    }
    checkAborted(signal);
    const pieces = Array.isArray(output?.chunks) && output.chunks.length
      ? output.chunks
      : [{ timestamp: [0, end - start], text: output?.text || "" }];
    for (const piece of pieces) {
      let [from, to] = Array.isArray(piece?.timestamp) ? piece.timestamp : [0, undefined];
      from = Number(from);
      to = Number(to);
      if (!Number.isFinite(from) || from < 0) from = 0;
      if (!Number.isFinite(to) || to <= from) to = Math.min(end - start, from + 30);
      raw.push({
        start: start + Math.min(from, end - start),
        end: start + Math.min(to, end - start),
        text: piece?.text
      });
    }
    onStage?.("transcribe", `Transcribing locally with ${model.label}…`, Math.min(1, end / duration));
    if (end >= duration) break;
  }

  const segments = mergeWhisperChunks(raw);
  if (!segments.length) {
    throw new AsrError("No speech was detected in this video's audio.", "NO_SPEECH");
  }
  onStage?.("transcribe", "Saving the local transcript…", 1);
  checkAborted(signal);
  await request("save-transcript", {
    videoId,
    model: model.key,
    transcript: { segments, device, duration, language, elapsedSeconds: Math.round((performance.now() - startedAt) / 1000) }
  }).catch(() => {});
  return { segments, model: model.key, device, cached: false, duration, language };
}

function deviceLabel(device) {
  return device === "webgpu" ? " with WebGPU" : " with WebAssembly";
}
