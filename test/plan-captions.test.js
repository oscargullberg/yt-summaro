import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { captionSegments, readYouTubeCaptions } from "../extension/plan-captions.js";

const videoId = "KWyc_Pyo9NQ";
const otherVideo = "IRK8h67ol7Q";
const context = { client: { clientName: "WEB", clientVersion: "fixture-version", visitorData: "fixture-visitor" } };
const pageData = (id = videoId, params = "fixture-transcript-params") => ({
  currentVideoEndpoint: { watchEndpoint: { videoId: id } },
  engagementPanels: [{ engagementPanelSectionListRenderer: {
    content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params } } } }
  } }]
});
const classicResponse = () => ({ actions: [{ updateEngagementPanelAction: { content: {
  transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: {
    transcriptSegmentListRenderer: { initialSegments: [
      { transcriptSegmentRenderer: { startMs: "0", snippet: { runs: [{ text: "Hello " }, { text: "world." }] } } },
      { transcriptSegmentRenderer: { startMs: "22500", snippet: { simpleText: "Another point." } } }
    ] }
  } } } }
} } }] });

function harness({ initial = pageData(), current, clientContext = context, network, native = true, tracks = [] } = {}) {
  const calls = [];
  const location = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  const cue = { querySelector: (selector) => ({
    textContent: selector.includes("Timestamp") ? "0:00" : "Native fallback transcript."
  }) };
  const panel = {
    getAttribute: (name) => name === "visibility" ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" : "PAmodern_transcript_view",
    querySelectorAll: () => { calls.push("panel"); return [cue]; }
  };
  const watch = {
    data: current, isConnected: true,
    getAttribute: () => location.searchParams.get("v"),
    querySelectorAll: () => native ? [panel] : [],
    querySelector: () => null
  };
  const player = { getPlayerResponse: () => ({
    videoDetails: { videoId, title: "Fixture", author: "Channel", lengthSeconds: "566" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
  }) };
  const sandbox = {
    location, window: { ytInitialData: initial, ytcfg: { get: (key) => key === "INNERTUBE_CONTEXT" ? clientContext : undefined } },
    document: {
      title: "Fixture - YouTube", getElementById: () => player,
      querySelector: () => watch
    },
    URL, URLSearchParams, AbortSignal, TextDecoder, performance, setTimeout,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return network ? network(url, init, location) : Response.json(classicResponse());
    }
  };
  const read = runInNewContext(`(${readYouTubeCaptions.toString()})`, sandbox);
  return { calls, read: () => read(videoId), location };
}

test("fetches structured captions before touching the transcript panel", async () => {
  const { read, calls } = harness();
  const result = await read();
  expect(result).toMatchObject({ videoId, title: "Fixture", channel: "Channel", duration: 566 });
  expect(captionSegments(result)).toEqual([
    { id: 1, seconds: 0, text: "Hello world." },
    { id: 2, seconds: 22.5, text: "Another point." }
  ]);
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0];
  expect(url).toBe("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false");
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
  expect(JSON.parse(init.body)).toEqual({ context, params: "fixture-transcript-params" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers).toEqual({ "content-type": "application/json" });
});

test("uses current watch data instead of stale initial data after SPA navigation", async () => {
  const { read, calls } = harness({ initial: pageData(otherVideo, "stale"), current: pageData(videoId, "current") });
  expect(captionSegments(await read())).toHaveLength(2);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].init.body).params).toBe("current");
});

test("discovers the current video's transcript command when bootstrap data is stale", async () => {
  const { read, calls } = harness({
    initial: pageData(otherVideo, "stale"),
    network: (url) => Response.json(url.pathname.endsWith("/next") ? pageData() : classicResponse())
  });
  expect(captionSegments(await read())).toHaveLength(2);
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/youtubei/v1/next", "/youtubei/v1/get_transcript"]);
  expect(JSON.parse(calls[0].init.body)).toEqual({ context, videoId });
  expect(calls[0].init.signal).toBe(calls[1].init.signal);
});

