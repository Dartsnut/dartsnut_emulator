import { useCallback, useEffect, useState } from "react";
import { cn } from "./cn";

const DEPLOY_AUTH_SKIPPED_KEY = "deploy_auth_skipped";

export function isDeployAuthSkippedForSession(): boolean {
  try {
    return sessionStorage.getItem(DEPLOY_AUTH_SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDeployAuthSkippedForSession(): void {
  try {
    sessionStorage.setItem(DEPLOY_AUTH_SKIPPED_KEY, "1");
  } catch {
    // ignore
  }
}

type GoogleCredentialResponse = {
  credential?: string;
};

type GoogleIdApi = {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
      }) => void;
      prompt: (momentListener?: (notification: { isNotDisplayed: () => boolean }) => void) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdApi;
  }
}

export type DeployAuthGateProps = {
  open: boolean;
  googleClientId: string;
  onSkip: () => void;
  onSuccess: (account: string) => void;
};

const toolbarBtn = "ui-toolbar-btn";

function loadGoogleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-dartsnut-gsi="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Load Google script failed")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.dartsnutGsi = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Load Google script failed"));
    document.head.appendChild(script);
  });
}

export function DeployAuthGate({ open, googleClientId, onSkip, onSuccess }: DeployAuthGateProps) {
  const api = window.dartsnutApi;
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "google" | null>(null);

  useEffect(() => {
    if (!open) {
      setHint(null);
      setBusy(null);
    }
  }, [open]);

  const handlePasswordLogin = useCallback(async () => {
    if (!api?.communityLogin) {
      return;
    }
    const acct = account.trim();
    if (!acct || !password) {
      setHint("Please enter account and password.");
      return;
    }
    setHint(null);
    setBusy("password");
    try {
      const res = await api.communityLogin({ method: "password", account: acct, password });
      if (!res.ok) {
        setHint(res.message);
        return;
      }
      onSuccess(res.account);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [account, password, api, onSuccess]);

  const handleGoogleLogin = useCallback(async () => {
    if (!api?.communityLogin) {
      return;
    }
    const clientId = googleClientId.trim();
    if (!clientId) {
      setHint("Google sign-in is not configured (set DARTSNUT_GOOGLE_CLIENT_ID in .env).");
      return;
    }
    setHint(null);
    setBusy("google");
    try {
      await loadGoogleScript();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        window.google!.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            const idToken = String(response?.credential || "").trim();
            if (!idToken) {
              setHint("Google sign-in did not return a credential.");
              finish();
              return;
            }
            try {
              const res = await api.communityLogin({ method: "google", idToken });
              if (!res.ok) {
                setHint(res.message);
              } else {
                onSuccess(res.account);
              }
            } catch (e) {
              setHint(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(null);
              finish();
            }
          }
        });
        window.google!.accounts.id.prompt(() => finish());
        window.setTimeout(finish, 12_000);
      });
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, [api, googleClientId, onSuccess]);

  const handleSkip = useCallback(() => {
    setDeployAuthSkippedForSession();
    onSkip();
  }, [onSkip]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[2100] flex items-center justify-center bg-[var(--color-zoom-overlay)] p-4"
      role="presentation"
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-zoom-popover-border)] bg-[var(--color-zoom-popover-bg)] p-5 shadow-[var(--shadow-md)]"
        role="dialog"
        aria-labelledby="deploy-auth-title"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id="deploy-auth-title" className="ui-panel-title">
            Sign in to pick a device
          </h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-subtle)]">
            Log in with your Dartsnut account to select a bound machine and use its IP automatically. You can
            continue without signing in and enter an IP manually.
          </p>
        </div>

        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[var(--color-text-subtle)]">Email</span>
          <input
            type="email"
            className="ui-input"
            autoComplete="username"
            value={account}
            disabled={busy !== null}
            onChange={(e) => setAccount(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[var(--color-text-subtle)]">Password</span>
          <input
            type="password"
            className="ui-input"
            autoComplete="current-password"
            value={password}
            disabled={busy !== null}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handlePasswordLogin();
              }
            }}
          />
        </label>

        {hint ? (
          <p className="text-[13px] text-[var(--color-error-text)]" role="alert">
            {hint}
          </p>
        ) : null}

        <button
          type="button"
          className="ui-btn-primary"
          disabled={busy !== null}
          onClick={() => void handlePasswordLogin()}
        >
          {busy === "password" ? "Signing in…" : "Sign in"}
        </button>

        <button
          type="button"
          className={cn(toolbarBtn, "w-full justify-center")}
          disabled={busy !== null || !googleClientId.trim()}
          onClick={() => void handleGoogleLogin()}
        >
          {busy === "google" ? "Opening Google…" : "Continue with Google"}
        </button>

        <button type="button" className={cn(toolbarBtn, "w-full justify-center")} disabled={busy !== null} onClick={handleSkip}>
          Continue without account
        </button>
      </div>
    </div>
  );
}
