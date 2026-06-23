import { useEffect, useState } from "react";

export type CommunityApiFailure = {
  ok: boolean;
  code?: string;
  message?: string;
  serverMessage?: string;
  authRequired?: boolean;
};

export function isCommunityAuthFailure(res: CommunityApiFailure): boolean {
  return !res.ok && (res.authRequired || res.code === "session_expired");
}

export function shouldShowCommunityErrorSnackbar(res: CommunityApiFailure): boolean {
  return !res.ok && !isCommunityAuthFailure(res) && Boolean(res.message?.trim());
}

export function CommunityErrorSnackbar({
  message,
  detail,
  onDismiss
}: {
  message: string | null;
  detail?: string | null;
  onDismiss: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailText = detail?.trim() || null;

  useEffect(() => {
    setDetailsOpen(false);
  }, [message, detailText]);

  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = window.setTimeout(onDismiss, 4200);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <div
      className="fixed left-1/2 top-4 z-[2200] flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-col rounded-lg border border-[var(--color-error-border)] bg-[var(--color-toast-backdrop)] px-3 py-2 text-[13px] text-[var(--color-toast-text)] shadow-[var(--shadow-md)]"
      role="alert"
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 break-words">{message}</span>
        {detailText ? (
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-[var(--color-error-text)]"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            Detail
          </button>
        ) : null}
      </div>
      {detailsOpen && detailText ? (
        <>
          <div className="my-2 h-px w-full bg-[var(--color-toast-border)]" />
          <span className="min-w-0 max-w-[min(560px,calc(100vw-48px))] break-words text-xs leading-relaxed">
            {detailText}
          </span>
        </>
      ) : null}
    </div>
  );
}
