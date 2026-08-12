import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";
import googleGLogo from "./assets/google-g-logo.png";

const DEPLOY_AUTH_SKIPPED_KEY = "deploy_auth_skipped";

export function isDeployAuthSkippedForSession(): boolean {
  try {
    return sessionStorage.getItem(DEPLOY_AUTH_SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

export const isCommunityAuthSkippedForSession = isDeployAuthSkippedForSession;

export function setDeployAuthSkippedForSession(): void {
  try {
    sessionStorage.setItem(DEPLOY_AUTH_SKIPPED_KEY, "1");
  } catch {
    // ignore
  }
}

export const setCommunityAuthSkippedForSession = setDeployAuthSkippedForSession;

export type DeployAuthGateProps = {
  open: boolean;
  googleSignInAvailable: boolean;
  title?: string;
  description?: string;
  allowSkip?: boolean;
  onClose: () => void;
  onSkip: () => void;
  onSuccess: (account: string) => void;
};

const toolbarBtn = "ui-toolbar-btn";

export function DeployAuthGate({
  open,
  googleSignInAvailable,
  title = "Sign in to Dartsnut",
  description = "Log in with your Dartsnut account to use community features. You can continue without signing in and enter an IP manually.",
  allowSkip = true,
  onClose,
  onSkip,
  onSuccess
}: DeployAuthGateProps) {
  const api = window.dartsnutApi;
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [googleAccount, setGoogleAccount] = useState("");
  const [passwordSetupOpen, setPasswordSetupOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "google" | "google-cancelling" | null>(null);

  useEffect(() => {
    if (!open) {
      setAccount("");
      setPassword("");
      setConfirmPassword("");
      setGoogleAccount("");
      setPasswordSetupOpen(false);
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
    if (!googleSignInAvailable) {
      setHint("Google sign-in is not configured (set DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID in .env).");
      return;
    }
    setHint(null);
    setBusy("google");
    try {
      const res = await api.communityLogin({ method: "googleOAuth" });
      if (!res.ok) {
        if (res.code !== "cancelled") {
          setHint(res.message);
        }
        return;
      }
      if (res.needsPasswordSetup) {
        setGoogleAccount(res.account);
        setPassword("");
        setConfirmPassword("");
        setPasswordSetupOpen(true);
        return;
      }
      onSuccess(res.account);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [api, googleSignInAvailable, onSuccess]);

  const handleSetPassword = useCallback(async () => {
    if (!api?.communitySetPassword) {
      return;
    }
    if (!password || !confirmPassword) {
      setHint("Please enter and confirm your password.");
      return;
    }
    if (password !== confirmPassword) {
      setHint("The passwords do not match.");
      return;
    }
    setHint(null);
    setBusy("password");
    try {
      const res = await api.communitySetPassword({ password });
      if (!res.ok) {
        setHint(res.message);
        return;
      }
      onSuccess(res.account || googleAccount);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [api, confirmPassword, googleAccount, onSuccess, password]);

  const handleCancelGoogleLogin = useCallback(async () => {
    if (!api?.communityCancelGoogleLogin || busy !== "google") {
      return;
    }
    setBusy("google-cancelling");
    try {
      await api.communityCancelGoogleLogin();
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
      setBusy("google");
    }
  }, [api, busy]);

  const handleClose = useCallback(async () => {
    if (busy === "google") {
      if (!api?.communityCancelGoogleLogin) {
        return;
      }
      setBusy("google-cancelling");
      try {
        await api.communityCancelGoogleLogin();
      } catch (e) {
        setHint(e instanceof Error ? e.message : String(e));
        setBusy("google");
        return;
      }
    }
    onClose();
  }, [api, busy, onClose]);

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
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="deploy-auth-title" className="ui-panel-title">
              {passwordSetupOpen ? "Set your password" : title}
            </h2>
            <p className="mt-1 text-[13px] text-[var(--color-text-subtle)]">
              {passwordSetupOpen
                ? "Add a password to use email and password sign-in in the future."
                : description}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 cursor-pointer appearance-none items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--color-text-muted)] transition-colors hover:enabled:bg-[var(--color-emulator-toolbar-bg-hover)] hover:enabled:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={busy === "google-cancelling"}
            data-analytics-id="community_auth_close"
            data-analytics-area="community_auth"
            onClick={() => void handleClose()}
            aria-label="Close sign-in"
            title="Close sign-in"
          >
            <X size={16} strokeWidth={2.25} aria-hidden />
          </button>
        </div>

        {passwordSetupOpen ? (
          <>
            <p className="rounded-[var(--radius-sm)] bg-[var(--color-emulator-toolbar-bg)] px-3 py-2 text-[13px] text-[var(--color-text-subtle)]">
              {googleAccount}
            </p>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-[var(--color-text-subtle)]">New password</span>
              <input
                type="password"
                className="ui-input"
                autoComplete="new-password"
                value={password}
                disabled={busy !== null}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-[var(--color-text-subtle)]">Confirm password</span>
              <input
                type="password"
                className="ui-input"
                autoComplete="new-password"
                value={confirmPassword}
                disabled={busy !== null}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleSetPassword();
                  }
                }}
              />
            </label>
          </>
        ) : (
          <>
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
          </>
        )}

        {hint ? (
          <p className="text-[13px] text-[var(--color-error-text)]" role="alert">
            {hint}
          </p>
        ) : null}

        <button
          type="button"
          className="ui-btn-primary"
          disabled={busy !== null}
          data-analytics-id="community_login_password"
          data-analytics-area="community_auth"
          onClick={() => void (passwordSetupOpen ? handleSetPassword() : handlePasswordLogin())}
        >
          {busy === "password" ? (passwordSetupOpen ? "Saving…" : "Signing in…") : (passwordSetupOpen ? "Set password" : "Sign in")}
        </button>

        {!passwordSetupOpen && (busy === "google" || busy === "google-cancelling") ? (
          <button
            type="button"
            className={cn(toolbarBtn, "h-10 w-full justify-center")}
            disabled={busy === "google-cancelling"}
            data-analytics-id="community_login_google_cancel"
            data-analytics-area="community_auth"
            onClick={() => void handleCancelGoogleLogin()}
          >
            {busy === "google-cancelling" ? "Cancelling…" : "Cancel Google sign-in"}
          </button>
        ) : !passwordSetupOpen ? (
          <button
            type="button"
            className="google-signin-brand-button"
            disabled={busy === "password" || !googleSignInAvailable}
            data-analytics-id="community_login_google"
            data-analytics-area="community_auth"
            onClick={() => void handleGoogleLogin()}
            aria-label="Sign in with Google"
          >
            <img className="google-signin-brand-button__logo" src={googleGLogo} alt="" draggable={false} />
            <span className="google-signin-brand-button__label">Sign in with Google</span>
          </button>
        ) : null}

        {allowSkip && !passwordSetupOpen ? (
          <button type="button" className={cn(toolbarBtn, "w-full justify-center")} disabled={busy !== null} data-analytics-id="community_auth_skip" data-analytics-area="community_auth" onClick={handleSkip}>
            Continue without account
          </button>
        ) : null}
      </div>
    </div>
  );
}
