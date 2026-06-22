import { useCallback, useEffect, useState } from "react";
import type { CommunityGameSummary, CommunitySessionInfo } from "@dartsnut/shared-ipc";
import { isCommunityAuthSkippedForSession } from "./DeployAuthGate";

export type MyGamesPanelProps = {
  active: boolean;
  communitySession: CommunitySessionInfo;
  communitySessionVersion: number;
  onCommunitySessionChange: () => Promise<void>;
  onAuthRequired: () => void;
};

function gameTitle(game: CommunityGameSummary): string {
  return game.gameName || game.gameId || String(game.id);
}

function gameSubtitle(game: CommunityGameSummary): string {
  const parts = [game.gameId, game.status].map((part) => part.trim()).filter(Boolean);
  return parts.join(" · ");
}

export function MyGamesPanel({
  active,
  communitySession,
  communitySessionVersion,
  onCommunitySessionChange,
  onAuthRequired
}: MyGamesPanelProps) {
  const api = window.dartsnutApi;
  const [games, setGames] = useState<CommunityGameSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGames = useCallback(async () => {
    if (!active || !api?.communityListMyGames || (!communitySession.loggedIn && isCommunityAuthSkippedForSession())) {
      setGames([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.communityListMyGames();
      if (!res.ok) {
        setGames([]);
        if (res.authRequired || res.code === "session_expired") {
          await onCommunitySessionChange();
          if (!isCommunityAuthSkippedForSession()) {
            onAuthRequired();
          }
          setError(null);
          return;
        }
        setError(res.message);
        return;
      }
      setGames(res.games);
    } catch (e) {
      setGames([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [active, api, communitySession.loggedIn, onAuthRequired, onCommunitySessionChange]);

  useEffect(() => {
    void loadGames();
  }, [loadGames, communitySessionVersion]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2 className="ui-panel-title">My Games</h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-subtle)]">
            Submitted games for the signed-in community account.
          </p>
        </div>
        <button
          type="button"
          className="ui-toolbar-btn"
          disabled={loading}
          onClick={() => void loadGames()}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {communitySession.loggedIn ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-[var(--color-surface-elevated)] px-3 py-2 text-[13px]">
          <span className="text-[var(--color-text-subtle)]">
            Signed in as{" "}
            <span className="font-medium text-[var(--color-text-primary)]">
              {communitySession.account || "-"}
            </span>
          </span>
        </div>
      ) : null}

      {error ? (
        <p className="shrink-0 rounded-lg border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2 text-[13px] text-[var(--color-error-text)]">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="text-[13px] text-[var(--color-text-subtle)]">Loading games...</p>
        ) : games.length === 0 ? (
          <p className="text-[13px] text-[var(--color-text-subtle)]">
            No submitted games found for this account.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {games.map((game) => (
              <article
                key={`${game.id}-${game.gameId}`}
                className="grid grid-cols-[48px_1fr] gap-3 rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-2.5"
              >
                <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-edge bg-[var(--color-surface)]">
                  {game.mainCover ? (
                    <img
                      src={game.mainCover}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-[11px] font-semibold text-[var(--color-text-subtle)]">
                      GAME
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
                    {gameTitle(game)}
                  </h3>
                  {gameSubtitle(game) ? (
                    <p className="mt-0.5 truncate text-xs text-[var(--color-text-subtle)]">
                      {gameSubtitle(game)}
                    </p>
                  ) : null}
                  {game.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-subtle)]">
                      {game.description}
                    </p>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
