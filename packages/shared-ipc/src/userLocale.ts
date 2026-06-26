/** Supported assistant response locales (user-facing prose only). */
export type UserLocale = "en" | "zh-Hans" | "zh-Hant";

/** Characters that strongly suggest Traditional Chinese when present. */
const TRADITIONAL_SCRIPT_MARKERS =
  /[國臺灣說話這個們為裡會將體給驚組畫時鐘遊貼後麼麼們與說裡後給將體組畫時鐘遊戲貼圖驚喜組件遊戲個們為裡說與後會將給體]/u;

/** Characters that strongly suggest Simplified Chinese when present. */
const SIMPLIFIED_SCRIPT_MARKERS =
  /[国台湾说这个们为里会将体给惊组画时钟游贴后么么们与说里后给将体组画时钟游贴图惊喜组件游戏个们为里说与后会将给体]/u;

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/u;
const ASCII_LETTER_RE = /[A-Za-z]/u;

const AMBIGUOUS_SHORT_FOLLOW_UPS = new Set([
  "ok",
  "okay",
  "k",
  "yes",
  "y",
  "no",
  "n",
  "thanks",
  "thank you",
  "thx",
  "sure",
  "go",
  "next",
  "continue",
  "done"
]);

function isAmbiguousNonChineseFollowUp(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:\s]+/gu, " ")
    .trim();
  if (!normalized) {
    return true;
  }
  if (AMBIGUOUS_SHORT_FOLLOW_UPS.has(normalized)) {
    return true;
  }
  if (!ASCII_LETTER_RE.test(normalized)) {
    return true;
  }
  const words = normalized.split(" ").filter(Boolean);
  return words.length <= 1 && normalized.length <= 4;
}

function hasChineseText(text: string): boolean {
  return CJK_RE.test(text);
}

function countScriptMarkers(text: string): { trad: number; simp: number } {
  let trad = 0;
  let simp = 0;
  for (const ch of text.trim()) {
    if (TRADITIONAL_SCRIPT_MARKERS.test(ch)) {
      trad += 1;
    }
    if (SIMPLIFIED_SCRIPT_MARKERS.test(ch)) {
      simp += 1;
    }
  }
  return { trad, simp };
}

/**
 * Infer response locale from a single user message (latest bubble).
 * Not used for routing — only language stickiness and mirror instructions.
 */
export function detectUserLocale(text: string): UserLocale {
  const trimmed = text.trim();
  if (!trimmed || !CJK_RE.test(trimmed)) {
    return "en";
  }
  const { trad, simp } = countScriptMarkers(trimmed);
  if (trad > simp) {
    return "zh-Hant";
  }
  if (simp > trad) {
    return "zh-Hans";
  }
  return "zh-Hans";
}

/**
 * Session locale: prefer explicit Chinese from the latest message; keep persisted
 * Chinese for short/ambiguous follow-ups; clear English switches back to English.
 */
export function resolveSessionUserLocale(
  persisted: UserLocale | null | undefined,
  latestUserMessage: string
): UserLocale {
  const detected = detectUserLocale(latestUserMessage);
  if (detected !== "en") {
    if (persisted && persisted !== "en" && hasChineseText(latestUserMessage)) {
      const { trad, simp } = countScriptMarkers(latestUserMessage);
      if (trad === 0 && simp === 0) {
        return persisted;
      }
    }
    return detected;
  }
  if (persisted && persisted !== "en" && isAmbiguousNonChineseFollowUp(latestUserMessage)) {
    return persisted;
  }
  return "en";
}

/** System message block for SessionEngine (not routing). */
export function buildLanguageSystemPrompt(locale?: UserLocale | null): string {
  const lines = [
    "Language policy (mandatory for user-visible prose):",
    "- Users may write in **English**, **Simplified Chinese (zh-Hans)**, or **Traditional Chinese (zh-Hant)**.",
    "- **output-only:** response language applies only to model-authored, user-visible prose: explanations, status-style summaries, and questions.",
    "- **Must** use the same natural language as the user for model-authored explanations, status-style summaries, and questions.",
    "- **Persist** across turns: if the conversation is in Chinese, do **not** revert to English after short follow-ups (e.g. ok, 继续, 好), tool results, or English-only scaffolding in system messages.",
    "- **Variant:** Simplified user text → Simplified replies; Traditional → Traditional; mixed/unclear Chinese → match the script the user used most recently in this session.",
    "- Use **English** when the user's latest message is clearly English; keep the session locale for short/ambiguous follow-ups.",
    "- Language **must not change behavior**, routing, tool choice, intake decisions, project type inference, build steps, verification, or success criteria.",
    "- **Never translate** code, file paths, JSON keys, `skill_id`, tool names, or conventional API/library names (e.g. `get_dartsnut_skill`, `128x128`).",
    "- Interpret **intent** from meaning in any supported language; skill ids and tool names stay English."
  ];
  if (locale === "zh-Hans") {
    lines.push(
      "- Session locale: zh-Hans (Simplified Chinese). Keep all assistant explanations and questions in Simplified Chinese for this session unless the user clearly switches to English or Traditional."
    );
  } else if (locale === "zh-Hant") {
    lines.push(
      "- Session locale: zh-Hant (Traditional Chinese). Keep all assistant explanations and questions in Traditional Chinese for this session unless the user clearly switches to English or Simplified."
    );
  } else if (locale === "en") {
    lines.push("- Session locale: English.");
  }
  return lines.join("\n");
}