test("does not follow transcript commands for recommended videos", async () => {
  const data = pageData();
  data.engagementPanels = [];
  data.contents = { recommendation: pageData(otherVideo) };
  const { read, calls } = harness({ initial: data });
  expect((await read()).visible[0].text).toBe("Native fallback transcript.");
  expect(calls).toEqual(["panel"]);
});

test("rejects discovery data for a different video", async () => {
  const { read, calls } = harness({ initial: null, network: () => Response.json(pageData(otherVideo)) });
  expect((await read()).visible[0].text).toBe("Native fallback transcript.");
  expect(calls.filter((call) => typeof call === "object")).toHaveLength(1);
  expect(calls.at(-1)).toBe("panel");
});

test.each([
  ["denied", () => new Response(null, { status: 403 })],
  ["server error", () => new Response(null, { status: 503 })],
  ["invalid JSON", () => new Response("not JSON")],
  ["API error", () => Response.json({ error: { code: 400 } })],
  ["empty transcript", () => Response.json({ actions: [] })],
  ["timeout", () => { throw new DOMException("Timed out", "TimeoutError"); }],
  ["oversized header", () => new Response("{}", { headers: { "content-length": "4000001" } })],
  ["oversized body", () => new Response(" ".repeat(4_000_001))],
  ["other video", () => Response.json({ ...classicResponse(), currentVideoEndpoint: { watchEndpoint: { videoId: otherVideo } } })],
  ["incomplete transcript", () => {
    const result = classicResponse();
    result.actions[0].updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer
      .body.transcriptSegmentListRenderer.initialSegments.push({ continuationItemRenderer: {} });
    return Response.json(result);
  }]
])("falls back to the native panel on %s", async (_, network) => {
  const { read, calls } = harness({ network });
  expect((await read()).visible[0].text).toBe("Native fallback transcript.");
  expect(calls).toHaveLength(2);
  expect(calls.at(-1)).toBe("panel");
});

test("skips direct requests when the current YouTube client context is unavailable", async () => {
  const { read, calls } = harness({ clientContext: null });
  expect((await read()).visible[0].text).toBe("Native fallback transcript.");
  expect(calls).toEqual(["panel"]);
});

test("supports attributed view-model text and removes repeated segments", async () => {
  const segment = { transcriptSegmentViewModel: { startMs: "45000", snippet: { content: "Modern transcript." } } };
  const { read } = harness({ network: () => Response.json({ contents: [
    segment, segment,
    { transcriptSegmentRenderer: { startMs: -1, snippet: { simpleText: "Invalid time." } } },
    { transcriptSegmentRenderer: { startMs: null, snippet: { simpleText: "Missing time." } } },
    { transcriptSegmentRenderer: { startMs: "10", snippet: { runs: [null] } } }
  ] }) });
  expect(captionSegments(await read())).toEqual([{ id: 1, seconds: 45, text: "Modern transcript." }]);
});

test("ignores a transcript response after the user changes video", async () => {
  const { read, calls } = harness({ network: (_, __, location) => {
    location.searchParams.set("v", otherVideo);
    return Response.json(classicResponse());
  } });
  expect(await read()).toBeNull();
  expect(calls).toHaveLength(1);
});

test("retains the timedtext fallback after structured and panel retrieval fail", async () => {
  const { read, calls } = harness({
    native: false,
    tracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}`, languageCode: "en", kind: "asr" }],
    network: (url) => url.pathname.endsWith("/get_transcript")
      ? new Response(null, { status: 403 })
      : Response.json({ events: [{ tStartMs: 0, segs: [{ utf8: "Caption track fallback." }] }] })
  });
  const result = await read();
  expect(result).toMatchObject({ lang: "en", auto: true });
  expect(captionSegments(result)[0].text).toBe("Caption track fallback.");
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/youtubei/v1/get_transcript", "/api/timedtext"]);
});
