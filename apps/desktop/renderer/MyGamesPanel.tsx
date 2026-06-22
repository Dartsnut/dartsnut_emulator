import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommunityGameCategoryOption,
  CommunityGameControlOption,
  CommunityGameSummary,
  CommunityGameWorkspaceDefaults,
  CommunitySessionInfo
} from "@dartsnut/shared-ipc";
import { isCommunityAuthSkippedForSession } from "./DeployAuthGate";
import { cn } from "./cn";

export type MyGamesPanelProps = {
  active: boolean;
  communitySession: CommunitySessionInfo;
  communitySessionVersion: number;
  onCommunitySessionChange: () => Promise<void>;
  onAuthRequired: () => void;
};

type UploadTile = {
  filePath: string;
  name: string;
  url: string;
  uploading: boolean;
  error: string | null;
};

type PublishForm = {
  gameName: string;
  gameId: string;
  categoryId: string;
  minPersonal: string;
  maxPersonal: string;
  controlValue: string;
  version: string;
  description: string;
  fields: string;
};

const emptyWorkspace: CommunityGameWorkspaceDefaults = {
  eligible: false,
  appId: "",
  projectType: null,
  gameName: "",
  version: "",
  description: ""
};

const publishInputClass = "ui-input h-10 min-h-10 w-full px-3 py-0 leading-none";
const publishTextAreaClass = "ui-input min-h-24 w-full resize-none px-3 py-2 leading-relaxed";
const publishSubmitClass = cn(
  "mt-3 flex min-h-11 w-full items-center justify-center rounded-md border px-3 py-2 text-center text-[13px] font-semibold transition-colors",
  "enabled:border-[var(--color-text-primary)] enabled:bg-[var(--color-text-primary)] enabled:text-[var(--color-surface)]",
  "enabled:hover:opacity-90",
  "disabled:cursor-not-allowed disabled:border-edge disabled:bg-[var(--color-surface)] disabled:text-[var(--color-text-subtle)]"
);

function gameTitle(game: CommunityGameSummary): string {
  return game.gameName || game.gameId || String(game.id);
}

function gameSubtitle(game: CommunityGameSummary): string {
  const parts = [game.gameId, game.status].map((part) => part.trim()).filter(Boolean);
  return parts.join(" · ");
}

function defaultForm(workspace: CommunityGameWorkspaceDefaults = emptyWorkspace): PublishForm {
  return {
    gameName: workspace.gameName || workspace.appId || "",
    gameId: workspace.appId || "",
    categoryId: "",
    minPersonal: "",
    maxPersonal: "",
    controlValue: "",
    version: workspace.version || "1.0.0",
    description: workspace.description || "",
    fields: ""
  };
}

function isMissingAuth(res: { ok: boolean; authRequired?: boolean; code?: string }): boolean {
  return !res.ok && (res.authRequired || res.code === "session_expired");
}

function statusLabel(status: string): string {
  switch (String(status)) {
    case "-2":
      return "Revoked";
    case "-1":
      return "Rejected";
    case "0":
      return "Draft";
    case "1":
      return "In Review";
    case "2":
      return "Pending Publish";
    case "3":
      return "Approved";
    default:
      return status ? `Status ${status}` : "Created";
  }
}

function shortFileName(name: string): string {
  if (name.length <= 22) {
    return name;
  }
  return `${name.slice(0, 10)}...${name.slice(-9)}`;
}

