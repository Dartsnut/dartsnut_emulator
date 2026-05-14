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
