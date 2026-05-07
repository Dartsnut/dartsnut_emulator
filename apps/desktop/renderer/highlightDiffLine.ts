import hljs from "highlight.js/lib/core";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";

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

/** Highlight.js language id for a file path, or null for plain escaped text */
export function languageFromPath(path: string | undefined): string | null {
  if (!path) {
    return null;
  }
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "css":
    case "scss":
      return "css";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "py":
      return "python";
    case "html":
    case "htm":
    case "xml":
      return "xml";
    default:
      return null;
  }
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
