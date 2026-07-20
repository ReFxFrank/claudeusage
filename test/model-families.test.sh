#!/bin/bash
# Model-family recognition: the pure classifier maps model strings to the right
# provider family (used for the by-model logos, labels, and colors).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Dynamic import via pathToFileURL so the module resolves on every platform —
# a Git-Bash-style $ROOT (/c/Users/…) interpolated into a static import breaks
# on Windows; passed as argv it arrives as a native path and converts cleanly.
node -e '
const { pathToFileURL } = require("node:url");
const modPath = require("node:path").join(process.argv[1], "web", "src", "model-families.js");
import(pathToFileURL(modPath).href).then(({ modelFamily, FAMILY_META }) => {
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const CASES = {
  "claude-fable-5": "claude", "claude-opus-4-8": "claude", "claude-haiku-4-5": "claude", "anthropic/claude-x": "claude",
  "gpt-5.6-sol": "openai", "o3-mini": "openai", "codex-mini-latest": "openai", "chatgpt-4o": "openai", "gpt-4.1": "openai",
  "gemini-3-pro": "google", "gemini-2.5-flash": "google", "gemma-3-27b": "google",
  "deepseek-v3": "deepseek", "deepseek-r1": "deepseek",
  "glm-4.6": "glm", "glm-4.5-air": "glm", "glm-5": "glm", "chatglm-3": "glm", "z-ai/glm-4.6": "glm",
  "llama-4-scale": "meta", "meta-llama-3": "meta",
  "grok-4": "xai", "grok-code-fast-1": "xai",
  "qwen3-max": "qwen", "qwen2.5-coder": "qwen",
  "mistral-large-3": "mistral", "codestral-2508": "mistral", "mixtral-8x22b": "mistral",
  "command-r-plus": "cohere",
  "some-unknown-model": "other", "": "other",
};
for (const [model, fam] of Object.entries(CASES)) {
  const got = modelFamily(model);
  ok(got === fam, `"${model}" -> ${fam} (got ${got})`);
  ok(FAMILY_META[got] && typeof FAMILY_META[got].label === "string" && /^#/.test(FAMILY_META[got].color), `${fam} has label + color`);
}
// gpt vs codex both land in openai; gemini not misread as anything else
ok(modelFamily("codex-auto-review") === "openai", "codex-auto-review -> openai");
ok(modelFamily("gpt-5.4-mini") === "openai", "mini suffix stays openai");
process.exit(fail);
}).catch((e) => { console.error("FAIL  could not import model-families.js:", e.message); process.exit(1); });
' "$ROOT"
RES=$?
echo "---- exit $RES"
exit $RES
