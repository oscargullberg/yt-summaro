import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function contentHarness(sendMessage?: (message: { type: string }) => Promise<unknown>) {
  let resolveMessage!: (value: unknown) => void;
  let rejectMessage!: (error: Error) => void;
  let onMessage!: (message: { type: string }, sender: { id: string }, reply: () => void) => boolean;
  const response = new Promise((resolve, reject) => { resolveMessage = resolve; rejectMessage = reject; });
  // Expose the closure to the test without loading a DOM or changing production exports.
  const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8")
    .replace(/  void \(async \(\) => \{\n    await loadSettings\(\);\n    scheduleNavigate\(\);\n  \}\)\(\);/, "  globalThis.harness = { state, pollJob, restoreSavedSummary, refreshPlan };");
  const createElement = () => ({
    dataset: {}, setAttribute() {}, append() {}, replaceChildren() {}, querySelector() { return null; }
  });
  const context: any = {
    location: { hostname: "www.youtube.com", href: "https://www.youtube.com/watch?v=aircAruvnKk" },
    window: {}, document: { addEventListener() {}, createElement },
    chrome: {
      runtime: { id: "test", sendMessage: sendMessage ?? (() => response), onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; } } },
      storage: { onChanged: { addListener() {} } }
    },
    setInterval() {}, setTimeout(fn: () => void) { fn(); return 1; }, clearTimeout() {}, URL
  };
  runInNewContext(source, context);
  return { ...context.harness, resolveMessage, rejectMessage, onMessage, createElement };
}

describe("YouTube navigation races", () => {
  test("ignores a completed poll from the previous video", async () => {
    const { state, pollJob, resolveMessage } = contentHarness();
    state.seq = 1;
    const pending = pollJob(1, "old-job");
    await Promise.resolve();
    state.seq = 2;
    state.job = { id: "new-job" };
    resolveMessage({ ok: true, job: { id: "old-job", status: "done" } });
    await pending;
    expect(state.job.id).toBe("new-job");
  });

  test("ignores a failed poll after navigation instead of rendering an error", async () => {
    const { state, pollJob, rejectMessage } = contentHarness();
    state.seq = 1;
    const pending = pollJob(1, "old-job");
    await Promise.resolve();
    state.seq = 2;
    state.job = { id: "new-job" };
    rejectMessage(new Error("Disconnected"));
    await pending;
    expect(state.job.id).toBe("new-job");
  });

  test("restores the saved summary only if no newer operation took over the card", async () => {
    const videoId = "aircAruvnKk";
    const job = { status: "done", result: { cached: true, summary: { tldr: "Saved summary" } } };
    const current = contentHarness();
    const stale = contentHarness();
    const restore = current.restoreSavedSummary(videoId, 0);
    const lateRestore = stale.restoreSavedSummary(videoId, 0);
    stale.state.seq++;
    current.resolveMessage({ ok: true, job });
    stale.resolveMessage({ ok: true, job });
    await Promise.all([restore, lateRestore]);
    expect(current.state.result).toBe(job.result);
    expect(stale.state.result).toBeNull();
  });
});

test("updates a mounted card after sign-in and ignores an older status response", async () => {
  const requests: ((value: unknown) => void)[] = [];
  const { state, onMessage, refreshPlan, createElement } = contentHarness((message) => {
    expect(message.type).toBe("plan:status");
    return new Promise((resolve) => requests.push(resolve));
  });
  state.videoId = "aircAruvnKk";
  state.plan = { connected: false, models: [] };
  state.job = { status: "error" };
  state.refs = Object.fromEntries(
    ["card", "model", "style", "language", "go", "cancel", "status", "body", "healthDot", "planLabel"]
      .map((key) => [key, createElement()])
  );
  state.refs.status.dataset.errorCode = "PLAN_DISCONNECTED";
  state.planCheckedAt = Date.now();
  const previous = refreshPlan();
  const reply = () => {};
  onMessage({ type: "plan:changed" }, { id: "test" }, reply);
  expect(requests).toHaveLength(2);
  requests[1]({ ok: true, connected: true, models: ["test-model"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  requests[0]({ ok: true, connected: false, models: [] });
  await previous;
  expect(state.plan.connected).toBe(true);
  expect(state.refs.planLabel.textContent).toBe("ChatGPT plan · connected");
  expect(state.refs.status.hidden).toBe(true);
  expect(state.refs.go.textContent).toBe("Summarize");
  expect(state.job).toBeNull();
});
