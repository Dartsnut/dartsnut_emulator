import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommunityAppSummary,
  CommunityCategoryOption,
  CommunityControlOption,
  CommunitySessionInfo,
  CommunitySizeOption,
  CommunitySubmitProgress,
  CommunityVersionSummary,
  CommunityWorkspaceDefaults,
  ProjectType
} from "@dartsnut/shared-ipc";
import {
  communityProjectMatchesWorkspace,
  communityVersionState,
  hasBlockingCommunityVersion,
  hasCommunityVersionNumber
} from "@dartsnut/shared-ipc";
import { isCommunityAuthSkippedForSession } from "./DeployAuthGate";
import {
  CommunityErrorSnackbar,
  isCommunityAuthFailure,
  shouldShowCommunityErrorSnackbar,
  type CommunityApiFailure
} from "./CommunityErrorSnackbar";
import { cn } from "./cn";
import { mergeCommunityVersionHistory, isSameCommunityVersion } from "../communityVersionHistory";

export type MyGamesPanelProps = {
  active: boolean;
  communitySession: CommunitySessionInfo;
  communitySessionVersion: number;
  communityWorkspaceRefreshKey: string;
  onCommunitySessionChange: () => Promise<void>;
  onAuthRequired: () => void;
  onSubmitProgress: (progress: CommunitySubmitProgress | null) => void;
};

type Screen = "portfolio" | "project" | "submit";

