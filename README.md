# YT Summaro

Summarize YouTube videos in desktop Chrome using your ChatGPT plan. YT Summaro reuses captions when available and transcribes audio on your device with Whisper when needed. No API key, companion app, or local server required.

## Get started

1. In **Chrome 117+**, open `chrome://extensions`, enable **Developer mode**, and use **Load unpacked** to select [`extension/`](extension/).
2. Open **Extension options** and choose **Continue with ChatGPT**.
3. Open a YouTube video and click **Summarize**. Refresh any YouTube tab that was already open when you installed the extension.

Choose **Brief**, **Standard**, or **Detailed**. Summary language options are **English** (the default), **Video language**, and **Browser language**, which follows Chrome’s interface language.

Click a timestamp to seek to the cited moment. YT Summaro saves the latest successful summary for each video in your Chrome profile. Use **Regenerate** to create a fresh summary.

## When captions are missing

YT Summaro first requests structured transcript data using the current YouTube session, then tries YouTube’s transcript panel and caption tracks. With **Local Whisper** enabled, it reuses a saved transcript or tries to download the audio. The video can stay paused during a download.

If YouTube won’t serve the audio, click the **YT Summaro toolbar icon** on the video tab. Keep the video unmuted. Chrome records the tab’s audio as the video plays from the beginning at normal speed. This takes at least the video’s runtime.

Whisper supports regular videos up to two hours. It uses WebGPU when available and falls back to WebAssembly. The first transcription downloads the selected model from Hugging Face. **Base** is the default. **Tiny** uses fewer resources and **Small** favors recognition quality. YouTube Shorts and active livestreams are unsupported.

## Data and sign-in

- Audio stays in Chrome. On each new summary request, OpenAI receives the transcript, video title, and channel. The API request sets `store: false`.
- **Stay signed in on this device** is on by default. Chrome stores the encrypted refresh token and its encryption key in the same profile. Turn the setting off to keep sign-in in memory until Chrome closes. **Disconnect** clears the local session and attempts to revoke access with OpenAI.
- Use **Settings → Local storage** to clear saved summaries or the downloaded Whisper models and local transcripts.

## Development

Load `extension/` directly. After changes, click **Reload** in `chrome://extensions` and refresh YouTube.

```sh
bun install
bun run test
bun run typecheck
```

The Whisper runtime is bundled. Rebuild it with `node scripts/build-whisper-vendor.mjs` when updating the pinned runtime dependencies.
