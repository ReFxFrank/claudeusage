#!/bin/bash
# Model-family recognition: the pure classifier maps model strings to the right
# provider family (used for the by-model logos, labels, and colors).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
node --input-type=module -e '
import { modelFamily, FAMILY_META } from "'"$ROOT"'/web/src/model-families.js";
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const CASES = {
  "claude-fable-5": "claude", "claude-opus-4-8": "claude", "claude-haiku-4-5": "claude", "anthropic/claude-x": "claude",
  "gpt-5.6-sol": "openai", "o3-mini": "openai", "codex-mini-latest": "openai", "chatgpt-4o": "openai", "gpt-4.1": "openai",
  "gemini-3-pro": "google", "gemini-2.5-flash": "google", "gemma-3-27b": "google",
  "deepseek-v3": "deepseek", "deepseek-r1": "deepseek",
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
'
RES=$?
echo "---- exit $RES"
exit $RES
