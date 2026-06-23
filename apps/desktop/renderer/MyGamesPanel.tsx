import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommunityAppSummary,
  CommunityCategoryOption,
  CommunityControlOption,
  CommunitySessionInfo,
  CommunitySizeOption,
  CommunityVersionSummary,
  CommunityWorkspaceDefaults,
  ProjectType
} from "@dartsnut/shared-ipc";
import { isCommunityAuthSkippedForSession } from "./DeployAuthGate";
import {
  CommunityErrorSnackbar,
  isCommunityAuthFailure,
  shouldShowCommunityErrorSnackbar,
  type CommunityApiFailure
} from "./CommunityErrorSnackbar";
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
  appName: string;
  appId: string;
  categoryId: string;
  minPersonal: string;
  maxPersonal: string;
  controlValues: string[];
  widgetSize: string;
  version: string;
  description: string;
  fields: string;
};

type ApiErrorSnackbarState = {
  message: string;
  detail?: string;
};

const emptyWorkspace: CommunityWorkspaceDefaults = {
  eligible: false,
  appId: "",
  projectType: null,
  appName: "",
  version: "",
  description: "",
  widgetSize: ""
};

const publishInputClass = "ui-input h-10 min-h-10 w-full px-3 py-0 leading-none";
const publishTextAreaClass = "ui-input min-h-24 w-full resize-none px-3 py-2 leading-relaxed";
const publishSubmitClass = cn(
  "ui-btn-primary mt-3 flex min-h-11 w-full items-center justify-center px-3 py-2 text-center text-[13px]",
  "enabled:shadow-[0_10px_26px_rgba(0,0,0,0.18)]",
  "disabled:border disabled:border-edge disabled:bg-[var(--color-surface)] disabled:shadow-none"
);

function defaultForm(workspace: CommunityWorkspaceDefaults = emptyWorkspace): PublishForm {
  return {
    appName: workspace.appName || workspace.appId || "",
    appId: workspace.appId || "",
    categoryId: "",
    minPersonal: "",
    maxPersonal: "",
    controlValues: [],
    widgetSize: workspace.widgetSize || "",
    version: workspace.version || "1.0.0",
    description: workspace.description || "",
    fields: ""
  };
}

