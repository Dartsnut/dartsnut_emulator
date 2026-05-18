interface FileEditSummaryProps {
  addCount: number;
  fileLabel: string;
  isNewFile: boolean;
  removeCount: number;
}

export default function FileEditSummary({
  addCount,
  fileLabel,
  isNewFile,
  removeCount
}: FileEditSummaryProps) {
  const verb = isNewFile ? "Created" : "Edited";

  return (
    <div className="file-edit-summary" aria-label={`${verb} ${fileLabel}`}>
      <span className="file-edit-summary__label">
        {verb} {fileLabel}
      </span>
      {addCount > 0 || removeCount > 0 ? (
        <span className="file-edit-summary__stats">
          {addCount > 0 ? (
            <span className="file-edit-summary__stat file-edit-summary__stat--add">+{addCount}</span>
          ) : null}
          {removeCount > 0 ? (
            <span className="file-edit-summary__stat file-edit-summary__stat--remove">-{removeCount}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
