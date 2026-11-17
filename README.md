# YT Summaro

Summarize YouTube videos in desktop Chrome using your ChatGPT plan. YT Summaro uses YouTube captions when available and runs Whisper locally when they're not. No separate server or API key is required.

## Get started

Requires **Chrome 117+** on desktop.

1. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked** → `extension/`. For an existing installation, click **Reload**.
2. Open **Extension options** and select **Continue with ChatGPT**.
3. Refresh the YouTube video page and click **Summarize** below the video.

Choose a **brief**, **standard**, or **detailed** summary in English, Swedish, or the video's language. Click a timestamp in the summary to jump to that point in the video.

## When captions aren't available

YT Summaro tries YouTube captions and the open transcript panel first. If neither provides usable text, it falls back to local Whisper transcription:

- **Direct audio:** The extension downloads an available YouTube audio track and transcribes it in Chrome. The video can remain paused.
- **Tab capture:** If direct audio is unavailable, click the **YT Summaro toolbar icon** on the video tab. Let ads finish and keep the video unmuted. The extension captures audio while the video plays from the beginning at normal speed, then transcribes and summarizes it. This takes at least as long as the video. You can **Cancel**; the extension attempts to restore the previous playback position and speed.

Whisper supports regular videos up to **two hours** and detects the spoken language automatically. It uses WebGPU where available, otherwise WebAssembly. The selected model downloads from Hugging Face on first use:

- **Base:** Default model.
- **Tiny:** Lower resource use.
- **Small:** Better recognition.

Models and recent transcripts are cached in Chrome; clear them in **Settings**.

## Privacy and authentication

- **Audio stays local.** It is processed in memory in an extension-owned offscreen document and is never uploaded.
- **Summaries use OpenAI.** The transcript, video title, and channel are sent when you request a summary, with `store: false` set on the API request.
- **Sign-in uses ChatGPT OAuth.** Chrome redirects the registered loopback callback to an extension page via a tab-scoped rule. No local server or daemon is needed. Tokens are held in memory; reconnect after restarting Chrome or when the session expires.

## Limitations

- Supports regular YouTube watch pages, not Shorts or active livestreams.
- Direct audio depends on the formats YouTube exposes. Tab capture requires a playable video and runs in real time.

## Development

Load `extension/` directly in Chrome. The Whisper runtime is already bundled. To rebuild the pinned Transformers.js and ONNX Runtime Web dependencies:

```sh
node scripts/build-whisper-vendor.mjs
```

Checks:

```sh
bun test bridge/test
bun run typecheck
```

`bridge/` and `experiments/` contain earlier Bun bridge and browser experiments. The extension does not use the bridge.