function versionStatusLabel(status: string): string {
  switch (String(status)) {
    case "-2":
      return "Revoked";
    case "-1":
      return "Rejected";
    case "0":
      return "Pending Submit";
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

function formatDate(value: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function shortFileName(name: string): string {
  if (name.length <= 22) {
    return name;
  }
  return `${name.slice(0, 10)}...${name.slice(-9)}`;
}

function projectLabel(projectType: ProjectType | null): string {
  return projectType === "widget" ? "Widget" : projectType === "game" ? "Game" : "App";
}

export const MyGamesPanel = memo(function MyGamesPanel({
  active,
  communitySession,
  communitySessionVersion,
  onCommunitySessionChange,
  onAuthRequired
}: MyGamesPanelProps) {
  const api = window.dartsnutApi;
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const previewInputRef = useRef<HTMLInputElement | null>(null);
  const [apps, setApps] = useState<CommunityAppSummary[]>([]);
  const [gameCategories, setGameCategories] = useState<CommunityCategoryOption[]>([]);
  const [widgetCategories, setWidgetCategories] = useState<CommunityCategoryOption[]>([]);
  const [gameControls, setGameControls] = useState<CommunityControlOption[]>([]);
  const [widgetControls, setWidgetControls] = useState<CommunityControlOption[]>([]);
  const [widgetSizes, setWidgetSizes] = useState<CommunitySizeOption[]>([]);
  const [currentVersions, setCurrentVersions] = useState<CommunityVersionSummary[]>([]);
  const [workspace, setWorkspace] = useState<CommunityWorkspaceDefaults>(emptyWorkspace);
  const [form, setForm] = useState<PublishForm>(() => defaultForm());
  const [icon, setIcon] = useState<UploadTile | null>(null);
  const [previews, setPreviews] = useState<UploadTile[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawingVersionId, setWithdrawingVersionId] = useState<string | null>(null);
  const [submitStage, setSubmitStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiErrorSnackbar, setApiErrorSnackbar] = useState<ApiErrorSnackbarState | null>(null);

  const projectType = workspace.projectType;
  const isWidget = projectType === "widget";
  const categories = isWidget ? widgetCategories : gameCategories;
  const controls = isWidget ? widgetControls : gameControls;
  const activeApp = useMemo(
    () => apps.find((app) => app.projectType === projectType && app.appId === form.appId.trim()) || null,
    [apps, form.appId, projectType]
  );
  const hasVersionInReview = currentVersions.some((version) => String(version.status) === "1");

  const canSubmit = useMemo(() => {
    return Boolean(
      workspace.eligible &&
        projectType &&
        form.appName.trim() &&
        form.appId.trim() &&
        form.categoryId.trim() &&
        form.controlValues.length > 0 &&
        (!isWidget || form.widgetSize.trim()) &&
        form.version.trim() &&
        form.description.trim() &&
        icon?.url &&
        previews.some((preview) => preview.url)
    );
  }, [form, icon?.url, isWidget, previews, projectType, workspace.eligible]);

  const applyAuthFailure = useCallback(async () => {
    await onCommunitySessionChange();
    if (!isCommunityAuthSkippedForSession()) {
      onAuthRequired();
    }
  }, [onAuthRequired, onCommunitySessionChange]);

  const surfaceApiFailure = useCallback(
    async (res: CommunityApiFailure, message?: string) => {
      if (isCommunityAuthFailure(res)) {
        await applyAuthFailure();
        return;
      }
      if (shouldShowCommunityErrorSnackbar(res)) {
        const detail = res.serverMessage?.trim();
        setApiErrorSnackbar(message ? { message, detail } : { message: detail });
      }
    },
    [applyAuthFailure]
  );

  const loadPublishOptions = useCallback(async () => {
    if (!active || !api?.communityGetPublishOptions || (!communitySession.loggedIn && isCommunityAuthSkippedForSession())) {
      setApps([]);
      setCurrentVersions([]);
      setWorkspace(emptyWorkspace);
      setForm(defaultForm());
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.communityGetPublishOptions();
      if (!res.ok) {
        setApps([]);
        setCurrentVersions([]);
        if (isCommunityAuthFailure(res)) {
          await surfaceApiFailure(res);
          setError(null);
          return;
        }
        await surfaceApiFailure(res);
        return;
      }
      setApps([...res.games, ...res.widgets]);
      setCurrentVersions(res.currentVersions);
      setGameCategories(res.gameCategories);
      setWidgetCategories(res.widgetCategories);
      setGameControls(res.gameControls);
      setWidgetControls(res.widgetControls);
      setWidgetSizes(res.widgetSizes);
      setWorkspace(res.workspace);
      const nextProjectType = res.workspace.projectType;
      const nextCategories = nextProjectType === "widget" ? res.widgetCategories : res.gameCategories;
      const nextControls = nextProjectType === "widget" ? res.widgetControls : res.gameControls;
      const nextCategoryIds = new Set(nextCategories.map((category) => String(category.id)));
      const nextControlValues = new Set(nextControls.map((control) => control.value));
      const nextWidgetSizeValues = new Set(res.widgetSizes.map((size) => size.value));
      setForm((current) => {
        const base = defaultForm(res.workspace);
        const validControls = current.controlValues.filter((value) => nextControlValues.has(value));
        return {
          ...base,
          categoryId: nextCategoryIds.has(current.categoryId)
            ? current.categoryId
            : String(nextCategories[0]?.id || ""),
          controlValues: validControls.length ? validControls : nextControls[0]?.value ? [nextControls[0].value] : [],
          widgetSize: nextWidgetSizeValues.has(current.widgetSize)
            ? current.widgetSize
            : nextWidgetSizeValues.has(base.widgetSize)
              ? base.widgetSize
              : String(res.widgetSizes[0]?.value || "")
        };
      });
    } catch (e) {
      setApps([]);
      setApiErrorSnackbar({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [active, api, communitySession.loggedIn, surfaceApiFailure]);

  useEffect(() => {
    void loadPublishOptions();
  }, [loadPublishOptions, communitySessionVersion]);

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
        await surfaceApiFailure(res, "Failed to upload image.");
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

  function updateWidgetControl(value: string, checked: boolean) {
    setForm((current) => ({
      ...current,
      controlValues: checked
        ? Array.from(new Set([...current.controlValues, value]))
        : current.controlValues.filter((item) => item !== value)
    }));
  }

  async function submitForReview() {
    setError(null);
    setNotice(null);
    if (!workspace.eligible || !projectType) {
      setError("Open a valid game or widget workspace before submitting.");
      return;
    }
    if (!canSubmit || !icon?.url) {
      setError(`Fill in ${projectLabel(projectType).toLowerCase()} details, upload an icon, and add at least one preview image.`);
      return;
    }
    const minPersonal = form.minPersonal ? Number(form.minPersonal) : null;
    const maxPersonal = form.maxPersonal ? Number(form.maxPersonal) : null;
    if (!isWidget && minPersonal && maxPersonal && minPersonal > maxPersonal) {
      setError("Min players cannot be greater than max players.");
      return;
    }
    setSubmitting(true);
    try {
      setSubmitStage(activeApp ? "Using existing app record..." : "Creating app record...");
      const create = await api.communityCreateApp({
        projectType,
        mainCover: icon.url,
        appName: form.appName.trim(),
        appId: form.appId.trim(),
        categoryId: form.categoryId,
        minPersonal: isWidget ? null : minPersonal,
        maxPersonal: isWidget ? null : maxPersonal,
        control: form.controlValues,
        widgetSize: isWidget ? form.widgetSize : undefined
      });
      if (!create.ok) {
        await surfaceApiFailure(create, `Failed to create ${projectLabel(projectType).toLowerCase()} app.`);
        return;
      }
      setSubmitStage("Packaging workspace and submitting version...");
      const submit = await api.communitySubmitAppVersion({
        projectType,
        appSystemId: create.app.id,
        version: form.version.trim(),
        description: form.description.trim(),
        fields: form.fields.trim(),
        preview: previews.map((preview) => preview.url).filter(Boolean)
      });
      if (!submit.ok) {
        await surfaceApiFailure(submit, `Failed to submit ${projectLabel(projectType).toLowerCase()} version for review.`);
        return;
      }
      setNotice(`${projectLabel(projectType)} version ${form.version.trim()} submitted for review.`);
      await loadPublishOptions();
    } finally {
      setSubmitStage(null);
      setSubmitting(false);
    }
  }

  async function withdrawFromReview(version: CommunityVersionSummary) {
    if (!projectType || !activeApp) {
      setError("Could not resolve the app record for this submission.");
      return;
    }
    const versionId = String(version.id || "").trim();
    if (!versionId) {
      setError("Could not resolve the version id for this submission.");
      return;
    }
    setError(null);
    setNotice(null);
    setWithdrawingVersionId(versionId);
    try {
      const res = await api.communityWithdrawAppVersion({
        projectType,
        versionId: version.id,
        appSystemId: activeApp.id
      });
      if (!res.ok) {
        await surfaceApiFailure(res, `Failed to pull ${appLabel.toLowerCase()} version out of review.`);
        return;
      }
      setNotice(`${appLabel} version ${version.version || versionId} pulled out of review.`);
      await loadPublishOptions();
    } finally {
      setWithdrawingVersionId(null);
    }
  }

  const appLabel = projectLabel(projectType);
  const canShowSubmitForm = !hasVersionInReview;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h2 className="ui-panel-title">Community</h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-subtle)]">
            Submit the active game or widget workspace for community review.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {projectType ? (
            <span className="rounded-md border border-edge bg-[var(--color-surface-elevated)] px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--color-text-subtle)]">
              {projectType}
            </span>
          ) : null}
          <button
            type="button"
            className="ui-toolbar-btn"
            disabled={loading || submitting}
            onClick={() => void loadPublishOptions()}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

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
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">My Submissions</h3>
              <span className="text-xs text-[var(--color-text-subtle)]">{currentVersions.length}</span>
            </div>
            {loading ? (
              <p className="text-[13px] text-[var(--color-text-subtle)]">Loading submissions...</p>
            ) : !workspace.eligible || !projectType ? (
              <p className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] px-3 py-2 text-[13px] text-[var(--color-text-subtle)]">
                Open a game or widget workspace to view submissions for the current app id.
              </p>
            ) : !activeApp ? (
              <p className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] px-3 py-2 text-[13px] text-[var(--color-text-subtle)]">
                No app record exists yet for {form.appId || "this workspace"}.
              </p>
            ) : currentVersions.length === 0 ? (
              <p className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] px-3 py-2 text-[13px] text-[var(--color-text-subtle)]">
                No version submissions found for {activeApp.appName || activeApp.appId}.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {currentVersions.map((version) => (
                  <article
                    key={`${version.projectType}-${version.id}`}
                    className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-2.5"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
                          Version {version.version || String(version.id)}
                        </h3>
                        <p className="mt-0.5 truncate text-xs text-[var(--color-text-subtle)]">
                          {activeApp.appName || activeApp.appId}
                          {formatDate(version.createdAt) ? ` · ${formatDate(version.createdAt)}` : ""}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                          String(version.status) === "1"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : "bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
                        )}
                      >
                        {versionStatusLabel(version.status)}
                      </span>
                    </div>
                    {version.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-subtle)]">
                        {version.description}
                      </p>
                    ) : null}
                    {String(version.status) === "1" ? (
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          className="ui-toolbar-btn h-7 px-2 text-xs"
                          disabled={submitting || withdrawingVersionId === String(version.id)}
                          onClick={() => void withdrawFromReview(version)}
                        >
                          {withdrawingVersionId === String(version.id) ? "Pulling..." : "Pull out of review"}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </div>

          {hasVersionInReview ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
              A version is already in review for this {appLabel.toLowerCase()}. Pull it out of review to submit a new version.
            </p>
          ) : null}

          {canShowSubmitForm ? (
          <div className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                  Submit Current {appLabel}
                </h3>
                <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                  Creates a review version from this workspace.
                </p>
              </div>
              {activeApp ? (
                <span className="rounded-md bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-text-subtle)]">
                  Existing app
                </span>
              ) : null}
            </div>

            {!workspace.eligible ? (
              <p className="mt-3 rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-2 text-xs text-[var(--color-text-subtle)]">
                Open or create a game or widget workspace with a valid conf.json to enable submission.
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                {appLabel} Name
                <input
                  className={publishInputClass}
                  value={form.appName}
                  maxLength={50}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, appName: event.target.value }))}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                {appLabel} ID
                <input
                  className={publishInputClass}
                  value={form.appId}
                  maxLength={100}
                  disabled={!workspace.eligible || submitting}
                  onChange={(event) => setForm((current) => ({ ...current, appId: event.target.value }))}
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
              {isWidget ? (
                <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                  Widget Size
                  <select
                    className={publishInputClass}
                    value={form.widgetSize}
                    disabled={!workspace.eligible || submitting}
                    onChange={(event) => setForm((current) => ({ ...current, widgetSize: event.target.value }))}
                  >
                    <option value="">Select</option>
                    {widgetSizes.map((size) => (
                      <option key={size.value} value={size.value}>
                        {size.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                  Control
                  <select
                    className={publishInputClass}
                    value={form.controlValues[0] || ""}
                    disabled={!workspace.eligible || submitting}
                    onChange={(event) => setForm((current) => ({ ...current, controlValues: event.target.value ? [event.target.value] : [] }))}
                  >
                    <option value="">Select</option>
                    {controls.map((control) => (
                      <option key={control.value} value={control.value}>
                        {control.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {isWidget ? (
                <div className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">
                  Control
                  <div className="grid grid-cols-2 gap-1.5 rounded-md border border-edge bg-[var(--color-surface)] p-2">
                    {controls.map((control) => (
                      <label key={control.value} className="flex min-w-0 flex-row items-center gap-2 text-xs text-[var(--color-text-primary)]">
                        <input
                          type="checkbox"
                          checked={form.controlValues.includes(control.value)}
                          disabled={!workspace.eligible || submitting}
                          onChange={(event) => updateWidgetControl(control.value, event.target.checked)}
                        />
                        <span className="truncate">{control.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <>
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
                </>
              )}
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
              {submitting ? submitStage || "Submitting..." : `Submit ${appLabel} Version for Review`}
            </button>
          </div>
          ) : null}
        </div>
      </div>
      <CommunityErrorSnackbar
        message={apiErrorSnackbar?.message ?? null}
        detail={apiErrorSnackbar?.detail}
        onDismiss={() => setApiErrorSnackbar(null)}
      />
    </section>
  );
});
