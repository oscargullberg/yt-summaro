export class AsrError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AsrError";
    this.code = code;
  }
}

export const WHISPER_MODELS = Object.freeze({
  tiny: {
    key: "tiny",
    id: "onnx-community/whisper-tiny",
    revision: "ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
    label: "Whisper tiny",
    download: "~40–80 MB"
  },
  base: {
    key: "base",
    id: "onnx-community/whisper-base",
    revision: "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c",
    label: "Whisper base",
    download: "~80–150 MB"
  },
  small: {
    key: "small",
    id: "onnx-community/whisper-small",
    revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732",
    label: "Whisper small",
    download: "~250–500 MB"
  }
});

export function resolveModel(value) {
  const name = String(value || "").trim();
  if (Object.hasOwn(WHISPER_MODELS, name)) return WHISPER_MODELS[name];
  return Object.values(WHISPER_MODELS).find((model) => model.id === name) || WHISPER_MODELS.base;
}

const NOISE = /\[\s*(?:music|applause|laughter|silence|inaudible|blank_audio|foreign)\s*\]|\(\s*(?:music|applause|laughter|silence|inaudible|foreign)\s*\)/gi;

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—\s]+/, "");
}

function comparable(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function mergeWhisperChunks(chunks) {
  const cues = (Array.isArray(chunks) ? chunks : []).flatMap((chunk) => {
    const text = cleanText(chunk?.text);
    const start = Number(chunk?.start);
    let end = Number(chunk?.end);
    if (!text || !Number.isFinite(start) || start < 0) return [];
    if (!Number.isFinite(end) || end <= start) end = start + 1;
    return [{ start, end, text }];
  }).sort((left, right) => left.start - right.start);

  const blocks = [];
  for (const cue of cues) {
    let { start, end, text } = cue;
    const last = blocks.at(-1);
    if (last) {
      if (start < last.end - 1) {
        const tail = comparable(last.text).slice(-260);
        const current = comparable(text);
        if (current && tail && (tail.includes(current) || current.includes(tail.slice(-120)))) continue;
        start = Math.max(start, last.end - 0.5);
      }
      if (start - last.seconds < 18 && last.text.length + text.length < 380) {
        last.text += ` ${text}`;
        last.end = Math.max(last.end, end);
        continue;
      }
    }
    blocks.push({ id: blocks.length + 1, seconds: start, end, text });
  }

  return blocks.map(({ id, seconds, text }) => ({ id, seconds, text }));
}