type StagedImage = {
  filePath: string;
  name: string;
  previewUrl: string;
  existingUrl?: string;
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

type ApiErrorSnackbarState = { message: string; detail?: string };
type VersionConflictState = { currentVersion: string; nextVersion: string };

const emptyWorkspace: CommunityWorkspaceDefaults = {
  eligible: false,
  appId: "",
  projectType: null,
  appName: "",
  version: "",
  description: "",
  widgetSize: ""
};

const inputClass = "ui-input h-10 min-h-10 w-full px-3 py-0 leading-none";
const textAreaClass = "ui-input min-h-24 w-full resize-none px-3 py-2 leading-relaxed";

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

function projectKey(project: Pick<CommunityAppSummary, "projectType" | "id">): string {
  return `${project.projectType}:${String(project.id)}`;
}

function projectLabel(projectType: ProjectType | null): string {
  return projectType === "widget" ? "Widget" : projectType === "game" ? "Game" : "Project";
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusTone(key: ReturnType<typeof communityVersionState>["key"]): string {
  switch (key) {
    case "review":
      return "border-amber-400/35 bg-amber-400/10 text-amber-700 dark:text-amber-200";
    case "rejected":
      return "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-200";
    case "approved":
      return "border-sky-400/35 bg-sky-400/10 text-sky-700 dark:text-sky-200";
    case "published":
      return "border-emerald-400/35 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200";
    case "withdrawn":
    case "revoked":
      return "border-edge bg-[var(--color-surface)] text-[var(--color-text-subtle)]";
    default:
      return "border-edge bg-[var(--color-surface)] text-[var(--color-text-muted)]";
  }
}

function revokeStaged(image: StagedImage | null): void {
  if (image?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
}

function stagedRemotePreview(url: string, index: number): StagedImage {
  const normalized = url.trim();
  return {
    filePath: "",
    name: `Previous preview ${index + 1}`,
    previewUrl: normalized,
    existingUrl: normalized
  };
}

export const MyGamesPanel = memo(function MyGamesPanel({
  active,
  communitySession,
  communitySessionVersion,
  communityWorkspaceRefreshKey,
  onCommunitySessionChange,
  onAuthRequired,
  onSubmitProgress
}: MyGamesPanelProps) {
  const api = window.dartsnutApi;
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const previewInputRef = useRef<HTMLInputElement | null>(null);
  const stagedImagesRef = useRef<{ icon: StagedImage | null; previews: StagedImage[] }>({ icon: null, previews: [] });
  const optimisticVersionsRef = useRef(new Map<string, CommunityVersionSummary[]>());
  const lastWorkspaceRefreshKeyRef = useRef(communityWorkspaceRefreshKey);

  const [screen, setScreen] = useState<Screen>("portfolio");
  const [apps, setApps] = useState<CommunityAppSummary[]>([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<CommunityVersionSummary[]>([]);
  const [workspace, setWorkspace] = useState<CommunityWorkspaceDefaults>(emptyWorkspace);
  const [gameCategories, setGameCategories] = useState<CommunityCategoryOption[]>([]);
  const [widgetCategories, setWidgetCategories] = useState<CommunityCategoryOption[]>([]);
  const [gameControls, setGameControls] = useState<CommunityControlOption[]>([]);
  const [widgetControls, setWidgetControls] = useState<CommunityControlOption[]>([]);
  const [widgetSizes, setWidgetSizes] = useState<CommunitySizeOption[]>([]);
  const [form, setForm] = useState<PublishForm>(() => defaultForm());
  const [icon, setIcon] = useState<StagedImage | null>(null);
  const [previews, setPreviews] = useState<StagedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<CommunityVersionSummary | null>(null);
  const [versionConflict, setVersionConflict] = useState<VersionConflictState | null>(null);
  const [versionUpdateError, setVersionUpdateError] = useState<string | null>(null);
  const [updatingVersion, setUpdatingVersion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiErrorSnackbar, setApiErrorSnackbar] = useState<ApiErrorSnackbarState | null>(null);

  useEffect(() => {
    stagedImagesRef.current = { icon, previews };
  }, [icon, previews]);

  useEffect(() => () => {
    revokeStaged(stagedImagesRef.current.icon);
    stagedImagesRef.current.previews.forEach(revokeStaged);
  }, []);

  const selectedProject = useMemo(
    () => apps.find((project) => projectKey(project) === selectedProjectKey) || null,
    [apps, selectedProjectKey]
  );
  const currentWorkspaceProject = useMemo(
    () => apps.find((project) => communityProjectMatchesWorkspace(project, workspace)) || null,
    [apps, workspace]
  );
  const sortedApps = useMemo(() => {
    const currentKey = currentWorkspaceProject ? projectKey(currentWorkspaceProject) : "";
    return [...apps].sort((a, b) => {
      if (projectKey(a) === currentKey) return -1;
      if (projectKey(b) === currentKey) return 1;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
  }, [apps, currentWorkspaceProject]);

  const submissionProject = screen === "submit" ? selectedProject : null;
  const submissionType = submissionProject?.projectType || workspace.projectType;
  const isNewProject = !submissionProject;
  const isWidget = submissionType === "widget";
  const categories = isWidget ? widgetCategories : gameCategories;
  const controls = isWidget ? widgetControls : gameControls;
  const workspaceMatchesSelection = communityProjectMatchesWorkspace(selectedProject, workspace);
  const blockingVersion = hasBlockingCommunityVersion(versions);
  const duplicateVersion = hasCommunityVersionNumber(versions, form.version);

  const applyAuthFailure = useCallback(async () => {
    await onCommunitySessionChange();
    if (!isCommunityAuthSkippedForSession()) onAuthRequired();
  }, [onAuthRequired, onCommunitySessionChange]);

  const surfaceApiFailure = useCallback(async (res: CommunityApiFailure, message?: string) => {
    if (isCommunityAuthFailure(res)) {
      await applyAuthFailure();
      return;
    }
    if (shouldShowCommunityErrorSnackbar(res)) {
      setApiErrorSnackbar({ message: message || res.message || "Community request failed.", detail: res.serverMessage?.trim() });
    }
  }, [applyAuthFailure]);

  const loadVersions = useCallback(async (project: CommunityAppSummary | null) => {
    if (!project || !api?.communityListAppVersions) {
      setVersions([]);
      return;
    }
    const key = projectKey(project);
    setVersionsLoading(true);
    try {
      const res = await api.communityListAppVersions({ projectType: project.projectType, appSystemId: project.id });
      if (!res.ok) {
        // Keep the currently rendered history intact. In particular, the
        // version endpoint may already have confirmed a just-submitted row.
        await surfaceApiFailure(res, `Failed to load ${projectLabel(project.projectType).toLowerCase()} versions.`);
        return;
      }
      const merged = mergeCommunityVersionHistory(
        res.versions,
        optimisticVersionsRef.current.get(key) || []
      );
      if (merged.pendingVersions.length) optimisticVersionsRef.current.set(key, merged.pendingVersions);
      else optimisticVersionsRef.current.delete(key);
      setVersions(merged.versions);
    } catch (cause) {
      // Do not clear the release rail after a successful submission merely
      // because the follow-up history request is temporarily unavailable.
      setApiErrorSnackbar({ message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setVersionsLoading(false);
    }
  }, [api, surfaceApiFailure]);

  const loadPublishOptions = useCallback(async () => {
    if (!active || !api?.communityGetPublishOptions || (!communitySession.loggedIn && isCommunityAuthSkippedForSession())) {
      setApps([]);
      setWorkspace(emptyWorkspace);
      setSelectedProjectKey(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.communityGetPublishOptions();
      if (!res.ok) {
        setApps([]);
        if (isCommunityAuthFailure(res)) await surfaceApiFailure(res);
        else await surfaceApiFailure(res, "Failed to load community projects.");
        return;
      }
      const nextApps = [...res.games, ...res.widgets];
      const currentProject = nextApps.find((project) => communityProjectMatchesWorkspace(project, res.workspace)) || null;
      setApps(nextApps);
      setWorkspace(res.workspace);
      setGameCategories(res.gameCategories);
      setWidgetCategories(res.widgetCategories);
      setGameControls(res.gameControls);
      setWidgetControls(res.widgetControls);
      setWidgetSizes(res.widgetSizes);
      setSelectedProjectKey((current) => {
        if (current && nextApps.some((project) => projectKey(project) === current)) return current;
        return currentProject ? projectKey(currentProject) : null;
      });
      setForm((current) => {
        const base = defaultForm(res.workspace);
        const projectType = res.workspace.projectType;
        const nextCategories = projectType === "widget" ? res.widgetCategories : res.gameCategories;
        const nextControls = projectType === "widget" ? res.widgetControls : res.gameControls;
        const sameWorkspace = current.appId === base.appId;
        return {
          ...(sameWorkspace ? current : base),
          appName: sameWorkspace ? current.appName : base.appName,
          appId: base.appId,
          version: sameWorkspace ? current.version : base.version,
          description: sameWorkspace ? current.description : base.description,
          categoryId: current.categoryId || String(nextCategories[0]?.id || ""),
          controlValues: current.controlValues.length ? current.controlValues : nextControls[0]?.value ? [nextControls[0].value] : [],
          widgetSize: current.widgetSize || base.widgetSize || String(res.widgetSizes[0]?.value || "")
        };
      });
    } catch (cause) {
      setApps([]);
      setApiErrorSnackbar({ message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, [active, api, communitySession.loggedIn, surfaceApiFailure]);

  useEffect(() => {
    void loadPublishOptions();
  }, [loadPublishOptions, communitySessionVersion, communityWorkspaceRefreshKey]);

  useEffect(() => {
    if (lastWorkspaceRefreshKeyRef.current === communityWorkspaceRefreshKey) return;
    lastWorkspaceRefreshKeyRef.current = communityWorkspaceRefreshKey;
    revokeStaged(icon);
    previews.forEach(revokeStaged);
    setIcon(null);
    setPreviews([]);
    setForm(defaultForm());
    setScreen("portfolio");
    setError(null);
    setNotice(null);
    setApiErrorSnackbar(null);
    setVersionConflict(null);
    setVersionUpdateError(null);
  }, [communityWorkspaceRefreshKey, icon, previews]);

  useEffect(() => {
    if ((screen === "project" || (screen === "submit" && selectedProject)) && selectedProject) {
      void loadVersions(selectedProject);
    }
  }, [loadVersions, screen, selectedProject]);

  function stageFile(file: File): StagedImage | null {
    const filePath = api?.assets.getPathForFile(file) || "";
    if (!filePath) {
      setError(`Could not read ${file.name}.`);
      return null;
    }
    return { filePath, name: file.name, previewUrl: URL.createObjectURL(file) };
  }

  function chooseIcon(file: File | null | undefined): void {
    if (!file) return;
    const staged = stageFile(file);
    if (!staged) return;
    revokeStaged(icon);
    setIcon(staged);
    setError(null);
  }

  function choosePreviews(files: FileList | null | undefined): void {
    if (!files?.length) return;
    const staged = Array.from(files).map(stageFile).filter((item): item is StagedImage => Boolean(item));
    setPreviews((current) => [...current, ...staged]);
    setError(null);
  }

  async function uploadImage(image: StagedImage): Promise<string | null> {
    if (image.existingUrl) return image.existingUrl;
    const res = await api.communityUploadNativeImage({ filePath: image.filePath });
    if (!res.ok) {
      await surfaceApiFailure(res, `Failed to upload ${image.name}.`);
      return null;
    }
    return res.url;
  }

  function openProject(project: CommunityAppSummary): void {
    setVersionConflict(null);
    setVersionUpdateError(null);
    setSelectedProjectKey(projectKey(project));
    setScreen("project");
    setNotice(null);
    setError(null);
  }

  function openNewProjectSubmission(): void {
    setVersionConflict(null);
    setVersionUpdateError(null);
    setSelectedProjectKey(null);
    setVersions([]);
    setForm((current) => ({ ...defaultForm(workspace), categoryId: current.categoryId, controlValues: current.controlValues }));
    setScreen("submit");
    setNotice(null);
    setError(null);
  }

  function openVersionSubmission(): void {
    if (!selectedProject || !workspaceMatchesSelection) return;
    setVersionConflict(null);
    setVersionUpdateError(null);
    const previousVersion = versions.find((version) => version.preview.length > 0) || null;
    if (!previews.length && previousVersion) {
      setPreviews(previousVersion.preview.map(stagedRemotePreview));
    }
    setForm((current) => ({
      ...current,
      appName: selectedProject.appName,
      appId: selectedProject.appId,
      version: workspace.version || current.version,
      description: workspace.description || current.description
    }));
    setScreen("submit");
    setNotice(previousVersion ? `Prefilled ${previousVersion.preview.length} preview image${previousVersion.preview.length === 1 ? "" : "s"} from v${previousVersion.version}.` : null);
    setError(null);
  }

  const submitDisabledReason = useMemo(() => {
    if (!workspace.eligible || !submissionType) return "Open a valid game or widget workspace first.";
    if (!isNewProject && !communityProjectMatchesWorkspace(submissionProject, workspace)) return "Open this project’s workspace to submit a version.";
    if (!isNewProject && blockingVersion) return "Withdraw the current draft or review before submitting another version.";
    if (!isNewProject && duplicateVersion) return `Version ${form.version.trim()} already exists. Choose a new version before submitting.`;
    if (!form.version.trim()) return "Set a version in conf.json.";
    if (!form.description.trim()) return "Add release notes.";
    if (!previews.length) return "Add at least one preview image.";
    if (isNewProject && (!form.appName.trim() || !form.appId.trim() || !form.categoryId.trim())) return "Complete the project details.";
    if (isNewProject && !form.controlValues.length) return "Choose at least one control type.";
    if (isNewProject && isWidget && !form.widgetSize.trim()) return "Choose a widget size.";
    if (isNewProject && !icon) return "Choose a project icon.";
    return null;
  }, [blockingVersion, duplicateVersion, form, icon, isNewProject, isWidget, previews.length, submissionProject, submissionType, workspace]);

  async function submitForReview(): Promise<void> {
    setError(null);
    setNotice(null);
    if (submitDisabledReason || !submissionType) {
      setError(submitDisabledReason || "Submission is not ready.");
      return;
    }
    const minPersonal = form.minPersonal ? Number(form.minPersonal) : null;
    const maxPersonal = form.maxPersonal ? Number(form.maxPersonal) : null;
    if (!isWidget && minPersonal && maxPersonal && minPersonal > maxPersonal) {
      setError("Min players cannot be greater than max players.");
      return;
    }

    setSubmitting(true);
    let targetProject = submissionProject;
    const progress = (stage: CommunitySubmitProgress["stage"], message: string) => onSubmitProgress({ stage, message });
    try {
      if (!targetProject) {
        progress("creating", "Uploading project icon...");
        const mainCover = icon ? await uploadImage(icon) : null;
        if (!mainCover) return;
        progress("creating", "Registering community project...");
        const create = await api.communityCreateApp({
          projectType: submissionType,
          mainCover,
          appName: form.appName.trim(),
          appId: form.appId.trim(),
          categoryId: form.categoryId,
          minPersonal: isWidget ? null : minPersonal,
          maxPersonal: isWidget ? null : maxPersonal,
          control: form.controlValues,
          widgetSize: isWidget ? form.widgetSize : undefined
        });
        if (!create.ok) {
          await surfaceApiFailure(create, `Failed to register ${projectLabel(submissionType).toLowerCase()} project.`);
          return;
        }
        targetProject = create.app;
        setApps((current) => current.some((project) => projectKey(project) === projectKey(create.app)) ? current : [create.app, ...current]);
        setSelectedProjectKey(projectKey(create.app));
      }

      progress("uploading", "Uploading preview images...");
      const previewUrls = await Promise.all(previews.map(uploadImage));
      if (previewUrls.some((url) => !url)) {
        setError("One or more preview images could not be uploaded.");
        return;
      }

      const submit = await api.communitySubmitAppVersion({
        projectType: submissionType,
        appSystemId: targetProject.id,
        version: form.version.trim(),
        description: form.description.trim(),
        fields: form.fields.trim(),
        preview: previewUrls.filter((url): url is string => Boolean(url))
      });
      if (!submit.ok) {
        await surfaceApiFailure(submit, `Failed to submit ${projectLabel(submissionType).toLowerCase()} version for review.`);
        return;
      }

      const completedProject = targetProject;
      const completedVersion = form.version.trim();
      const submittedAt = new Date().toISOString();
      const submittedVersion: CommunityVersionSummary = {
        id: submit.versionId ?? `pending:${projectKey(completedProject)}:${completedVersion}`,
        appSystemId: completedProject.id,
        projectType: completedProject.projectType,
        version: completedVersion,
        description: form.description.trim(),
        status: submit.status || "1",
        createdAt: submittedAt,
        updatedAt: submittedAt,
        reviewAction: "",
        reviewComment: "",
        reviewedAt: null,
        preview: previewUrls.filter((url): url is string => Boolean(url))
      };
      const completedProjectKey = projectKey(completedProject);
      const previousPending = optimisticVersionsRef.current.get(completedProjectKey) || [];
      optimisticVersionsRef.current.set(
        completedProjectKey,
        [submittedVersion, ...previousPending.filter((version) => !isSameCommunityVersion(version, submittedVersion))]
      );
      setVersions((current) => [submittedVersion, ...current.filter((version) => !isSameCommunityVersion(version, submittedVersion))]);
      previews.forEach(revokeStaged);
      setPreviews([]);
      revokeStaged(icon);
      setIcon(null);
      // Transition first: the new-project and new-version paths both return to this release rail.
      setSelectedProjectKey(projectKey(completedProject));
      setScreen("project");
      setNotice(`${projectLabel(submissionType)} version ${completedVersion} submitted for official review.`);
      // Refresh the portfolio and history after navigation; a transient refresh failure must not strand
      // the creator on the submission form after a successful server response.
      void (async () => {
        await loadPublishOptions();
        await loadVersions(completedProject);
      })();
    } finally {
      onSubmitProgress(null);
      setSubmitting(false);
    }
  }

  async function confirmVersionUpdate(): Promise<void> {
    if (!versionConflict || updatingVersion) return;
    const nextVersion = versionConflict.nextVersion.trim();
    if (!nextVersion) {
      setVersionUpdateError("Enter a new version.");
      return;
    }
    if (nextVersion.toLowerCase() === versionConflict.currentVersion.trim().toLowerCase()) {
      setVersionUpdateError("Choose a version different from the one the server rejected.");
      return;
    }
    setVersionUpdateError(null);
    setUpdatingVersion(true);
    try {
      const result = await api.communityUpdateWorkspaceVersion({ version: nextVersion });
      if (!result.ok) {
        setVersionUpdateError(result.message);
        return;
      }
      setWorkspace(result.workspace);
      setForm((current) => ({ ...current, version: result.workspace.version }));
      setVersionConflict(null);
      setVersionUpdateError(null);
      setError(null);
      setNotice(`Updated pyproject.toml to version ${result.workspace.version}. Submit again when ready.`);
    } finally {
      setUpdatingVersion(false);
    }
  }

  async function confirmWithdraw(): Promise<void> {
    if (!withdrawTarget) return;
    setWithdrawing(true);
    setError(null);
    try {
      const res = await api.communityWithdrawAppVersion({
        projectType: withdrawTarget.projectType,
        versionId: withdrawTarget.id
      });
      if (!res.ok) {
        await surfaceApiFailure(res, `Failed to withdraw version ${withdrawTarget.version}.`);
        return;
      }
      setNotice(`Version ${withdrawTarget.version} withdrawn. Bump the version in conf.json before submitting again.`);
      setWithdrawTarget(null);
      await loadVersions(selectedProject);
    } finally {
      setWithdrawing(false);
    }
  }

  if (!communitySession.loggedIn) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
        <p className="font-[family-name:var(--font-display)] text-base font-semibold text-[var(--color-text-primary)]">Community releases</p>
        <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-[var(--color-text-subtle)]">
          Sign in to submit projects, track review decisions, and read official feedback.
        </p>
        <button type="button" className="ui-btn-primary mt-4 min-h-10 px-4" data-analytics-id="community_auth_required" data-analytics-area="community" onClick={onAuthRequired}>Sign in</button>
      </section>
    );
  }

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-right-pane-bg)]">
      <header className="shrink-0 border-b border-edge px-3 py-3">
        <div className="flex items-center gap-2">
          {screen !== "portfolio" ? (
            <button
              type="button"
              className="ui-toolbar-btn h-8 w-8 shrink-0 px-0 text-base"
              aria-label="Back"
              onClick={() => {
                setError(null);
                setNotice(null);
                setScreen(screen === "submit" && selectedProject ? "project" : "portfolio");
              }}
            >
              ←
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-hint)]">
              {screen === "portfolio" ? "Creator portfolio" : screen === "submit" ? "Review submission" : projectLabel(selectedProject?.projectType || null)}
            </p>
            <h2 className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-text-strong)]">
              {screen === "portfolio"
                ? "Community releases"
                : screen === "submit"
                  ? `${isNewProject ? "Submit new" : "Submit new version ·"} ${isNewProject ? projectLabel(submissionType) : selectedProject?.appName || "project"}`
                  : selectedProject?.appName || "Project"}
            </h2>
          </div>
          {screen === "portfolio" ? (
            <button type="button" className="ui-toolbar-btn h-8 px-2 text-xs" disabled={loading} data-analytics-id="community_refresh" data-analytics-area="community" onClick={() => void loadPublishOptions()}>
              {loading ? "Loading" : "Refresh"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notice ? <div className="mx-3 mt-3 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs leading-relaxed text-emerald-700 dark:text-emerald-200">{notice}</div> : null}
        {error ? <div className="mx-3 mt-3 rounded-md border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--color-error-text)]">{error}</div> : null}

        {screen === "portfolio" ? (
          <div className="space-y-4 p-3 pb-6">
            <section className="community-workspace-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-neon-mint)]">Open workspace</p>
                  <h3 className="mt-1 truncate text-sm font-semibold text-[var(--color-text-strong)]">
                    {workspace.eligible ? workspace.appName || workspace.appId : "No publishable workspace"}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--color-text-subtle)]">
                    {workspace.eligible
                      ? `${projectLabel(workspace.projectType)} · ${workspace.appId} · v${workspace.version || "unset"}`
                      : "Open a project with a valid pyproject.toml to submit it."}
                  </p>
                </div>
                {workspace.eligible ? <span className="community-workspace-pulse" aria-hidden /> : null}
              </div>
              {workspace.eligible ? (
                <button
                  type="button"
                  className="ui-btn-primary mt-3 min-h-10 w-full px-3 text-[13px]"
                  onClick={() => currentWorkspaceProject ? openProject(currentWorkspaceProject) : openNewProjectSubmission()}
                >
                  {currentWorkspaceProject ? "Manage this project" : "Submit this workspace"}
                </button>
              ) : null}
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Your projects</h3>
                <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-hint)]">{apps.length}</span>
              </div>
              {loading ? (
                <p className="py-8 text-center text-xs text-[var(--color-text-subtle)]">Loading portfolio…</p>
              ) : !sortedApps.length ? (
                <div className="rounded-lg border border-dashed border-edge px-3 py-6 text-center text-xs leading-relaxed text-[var(--color-text-subtle)]">
                  Your submitted games and widgets will appear here.
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedApps.map((project) => {
                    const isCurrent = communityProjectMatchesWorkspace(project, workspace);
                    return (
                      <button
                        key={projectKey(project)}
                        type="button"
                        className={cn(
                          "group flex w-full items-center gap-3 rounded-lg border bg-[var(--color-surface-elevated)] p-2.5 text-left transition",
                          isCurrent ? "border-[var(--color-neon-coral-dim)] shadow-[inset_3px_0_0_var(--color-neon-coral)]" : "border-edge hover:border-[var(--color-border-strong)]"
                        )}
                        onClick={() => openProject(project)}
                      >
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-edge bg-[var(--color-surface)]">
                          {project.mainCover ? <img src={project.mainCover} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center font-[family-name:var(--font-display)] text-lg text-[var(--color-text-hint)]">{project.appName.slice(0, 1).toUpperCase()}</div>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{project.appName || project.appId}</span>
                            {isCurrent ? <span className="rounded bg-[var(--color-neon-coral-dim)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--color-text-strong)]">Open</span> : null}
                          </div>
                          <p className="mt-0.5 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-subtle)]">{projectLabel(project.projectType)} · {project.appId}</p>
                        </div>
                        <span className="text-[var(--color-text-hint)] transition group-hover:translate-x-0.5 group-hover:text-[var(--color-text-primary)]">›</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {screen === "project" && selectedProject ? (
          <div className="p-3 pb-6">
            <section className="flex items-center gap-3 rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-edge bg-[var(--color-surface)]">
                {selectedProject.mainCover ? <img src={selectedProject.mainCover} alt="" className="h-full w-full object-cover" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-hint)]">{selectedProject.appId}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-subtle)]">
                  {workspaceMatchesSelection ? `Open workspace · v${workspace.version || "unset"}` : "Open this project’s workspace to upload another version."}
                </p>
              </div>
            </section>

            {workspaceMatchesSelection ? (
              <button
                type="button"
                className="ui-btn-primary mt-3 min-h-10 w-full px-3 text-[13px]"
                disabled={versionsLoading || blockingVersion}
                onClick={openVersionSubmission}
              >
                {blockingVersion ? "Submission already active" : "Submit new version"}
              </button>
            ) : null}

            <div className="mb-3 mt-5 flex items-center justify-between">
              <div>
                <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-hint)]">Release rail</p>
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Version history</h3>
              </div>
              <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-hint)]">{versions.length}</span>
            </div>

            {versionsLoading ? (
              <p className="py-8 text-center text-xs text-[var(--color-text-subtle)]">Loading versions…</p>
            ) : !versions.length ? (
              <div className="rounded-lg border border-dashed border-edge px-3 py-6 text-center text-xs text-[var(--color-text-subtle)]">No versions submitted yet.</div>
            ) : (
              <div className="community-release-rail">
                {versions.map((version) => {
                  const state = communityVersionState(version.status, version.reviewAction);
                  const feedbackIsOfficial = Boolean(version.reviewComment) && (state.key === "rejected" || state.key === "revoked");
                  return (
                    <article key={String(version.id)} className={cn("community-release-entry", `community-release-entry--${state.key}`)}>
                      <span className="community-release-node" aria-hidden />
                      <div className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-[family-name:var(--font-mono)] text-sm font-semibold text-[var(--color-text-strong)]">v{version.version || "—"}</p>
                            <p className="mt-0.5 text-[10px] text-[var(--color-text-hint)]">{formatDate(version.updatedAt || version.createdAt)}</p>
                          </div>
                          <span className={cn("rounded-md border px-2 py-1 text-[10px] font-semibold", statusTone(state.key))}>{state.label}</span>
                        </div>
                        {version.description ? <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-subtle)]">{version.description}</p> : null}
                        {feedbackIsOfficial ? (
                          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2">
                            <p className="font-[family-name:var(--font-mono)] text-[9px] font-bold uppercase tracking-[0.14em] text-red-700 dark:text-red-200">Official review feedback</p>
                            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-red-800 dark:text-red-100">{version.reviewComment}</p>
                            {version.reviewedAt ? <p className="mt-1.5 text-[10px] text-red-700/70 dark:text-red-200/70">{formatDate(version.reviewedAt)}</p> : null}
                          </div>
                        ) : null}
                        {state.canWithdraw ? (
                          <button type="button" className="ui-toolbar-btn mt-3 h-8 w-full px-2 text-xs" onClick={() => setWithdrawTarget(version)}>
                            Withdraw submission
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {screen === "submit" ? (
          <div className="space-y-3 p-3 pb-28">
            {isNewProject ? (
              <section className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
                <div className="mb-3">
                  <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-neon-coral)]">Project registration</p>
                  <h3 className="mt-0.5 text-sm font-semibold text-[var(--color-text-primary)]">Identify this {projectLabel(submissionType).toLowerCase()}</h3>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Name<input className={inputClass} value={form.appName} maxLength={50} onChange={(event) => setForm((current) => ({ ...current, appName: event.target.value }))} /></label>
                  <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Project ID<input className={inputClass} value={form.appId} disabled /></label>
                  <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Category<select className={inputClass} value={form.categoryId} onChange={(event) => setForm((current) => ({ ...current, categoryId: event.target.value }))}><option value="">Select</option>{categories.map((category) => <option key={String(category.id)} value={String(category.id)}>{category.name}</option>)}</select></label>
                  {isWidget ? (
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Size<select className={inputClass} value={form.widgetSize} onChange={(event) => setForm((current) => ({ ...current, widgetSize: event.target.value }))}><option value="">Select</option>{widgetSizes.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}</select></label>
                  ) : (
                    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Control<select className={inputClass} value={form.controlValues[0] || ""} onChange={(event) => setForm((current) => ({ ...current, controlValues: event.target.value ? [event.target.value] : [] }))}><option value="">Select</option>{controls.map((control) => <option key={control.value} value={control.value}>{control.label}</option>)}</select></label>
                  )}
                  {isWidget ? (
                    <div className="col-span-2 rounded-md border border-edge bg-[var(--color-surface)] p-2">
                      <p className="mb-2 text-xs text-[var(--color-text-subtle)]">Controls</p>
                      <div className="grid grid-cols-2 gap-2">{controls.map((control) => <label key={control.value} className="flex items-center gap-2 text-xs text-[var(--color-text-primary)]"><input type="checkbox" checked={form.controlValues.includes(control.value)} onChange={(event) => setForm((current) => ({ ...current, controlValues: event.target.checked ? Array.from(new Set([...current.controlValues, control.value])) : current.controlValues.filter((value) => value !== control.value) }))} /><span className="truncate">{control.label}</span></label>)}</div>
                    </div>
                  ) : (
                    <><label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Min players<input type="number" min={1} max={16} className={inputClass} value={form.minPersonal} onChange={(event) => setForm((current) => ({ ...current, minPersonal: event.target.value }))} /></label><label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Max players<input type="number" min={1} max={16} className={inputClass} value={form.maxPersonal} onChange={(event) => setForm((current) => ({ ...current, maxPersonal: event.target.value }))} /></label></>
                  )}
                </div>
                <div className="mt-3">
                  <p className="mb-1 text-xs text-[var(--color-text-subtle)]">Project icon</p>
                  <button type="button" className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-dashed border-edge bg-[var(--color-surface)] text-xs text-[var(--color-text-subtle)] hover:border-[var(--color-neon-coral-dim)]" onClick={() => iconInputRef.current?.click()}>
                    {icon ? <img src={icon.previewUrl} alt="Selected project icon" className="h-full w-full object-cover" /> : "Choose icon"}
                  </button>
                </div>
              </section>
            ) : null}

            <section className="rounded-lg border border-edge bg-[var(--color-surface-elevated)] p-3">
              <div className="mb-3">
                <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-neon-mint)]">Version package</p>
                <h3 className="mt-0.5 text-sm font-semibold text-[var(--color-text-primary)]">Send for official review</h3>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-subtle)]">Publication is handled by the Dartsnut review team after approval.</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Version<input className={inputClass} value={form.version} disabled /></label>
                <div className="flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]"><span>Source</span><div className="flex h-10 items-center rounded-md border border-edge bg-[var(--color-surface)] px-3 font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">pyproject.toml · canonical</div></div>
                <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Release notes<textarea className={textAreaClass} value={form.description} maxLength={2000} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
                <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-text-subtle)]">Optional fields<textarea className={cn(textAreaClass, "min-h-16")} value={form.fields} maxLength={2000} onChange={(event) => setForm((current) => ({ ...current, fields: event.target.value }))} /></label>
              </div>
              {duplicateVersion ? (
                <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2.5 text-red-700 dark:text-red-200">
                  <p className="text-xs leading-relaxed">Version {form.version} already exists in project history. Choose a new version before submitting.</p>
                  <button
                    type="button"
                    className="mt-2 min-h-8 rounded-md border border-red-500/35 bg-red-500/10 px-2.5 text-xs font-semibold hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70"
                    onClick={() => {
                      setVersionConflict({ currentVersion: form.version.trim(), nextVersion: "" });
                      setVersionUpdateError(null);
                    }}
                  >
                    Change workspace version
                  </button>
                </div>
              ) : null}
              {blockingVersion ? <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-200">This project already has a draft or version under review. Withdraw it before uploading another version.</p> : null}

              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between"><p className="text-xs text-[var(--color-text-subtle)]">Preview images{previews.some((preview) => preview.existingUrl) ? " · previous release" : ""}</p><button type="button" className="ui-toolbar-btn h-7 px-2 text-xs" onClick={() => previewInputRef.current?.click()}>Add</button></div>
                <div className="grid grid-cols-3 gap-2">
                  {previews.map((preview, index) => (
                    <div key={`${preview.filePath}-${index}`} className="group relative aspect-square overflow-hidden rounded-md border border-edge bg-[var(--color-surface)]">
                      <img src={preview.previewUrl} alt={preview.name} className="h-full w-full object-cover" />
                      <button type="button" aria-label={`Remove ${preview.name}`} className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => { revokeStaged(preview); setPreviews((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}>Remove</button>
                    </div>
                  ))}
                  {!previews.length ? <button type="button" className="aspect-square rounded-md border border-dashed border-edge bg-[var(--color-surface)] text-xs text-[var(--color-text-subtle)]" onClick={() => previewInputRef.current?.click()}>Add preview</button> : null}
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {screen === "submit" ? (
        <div className="community-submit-dock">
          {submitDisabledReason ? <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-subtle)]">{submitDisabledReason}</p> : null}
          <button type="button" className="ui-btn-primary min-h-11 w-full px-3 text-[13px]" disabled={Boolean(submitDisabledReason) || submitting} data-analytics-id="community_submit" data-analytics-area="community" onClick={() => void submitForReview()}>
            {submitting ? "Submitting…" : "Submit for official review"}
          </button>
        </div>
      ) : null}

      <input ref={iconInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { chooseIcon(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <input ref={previewInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { choosePreviews(event.target.files); event.currentTarget.value = ""; }} />

      {versionConflict ? (
        <div className="community-confirm-layer" role="dialog" aria-modal="true" aria-labelledby="version-conflict-title">
          <div className="community-confirm-card">
            <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--color-neon-coral)]">Version conflict</p>
            <h3 id="version-conflict-title" className="mt-1 font-[family-name:var(--font-display)] text-base font-semibold text-[var(--color-text-strong)]">Choose a new version</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-subtle)]">Version {versionConflict.currentVersion} is already in project history. Confirming updates the open workspace in both places; your release notes and staged previews stay here.</p>
            <label className="mt-4 flex flex-col gap-1.5 text-xs text-[var(--color-text-subtle)]">
              New version
              <input
                autoFocus
                className={inputClass}
                value={versionConflict.nextVersion}
                placeholder="For example, 1.0.1"
                disabled={updatingVersion}
                onChange={(event) => {
                  setVersionConflict((current) => current ? { ...current, nextVersion: event.target.value } : current);
                  setVersionUpdateError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void confirmVersionUpdate();
                  if (event.key === "Escape" && !updatingVersion) {
                    setVersionConflict(null);
                    setVersionUpdateError(null);
                  }
                }}
              />
            </label>
            {versionUpdateError ? <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs leading-relaxed text-red-700 dark:text-red-200">{versionUpdateError}</p> : null}
            <div className="mt-3 rounded-md border border-edge bg-[var(--color-surface)] px-3 py-2 font-[family-name:var(--font-mono)] text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              <div>pyproject.toml → project.name</div>
              <div>pyproject.toml → project.version</div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" className="ui-toolbar-btn min-h-10 px-3 text-xs" disabled={updatingVersion} onClick={() => { setVersionConflict(null); setVersionUpdateError(null); }}>Keep current</button>
              <button type="button" className="ui-btn-primary min-h-10 px-3 text-xs" disabled={updatingVersion || !versionConflict.nextVersion.trim()} data-analytics-id="community_update_version" data-analytics-area="community" onClick={() => void confirmVersionUpdate()}>{updatingVersion ? "Updating…" : "Update both files"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {withdrawTarget ? (
        <div className="community-confirm-layer" role="dialog" aria-modal="true" aria-labelledby="withdraw-title">
          <div className="community-confirm-card">
            <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--color-neon-coral)]">Permanent withdrawal</p>
            <h3 id="withdraw-title" className="mt-1 font-[family-name:var(--font-display)] text-base font-semibold text-[var(--color-text-strong)]">Withdraw version {withdrawTarget.version}?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-subtle)]">It will remain in release history as Withdrawn and cannot be reused. Bump the version in conf.json before submitting again.</p>
            <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" className="ui-toolbar-btn min-h-10 px-3 text-xs" disabled={withdrawing} onClick={() => setWithdrawTarget(null)}>Keep in review</button><button type="button" className="min-h-10 rounded-md border border-red-500/40 bg-red-500/15 px-3 text-xs font-semibold text-red-700 hover:bg-red-500/20 dark:text-red-200" disabled={withdrawing} data-analytics-id="community_withdraw" data-analytics-area="community" onClick={() => void confirmWithdraw()}>{withdrawing ? "Withdrawing…" : "Withdraw"}</button></div>
          </div>
        </div>
      ) : null}

      <CommunityErrorSnackbar message={apiErrorSnackbar?.message ?? null} detail={apiErrorSnackbar?.detail} onDismiss={() => setApiErrorSnackbar(null)} />
    </section>
  );
});
