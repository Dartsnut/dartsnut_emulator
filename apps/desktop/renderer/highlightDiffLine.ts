import hljs from "highlight.js/lib/core";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
export { languageFromPath } from "./languageFromPath";

hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function highlightDiffLine(line: string, lang: string | null): string {
  if (lang === null || !hljs.getLanguage(lang)) {
    return escapeHtml(line);
  }
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(line);
  }
}
