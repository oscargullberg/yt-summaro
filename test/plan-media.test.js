import { expect, test } from "bun:test";
import { downloadTrack } from "../extension/plan-download.js";
import { recordWatchAudio } from "../extension/plan-capture.js";

const url = "https://r1.googlevideo.com/videoplayback";

test("retries a truncated range and advances only after the complete body", async () => {
  const track = { url, contentLength: 5 };
  const calls = [];
  const progress = [];
  const fetcher = async (_, { headers }) => {
    calls.push(headers.range);
    if (calls.length === 1) return new Response("a", { status: 206, headers: { "content-range": "bytes 0-1/5" } });
    if (calls.length === 2) return new Response("ab", { status: 206, headers: { "content-range": "bytes 0-1/5" } });
    return new Response("cde", { status: 206, headers: { "content-range": "bytes 2-4/5" } });
  };

  const result = await downloadTrack(track, new AbortController().signal, (value) => progress.push(value), fetcher);
  expect(new TextDecoder().decode(result.bytes)).toBe("abcde");
  expect(calls).toEqual(["bytes=0-4", "bytes=0-4", "bytes=2-4"]);
  expect(progress).toEqual([0.4, 1]);
});

test("accepts complete responses and rejects invalid hosts, statuses and ranges", async () => {
  const { signal } = new AbortController();
  const ok = () => new Response("abc");
  expect((await downloadTrack({ url, contentLength: 3 }, signal, null, ok)).bytes.byteLength).toBe(3);
  await expect(downloadTrack({ url: "https://example.com/videoplayback" }, signal, null, ok))
    .rejects.toMatchObject({ code: "AUDIO_UNAVAILABLE" });
  await expect(downloadTrack({ url }, signal, null, () => new Response(null, { status: 403 })))
    .rejects.toMatchObject({ code: "AUDIO_EXPIRED" });
  await expect(downloadTrack({ url }, signal, null, () =>
    new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } })))
    .rejects.toMatchObject({ code: "AUDIO_FETCH" });
});

test("restores playback if Chrome refuses tab capture after seeking", async () => {
  const commands = [];
  const request = async (kind, { command }) => {
    if (kind === "capture-token") throw new Error("Chrome refused capture");
    commands.push(command);
    return { result: { ok: true, duration: 12, ready: true } };
  };

  await expect(recordWatchAudio({ request, signal: new AbortController().signal, onStage() {} }))
    .rejects.toMatchObject({ code: "AUDIO_CAPTURE_PLAYBACK" });
  expect(commands).toEqual(["inspect", "prepare", "ready", "restore"]);
});

test("waits for an ad to finish before preparing the player", async () => {
  const controller = new AbortController();
  const calls = [];
  const request = async (_, { command }) => {
    calls.push(command);
    controller.abort();
    return { result: { waiting: true, message: "Waiting for an ad" } };
  };

  await expect(recordWatchAudio({ request, signal: controller.signal, onStage() {} }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual(["inspect"]);
});

test("finishes the recording and releases the audio track and player", async () => {
  const commands = [];
  const track = new EventTarget();
  let stopped = false;
  let closed = false;
  track.stop = () => { stopped = true; };
  const browserGlobals = [
    [navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) }],
    [globalThis, "AudioContext", class {
      state = "running";
      createMediaStreamSource() { return { connect() {} }; }
      async close() { closed = true; }
    }],
    [globalThis, "MediaRecorder", class {
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable({ data: new Blob(["audio"]) });
        this.onstop();
      }
    }]
  ];
  const restore = browserGlobals.map(([host, name, value]) => {
    const old = Object.getOwnPropertyDescriptor(host, name);
    Object.defineProperty(host, name, { configurable: true, value });
    return () => old ? Object.defineProperty(host, name, old) : delete host[name];
  });
  try {
    const request = async (kind, { command }) => {
      if (kind === "capture-token") return { streamId: "test" };
      commands.push(command);
      return { result: { ok: true, ready: true, duration: 0.5, time: command === "start" ? 0 : 0.5, ended: command === "status" } };
    };
    const result = await recordWatchAudio({ request, signal: new AbortController().signal, onStage() {} });
    expect(new TextDecoder().decode(result.bytes)).toBe("audio");
    expect(commands).toEqual(["inspect", "prepare", "ready", "start", "status", "restore"]);
    expect(stopped).toBe(true);
    expect(closed).toBe(true);
  } finally {
    restore.forEach((undo) => undo());
  }
});
