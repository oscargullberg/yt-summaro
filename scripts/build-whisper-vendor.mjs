#!/usr/bin/env node
// Rebuilds the vendored Transformers.js + ONNX Runtime Web bundle.
// The extension itself has no build step; this is only needed when updating
// the pinned runtime versions.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(root, "scripts", ".whisper-build");
const vendorDir = join(root, "extension", "vendor");
const TRANSFORMERS_VERSION = "4.3.2";
const ONNXRUNTIME_VERSION = "1.31.1";
const ESBUILD_VERSION = "0.28.2";

mkdirSync(buildDir, { recursive: true });
mkdirSync(vendorDir, { recursive: true });

writeFileSync(join(buildDir, "package.json"), `${JSON.stringify({
  name: "yt-summaro-whisper-build",
  private: true,
  type: "module",
  dependencies: { "@huggingface/transformers": TRANSFORMERS_VERSION, esbuild: ESBUILD_VERSION, "onnxruntime-web": ONNXRUNTIME_VERSION }
}, null, 2)}\n`);

writeFileSync(join(buildDir, "whisper-entry.js"), [
  'import { env, pipeline } from "@huggingface/transformers";',
  "export { env, pipeline };",
  ""
].join("\n"));

// Transformers.js and ONNX Runtime Web can otherwise bundle two different
// Tensor classes, which breaks pipeline inputs at runtime.
writeFileSync(join(buildDir, "ort-common.js"), 'export { Tensor } from "onnxruntime-web/webgpu";\n');

const required = { "@huggingface/transformers": TRANSFORMERS_VERSION, esbuild: ESBUILD_VERSION, "onnxruntime-web": ONNXRUNTIME_VERSION };
const installed = Object.entries(required).every(([name, version]) => {
  const manifest = join(buildDir, "node_modules", name, "package.json");
  return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === version;
});
if (!installed) {
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: buildDir, stdio: "inherit" });
}

const esbuild = join(buildDir, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
execFileSync(esbuild, [
  "whisper-entry.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--target=chrome116",
  "--minify",
  "--alias:onnxruntime-common=./ort-common.js",
  "--outfile=whisper.bundle.js"
], { cwd: buildDir, stdio: "inherit" });

const ortDist = join(buildDir, "node_modules", "onnxruntime-web", "dist");
copyFileSync(join(buildDir, "whisper.bundle.js"), join(vendorDir, "whisper.bundle.js"));
copyFileSync(join(ortDist, "ort-wasm-simd-threaded.asyncify.wasm"), join(vendorDir, "ort-wasm-simd-threaded.asyncify.wasm"));
copyFileSync(join(ortDist, "ort-wasm-simd-threaded.asyncify.mjs"), join(vendorDir, "ort-wasm-simd-threaded.asyncify.mjs"));

console.log("Vendored runtime updated in extension/vendor.");