export function MyGamesPanel({
  active,
  communitySession,
  communitySessionVersion,
  onCommunitySessionChange,
  onAuthRequired
}: MyGamesPanelProps) {
  const api = window.dartsnutApi;
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const previewInputRef = useRef<HTMLInputElement | null>(null);
  const [games, setGames] = useState<CommunityGameSummary[]>([]);
  const [categories, setCategories] = useState<CommunityGameCategoryOption[]>([]);
  const [controls, setControls] = useState<CommunityGameControlOption[]>([]);
  const [workspace, setWorkspace] = useState<CommunityGameWorkspaceDefaults>(emptyWorkspace);
  const [form, setForm] = useState<PublishForm>(() => defaultForm());
  const [icon, setIcon] = useState<UploadTile | null>(null);
  const [previews, setPreviews] = useState<UploadTile[]>([]);
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeGame = useMemo(
    () => games.find((game) => game.gameId === form.gameId.trim()) || null,
    [form.gameId, games]
  );

  const canSubmit = useMemo(() => {
    return Boolean(
      workspace.eligible &&
        form.gameName.trim() &&
        form.gameId.trim() &&
        form.categoryId.trim() &&
        form.controlValue.trim() &&
        form.version.trim() &&
        form.description.trim() &&
        icon?.url &&
        previews.some((preview) => preview.url)
    );
  }, [form, icon?.url, previews, workspace.eligible]);

  const applyAuthFailure = useCallback(async () => {
    await onCommunitySessionChange();
    if (!isCommunityAuthSkippedForSession()) {
      onAuthRequired();
    }
  }, [onAuthRequired, onCommunitySessionChange]);

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
        if (isMissingAuth(res)) {
          await applyAuthFailure();
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
  }, [active, api, applyAuthFailure, communitySession.loggedIn]);

  const loadPublishOptions = useCallback(async () => {
    if (!active || !api?.communityGetGamePublishOptions || (!communitySession.loggedIn && isCommunityAuthSkippedForSession())) {
      setCategories([]);
      setControls([]);
      setWorkspace(emptyWorkspace);
      setForm(defaultForm());
      return;
    }
    setOptionsLoading(true);
    try {
      const res = await api.communityGetGamePublishOptions();
      if (!res.ok) {
        if (isMissingAuth(res)) {
          await applyAuthFailure();
          return;
        }
        setError(res.message);
        return;
      }
      setCategories(res.categories);
      setControls(res.controls);
      setWorkspace(res.workspace);
      setForm((current) => ({
        ...defaultForm(res.workspace),
        categoryId: current.categoryId || String(res.categories[0]?.id || ""),
        controlValue: current.controlValue || String(res.controls[0]?.value || "")
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOptionsLoading(false);
    }
  }, [active, api, applyAuthFailure, communitySession.loggedIn]);

  useEffect(() => {
    void loadGames();
    void loadPublishOptions();
  }, [loadGames, loadPublishOptions, communitySessionVersion]);

  async function uploadImageFile(file: File): Promise<UploadTile> {
    const filePath = api.assets.getPathForFile(file);
    const pending: UploadTile = {
      filePath,
      name: file.name,
      url: "",
      uploading: true,
      error: null
    };
    if (!filePath) {
      return { ...pending, uploading: false, error: "Could not resolve file path." };
    }
    const res = await api.communityUploadNativeImage({ filePath });
    if (!res.ok) {
      if (isMissingAuth(res)) {
        await applyAuthFailure();
      }
      return { ...pending, uploading: false, error: res.message };
    }
    return { ...pending, url: res.url, uploading: false };
  }

  async function handleIconFile(file: File | null | undefined) {
    if (!file) {
      return;
    }
    setNotice(null);
    setIcon({ filePath: "", name: file.name, url: "", uploading: true, error: null });
    const uploaded = await uploadImageFile(file);
    setIcon(uploaded);
  }

  async function handlePreviewFiles(files: FileList | null | undefined) {
    if (!files?.length) {
      return;
    }
    setNotice(null);
    const selected = Array.from(files);
    const pending = selected.map<UploadTile>((file) => ({
      filePath: "",
      name: file.name,
      url: "",
      uploading: true,
      error: null
    }));
    setPreviews((current) => [...current, ...pending]);
    const uploaded = await Promise.all(selected.map((file) => uploadImageFile(file)));
    setPreviews((current) => [...current.slice(0, current.length - pending.length), ...uploaded]);
  }

  async function submitForReview() {
    setError(null);
    setNotice(null);
    if (!workspace.eligible) {
      setError("Open a valid game workspace before submitting.");
      return;
    }
    if (!canSubmit || !icon?.url) {
      setError("Fill in app details, upload an icon, and add at least one preview image.");
      return;
    }
    const minPersonal = form.minPersonal ? Number(form.minPersonal) : null;
    const maxPersonal = form.maxPersonal ? Number(form.maxPersonal) : null;
    if (minPersonal && maxPersonal && minPersonal > maxPersonal) {
      setError("Min players cannot be greater than max players.");
      return;
    }
    setSubmitting(true);
    try {
      setSubmitStage(activeGame ? "Using existing app record..." : "Creating app record...");
      const create = await api.communityCreateGame({
        mainCover: icon.url,
        gameName: form.gameName.trim(),
        gameId: form.gameId.trim(),
        gameCateId: form.categoryId,
        minPersonal,
        maxPersonal,
        control: [form.controlValue]
      });
      if (!create.ok) {
        if (isMissingAuth(create)) {
          await applyAuthFailure();
        }
        setError(create.message);
        return;
      }
      setSubmitStage("Packaging workspace and submitting version...");
      const submit = await api.communitySubmitGameVersion({
        gameSystemId: create.game.id,
        version: form.version.trim(),
        description: form.description.trim(),
        fields: form.fields.trim(),
        preview: previews.map((preview) => preview.url).filter(Boolean)
      });
      if (!submit.ok) {
        if (isMissingAuth(submit)) {
          await applyAuthFailure();
        }
        setError(submit.message);
        return;
      }
      setNotice(`Version ${form.version.trim()} submitted for review.`);
      await loadGames();
    } finally {
      setSubmitStage(null);
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2 className="ui-panel-title">My Games</h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-subtle)]">
            Submit the active game workspace for community review.
          </p>
        </div>
        <button
          type="button"
          className="ui-toolbar-btn"
          disabled={loading || optionsLoading || submitting}
          onClick={() => {
            void loadGames();
            void loadPublishOptions();
          }}
        >
          {loading || optionsLoading ? "Refreshing..." : "Refresh"}
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
          {workspace.projectType ? (
            <span className="rounded-md border border-edge bg-[var(--color-surface)] px-2 py-0.5 text-[11px] uppercase tracking-wide text-[var(--color-text-subtle)]">
              {workspace.projectType}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="shrink-0 rounded-lg border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2 text-[13px] text-[var(--color-error-text)]">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                  Submit Current Game
                </h3>
                <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                  Creates a review version from this workspace.
                </p>
              </div>
              {activeGame ? (
                <span className="rounded-md bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-text-subtle)]">
                  Existing app
                </span>
              ) : null}
            </div>

            {!workspace.eligible ? (
              <p className="mt-3 rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-2 text-xs text-[var(--color-text-subtle)]">
                Open or create a game workspace with a valid conf.json to enable submission.
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Game Name
                <input
                  className={publishInputClass}
                  value={form.gameName}
                  maxLength={50}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, gameName: event.target.value }))}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Game ID
                <input
                  className={publishInputClass}
                  value={form.gameId}
                  maxLength={100}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, gameId: event.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Category
                <select
                  className={publishInputClass}
                  value={form.categoryId}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, categoryId: event.target.value }))}
                >
                  <option value="">Select</option>
                  {categories.map((category) => (
                    <option key={String(category.id)} value={String(category.id)}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Control
                <select
                  className={publishInputClass}
                  value={form.controlValue}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, controlValue: event.target.value }))}
                >
                  <option value="">Select</option>
                  {controls.map((control) => (
                    <option key={control.value} value={control.value}>
                      {control.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Min Players
                <input
                  className={publishInputClass}
                  type="number"
                  min={1}
                  max={16}
                  value={form.minPersonal}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, minPersonal: event.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Max Players
                <input
                  className={publishInputClass}
                  type="number"
                  min={1}
                  max={16}
                  value={form.maxPersonal}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, maxPersonal: event.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Version
                <input
                  className={publishInputClass}
                  value={form.version}
                  maxLength={50}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Fields JSON
                <input
                  className={publishInputClass}
                  value={form.fields}
                  maxLength={1000}
                  placeholder="Optional"
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, fields: event.target.value }))}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                Review Notes
                <textarea
                  className={publishTextAreaClass}
                  value={form.description}
                  maxLength={255}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-[72px_1fr] gap-3">
              <div>
                <p className="mb-1 text-xs text-[var(--color-text-subtle)]">Icon</p>
                <button
                  type="button"
                  className={cn(
                    "flex aspect-square w-[72px] items-center justify-center overflow-hidden rounded-md border border-dashed border-edge bg-[var(--color-surface)] text-[11px] font-semibold text-[var(--color-text-subtle)]",
                    workspace.eligible && !submitting && "hover:border-[var(--color-text-primary)]"
                  )}
                  disabled={!workspace.eligible || submitting}
                  onClick={() => iconInputRef.current?.click()}
                >
                  {icon?.url ? (
                    <img src={icon.url} alt="" className="h-full w-full object-cover" />
                  ) : icon?.uploading ? (
                    "Uploading"
                  ) : (
                    "Choose"
                  )}
                </button>
                {icon?.error ? <p className="mt-1 text-[11px] text-[var(--color-error-text)]">{icon.error}</p> : null}
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-xs text-[var(--color-text-subtle)]">Preview Images</p>
                  <button
                    type="button"
                    className="ui-toolbar-btn h-7 px-2 text-xs"
                    disabled={!workspace.eligible || submitting}
                    onClick={() => previewInputRef.current?.click()}
                  >
                    Add
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {previews.map((preview, index) => (
                    <div
                      key={`${preview.name}-${index}`}
                      className="group relative aspect-square overflow-hidden rounded-md border border-edge bg-[var(--color-surface)]"
                      title={preview.name}
                    >
                      {preview.url ? (
                        <img src={preview.url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-[var(--color-text-subtle)]">
                          {preview.uploading ? "Uploading" : shortFileName(preview.name)}
                        </div>
                      )}
                      <button
                        type="button"
                        className="absolute right-1 top-1 hidden rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white group-hover:block"
                        disabled={submitting}
                        onClick={() => setPreviews((current) => current.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {!previews.length ? (
                    <button
                      type="button"
                      className="aspect-square rounded-md border border-dashed border-edge bg-[var(--color-surface)] text-[11px] text-[var(--color-text-subtle)]"
                      disabled={!workspace.eligible || submitting}
                      onClick={() => previewInputRef.current?.click()}
                    >
                      Add
                    </button>
                  ) : null}
                </div>
                {previews.some((preview) => preview.error) ? (
                  <p className="mt-1 text-[11px] text-[var(--color-error-text)]">
                    Some previews failed to upload. Remove them or add another image.
                  </p>
                ) : null}
              </div>
            </div>

            <input
              ref={iconInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                void handleIconFile(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={previewInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(event) => {
                void handlePreviewFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />

            <button
              type="button"
              className={publishSubmitClass}
              disabled={!canSubmit || submitting}
              onClick={() => void submitForReview()}
            >
              {submitting ? submitStage || "Submitting..." : "Submit Version for Review"}
            </button>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">Submitted Games</h3>
              <span className="text-xs text-[var(--color-text-subtle)]">{games.length}</span>
            </div>
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
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <h3 className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
                          {gameTitle(game)}
                        </h3>
                        <span className="shrink-0 rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-subtle)]">
                          {statusLabel(game.status)}
                        </span>
                      </div>
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
        </div>
      </div>
    </section>
  );
}
