# Vendored Whisper runtime

These files are built from open-source packages and checked in so the extension
can run without downloading executable code or requiring a build step.

| File | Source | License |
| --- | --- | --- |
| `whisper.bundle.js` | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) 4.3.2, bundling [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) 1.31.1 | Apache-2.0 (Transformers.js); MIT (ONNX Runtime) |
| `ort-wasm-simd-threaded.asyncify.wasm` | `onnxruntime-web` 1.31.1 | MIT |
| `ort-wasm-simd-threaded.asyncify.mjs` | `onnxruntime-web` 1.31.1 | MIT |

The bundle is produced by `scripts/build-whisper-vendor.mjs`. It contains no
model weights. Whisper models are downloaded at runtime from Hugging Face into
the browser's Cache Storage on first use.

License texts are in `LICENSE-TRANSFORMERS.txt` and `LICENSE-ONNXRUNTIME.txt`.
