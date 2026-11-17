import { describe, expect, test } from "bun:test";
import { mergeWhisperChunks, resolveModel, WHISPER_MODELS } from "../extension/plan-whisper-core.js";

describe("local Whisper transcript assembly", () => {
  test("merges nearby chunks and keeps absolute timestamps", () => {
    const segments = mergeWhisperChunks([
      { start: 0, end: 8, text: " Hello there." },
      { start: 8, end: 15, text: " This is a test." },
      { start: 40, end: 50, text: "A later point." }
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ id: 1, seconds: 0, text: "Hello there. This is a test." });
    expect(segments[1]).toEqual({ id: 2, seconds: 40, text: "A later point." });
  });

  test("drops duplicate chunks produced by overlapping audio slices", () => {
    const segments = mergeWhisperChunks([
      { start: 295, end: 302, text: "The same sentence at the slice boundary." },
      { start: 296, end: 303, text: "The same sentence at the slice boundary." },
      { start: 303, end: 309, text: "Then the next sentence." }
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("The same sentence at the slice boundary. Then the next sentence.");
  });

  test("removes non-speech annotations and empty chunks", () => {
    const segments = mergeWhisperChunks([
      { start: 0, end: 2, text: "[Music]" },
      { start: 2, end: 5, text: " (applause) " },
      { start: 5, end: 9, text: "Actual speech." }
    ]);
    expect(segments).toEqual([{ id: 1, seconds: 5, text: "Actual speech." }]);
  });

  test("falls back to the base model for unknown names", () => {
    expect(resolveModel("tiny")).toBe(WHISPER_MODELS.tiny);
    expect(resolveModel("onnx-community/whisper-small")).toBe(WHISPER_MODELS.small);
    expect(resolveModel("unknown")).toBe(WHISPER_MODELS.base);
  });
});
