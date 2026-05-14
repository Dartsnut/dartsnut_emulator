import { highlightDiffLine } from "./highlightDiffLine";

export interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

interface FinalDiffPreviewProps {
  addCount: number;
  fileLabel: string;
  isNewFile: boolean;
  lang: string | null;
  lines: DiffLine[];
  removeCount: number;
  truncated: boolean;
}

export default function FinalDiffPreview({
  addCount,
  fileLabel,
  isNewFile,
  lang,
  lines,
  removeCount,
  truncated
}: FinalDiffPreviewProps) {
  return (
    <>
      <div className={`final-diff-card${isNewFile ? " final-diff-card--new-file" : ""}`}>
        <header className="final-diff-header">
          <span className="final-diff-title">
            <span className="final-diff-hash">#</span>
            <span className="final-diff-filename">{fileLabel}</span>
          </span>
          <span className="final-diff-stats">
            {addCount > 0 ? <span className="final-diff-stat final-diff-stat--add">+{addCount}</span> : null}
            {removeCount > 0 ? (
              <span className="final-diff-stat final-diff-stat--remove">-{removeCount}</span>
            ) : null}
          </span>
        </header>
        <div className="final-diff-body">
          {lines.map((line, lineIdx) => (
            <div key={`${line.kind}-${lineIdx}`} className={`final-diff-line final-diff-line--${line.kind}`}>
              <span className="final-diff-prefix">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
              </span>
              <code
                className="final-diff-code"
                dangerouslySetInnerHTML={{
                  __html: highlightDiffLine(line.text, lang)
                }}
              />
            </div>
          ))}
        </div>
        <div className="final-diff-chevron" aria-hidden />
      </div>
      {truncated ? <div className="diff-truncation">Additional changes not shown.</div> : null}
    </>
  );
}
