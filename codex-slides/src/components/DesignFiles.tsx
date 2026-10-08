"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowClockwise,
  Check,
  CircleNotch,
  ClipboardText,
  DownloadSimple,
  Eye,
  File,
  FileCode,
  FileImage,
  FileText,
  MagnifyingGlass,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Markdown } from "@/components/Markdown";
import { DesignFilePreview } from "@/components/DesignFilesPanel";
import type { DesignFile } from "@/lib/designFiles";
import {
  defaultDesignFileViewerMode,
  designFilePreviewKind,
  type DesignFileViewerMode,
} from "@/lib/designFilePreview";
import type { ProjectFileRecord } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

type ListState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";
type SaveOptions = { showSaving?: boolean };
type PendingSave = { value: string; showSaving: boolean };

function apiPath(projectId: string, filePath: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function utf8Size(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function KindIcon({ kind }: { kind: ProjectFileRecord["kind"] }) {
  if (kind === "image") return <FileImage size={20} />;
  if (kind === "code") return <FileCode size={20} />;
  if (kind === "document" || kind === "data") return <FileText size={20} />;
  return <File size={20} />;
}

function FileListSkeleton() {
  return (
    <div className="design-files-list-skeleton" aria-hidden="true">
      <span className="design-file-skeleton-heading" />
      {Array.from({ length: 5 }, (_, index) => (
        <div className="design-file-skeleton-row" key={index}>
          <span className="design-file-skeleton-icon" />
          <span className="design-file-skeleton-copy">
            <span />
            <span />
          </span>
        </div>
      ))}
    </div>
  );
}

function DocumentSkeleton({ preview = false }: { preview?: boolean }) {
  return (
    <div className={`design-file-document-skeleton${preview ? " preview" : ""}`} aria-hidden="true">
      <span className="design-file-skeleton-title" />
      {Array.from({ length: 9 }, (_, index) => (
        <span
          className={`design-file-skeleton-line line-${(index % 4) + 1}`}
          key={index}
        />
      ))}
    </div>
  );
}

function ViewerSkeleton() {
  return (
    <div className="design-file-viewer-frame design-file-viewer-loading" aria-hidden="true">
      <div className="design-file-toolbar design-file-toolbar-skeleton">
        <span className="design-file-skeleton-copy">
          <span />
          <span />
        </span>
        <span className="design-file-skeleton-status" />
      </div>
      <div className="design-file-content is-loading">
        <DocumentSkeleton />
      </div>
    </div>
  );
}

const JSON_PREVIEW_ITEM_LIMIT = 120;

function JsonPreviewValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <code className="null">null</code>;
  if (typeof value === "string") return <span className="string">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <code className={typeof value}>{String(value)}</code>;
  }
  if (depth >= 7) return <code>{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) {
    const visible = value.slice(0, JSON_PREVIEW_ITEM_LIMIT);
    return (
      <ol className="design-file-json-array">
        {visible.map((item, index) => (
          <li key={index}><JsonPreviewValue value={item} depth={depth + 1} /></li>
        ))}
        {value.length > visible.length ? <li className="truncated">+{value.length - visible.length}</li> : null}
      </ol>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const visible = entries.slice(0, JSON_PREVIEW_ITEM_LIMIT);
    return (
      <dl className="design-file-json-object">
        {visible.map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd><JsonPreviewValue value={item} depth={depth + 1} /></dd>
          </div>
        ))}
        {entries.length > visible.length ? (
          <div className="truncated"><dt>…</dt><dd>+{entries.length - visible.length}</dd></div>
        ) : null}
      </dl>
    );
  }
  return <code>{String(value)}</code>;
}

function JsonPreview({ source }: { source: string }) {
  try {
    return (
      <div className="design-file-rendered-document design-file-json-preview">
        <JsonPreviewValue value={JSON.parse(source)} />
      </div>
    );
  } catch {
    return <pre className="design-file-json-invalid"><code>{source}</code></pre>;
  }
}

export default function DesignFiles({
  projectId,
  title,
  onClose,
  headerPrefix,
  showProjectTitle = true,
  initialPath,
  selectionRequestKey,
  workflowFiles = [],
}: {
  projectId: string;
  title: string;
  onClose: () => void;
  headerPrefix?: ReactNode;
  showProjectTitle?: boolean;
  initialPath?: string;
  /** Changes whenever a chat artifact asks to reveal this path again. */
  selectionRequestKey?: number;
  /** Durable workflow snapshots used to restore the rich running-step previews. */
  workflowFiles?: DesignFile[];
}) {
  const { locale, t } = useI18n();
  const [files, setFiles] = useState<ProjectFileRecord[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [content, setContent] = useState("");
  const [listState, setListState] = useState<ListState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [viewerMode, setViewerMode] = useState<DesignFileViewerMode>("source");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [copiedPath, setCopiedPath] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const filesRef = useRef<ProjectFileRecord[]>([]);
  const selectedPathRef = useRef("");
  const preferredPathRef = useRef(initialPath ?? "");
  const listRequestRef = useRef(0);
  const contentRequestRef = useRef(0);
  const saveTimerRef = useRef<{ id: number; path: string } | null>(null);
  const draftsRef = useRef<Map<string, string>>(new Map());
  const savedTextRef = useRef<Map<string, string>>(new Map());
  const savedAtRef = useRef<Map<string, number>>(new Map());
  const saveInFlightRef = useRef<Set<string>>(new Set());
  const pendingSaveRef = useRef<Map<string, PendingSave>>(new Map());

  const selected = files.find((file) => file.path === selectedPath);
  const workflowFileMap = useMemo(
    () => new Map(workflowFiles.map((file) => [file.id, file])),
    [workflowFiles],
  );
  const workflowArtifactIds = useMemo(
    () => new Set(workflowFileMap.keys()),
    [workflowFileMap],
  );
  const previewKind = selected ? designFilePreviewKind(selected, workflowArtifactIds) : null;
  const workflowPreview = previewKind && workflowArtifactIds.has(previewKind as DesignFile["id"])
    ? workflowFileMap.get(previewKind as DesignFile["id"])
    : undefined;

  const updateFiles = useCallback((next: ProjectFileRecord[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const selectPath = useCallback((path: string) => {
    const changed = selectedPathRef.current !== path;
    selectedPathRef.current = path;
    preferredPathRef.current = path;
    if (changed) {
      const nextFile = filesRef.current.find((file) => file.path === path);
      const cachedDraft = draftsRef.current.get(path);
      setPreviewReady(false);
      setPreviewError(false);
      setContentError(false);
      setSaveState("idle");
      setSavedAt(savedAtRef.current.get(path) ?? null);
      if (nextFile?.editable && cachedDraft !== undefined) {
        setContent(cachedDraft);
        setContentLoading(false);
      } else {
        setContent("");
        setContentLoading(Boolean(nextFile?.editable));
      }
    }
    setSelectedPath(path);
  }, []);

  const refresh = useCallback(async (
    preferred?: string,
    options: { showSkeleton?: boolean } = {},
  ) => {
    const requestId = ++listRequestRef.current;
    const showSkeleton = options.showSkeleton ?? filesRef.current.length === 0;
    if (showSkeleton) setListState("loading");
    setRefreshing(!showSkeleton);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { cache: "no-store" });
      if (!response.ok) throw new Error("files request failed");
      const data = await response.json();
      if (!mountedRef.current || requestId !== listRequestRef.current) return;
      const next = (data.files ?? []) as ProjectFileRecord[];
      updateFiles(next);
      const requestedPath = preferred ?? preferredPathRef.current;
      const currentPath = selectedPathRef.current;
      const nextPath = next.some((file) => file.path === requestedPath)
        ? requestedPath
        : next.some((file) => file.path === currentPath)
          ? currentPath
          : next[0]?.path ?? "";
      selectPath(nextPath);
      setListState("ready");
    } catch {
      if (mountedRef.current && requestId === listRequestRef.current) setListState("error");
    } finally {
      if (mountedRef.current && requestId === listRequestRef.current) setRefreshing(false);
    }
  }, [projectId, selectPath, updateFiles]);

  const loadEditableContent = useCallback(async (path: string, force = false) => {
    const requestId = ++contentRequestRef.current;
    const draft = draftsRef.current.get(path);
    const saved = savedTextRef.current.get(path);
    const hasUnsavedDraft = draft !== undefined && saved !== undefined && draft !== saved;

    setContentError(false);
    setSaveState("idle");
    setSavedAt(savedAtRef.current.get(path) ?? null);

    if (draft !== undefined && (!force || hasUnsavedDraft)) {
      setContent(draft);
      setContentLoading(false);
      return;
    }

    setContentLoading(true);
    setContent("");
    try {
      const response = await fetch(apiPath(projectId, path), { cache: "no-store" });
      if (!response.ok) throw new Error("file request failed");
      const text = await response.text();
      if (
        !mountedRef.current
        || requestId !== contentRequestRef.current
        || selectedPathRef.current !== path
      ) return;
      savedTextRef.current.set(path, text);
      draftsRef.current.set(path, text);
      setContent(text);
      setContentLoading(false);
    } catch {
      if (
        mountedRef.current
        && requestId === contentRequestRef.current
        && selectedPathRef.current === path
      ) {
        setContentLoading(false);
        setContentError(true);
      }
    }
  }, [projectId]);

  const saveFile = useCallback((path: string, value: string, options: SaveOptions = {}) => {
    const run = async (nextValue: string, showSaving: boolean): Promise<void> => {
      if (savedTextRef.current.get(path) === nextValue) {
        if (mountedRef.current && selectedPathRef.current === path && showSaving) {
          setSaveState("saved");
        }
        return;
      }
      if (saveInFlightRef.current.has(path)) {
        const pending = pendingSaveRef.current.get(path);
        pendingSaveRef.current.set(path, {
          value: nextValue,
          showSaving: showSaving || pending?.showSaving === true,
        });
        return;
      }

      saveInFlightRef.current.add(path);
      if (mountedRef.current && selectedPathRef.current === path && showSaving) {
        setSaveState("saving");
      }

      try {
        const response = await fetch(apiPath(projectId, path), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: nextValue }),
        });
        if (!response.ok) throw new Error("save failed");

        const savedTime = Date.now();
        savedTextRef.current.set(path, nextValue);
        savedAtRef.current.set(path, savedTime);
        if (mountedRef.current) {
          const nextFiles = filesRef.current.map((file) => file.path === path
            ? { ...file, size: utf8Size(nextValue), updatedAt: new Date(savedTime).toISOString() }
            : file);
          updateFiles(nextFiles);
          if (selectedPathRef.current === path) {
            setSavedAt(savedTime);
            setSaveState("saved");
          }
        }
      } catch {
        if (mountedRef.current && selectedPathRef.current === path) setSaveState("error");
      } finally {
        saveInFlightRef.current.delete(path);
        const pending = pendingSaveRef.current.get(path);
        if (pending) {
          pendingSaveRef.current.delete(path);
          if (pending.value !== savedTextRef.current.get(path)) {
            await run(pending.value, pending.showSaving);
          }
        }
      }
    };

    void run(value, options.showSaving === true);
  }, [projectId, updateFiles]);

  const flushPath = useCallback((path: string) => {
    if (saveTimerRef.current?.path === path) {
      window.clearTimeout(saveTimerRef.current.id);
      saveTimerRef.current = null;
    }
    const latest = draftsRef.current.get(path);
    if (latest !== undefined && latest !== savedTextRef.current.get(path)) {
      saveFile(path, latest);
    }
  }, [saveFile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      contentRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    updateFiles([]);
    selectPath("");
    setFileQuery("");
    setDragActive(false);
    dragDepthRef.current = 0;
    preferredPathRef.current = initialPath ?? "";
    draftsRef.current.clear();
    savedTextRef.current.clear();
    savedAtRef.current.clear();
    setContent("");
    setContentError(false);
    setPreviewReady(false);
    setPreviewError(false);
    void refresh(initialPath, { showSkeleton: true });
    return () => {
      listRequestRef.current += 1;
      contentRequestRef.current += 1;
    };
    // The initial path is handled separately so chat-driven selections do not
    // tear down and reload the whole Design Files surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refresh, selectPath, updateFiles]);

  useEffect(() => {
    function handleDesignFilesChanged(event: Event) {
      const changedProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (changedProjectId && changedProjectId !== projectId) return;
      void refresh(undefined, { showSkeleton: false });
    }
    window.addEventListener("codex-slides:design-files-changed", handleDesignFilesChanged);
    return () => window.removeEventListener("codex-slides:design-files-changed", handleDesignFilesChanged);
  }, [projectId, refresh]);

  useEffect(() => {
    if (!initialPath) return;
    preferredPathRef.current = initialPath;
    if (filesRef.current.some((file) => file.path === initialPath)) {
      selectPath(initialPath);
    } else if (listState === "ready") {
      void refresh(initialPath, { showSkeleton: false });
    }
    // selectionRequestKey intentionally replays a request for the same path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, projectId, selectionRequestKey]);

  useEffect(() => {
    contentRequestRef.current += 1;
    setCopiedPath("");
    setPreviewReady(false);
    setPreviewError(false);
    setSaveState("idle");
    setSavedAt(selected ? savedAtRef.current.get(selected.path) ?? null : null);
    if (!selected?.editable) {
      setContent("");
      setContentLoading(false);
      setContentError(false);
      return;
    }
    void loadEditableContent(selected.path);
  }, [loadEditableContent, previewReloadKey, selected?.editable, selected?.path]);

  useEffect(() => {
    setViewerMode(defaultDesignFileViewerMode(previewKind));
    setPreviewReady(false);
    setPreviewError(false);
  }, [previewKind, selected?.path]);

  useEffect(() => {
    const path = selected?.editable ? selected.path : null;
    return () => {
      if (path) flushPath(path);
    };
  }, [flushPath, selected?.editable, selected?.path]);

  useEffect(() => {
    if (!selected?.editable || contentLoading || contentError) return undefined;
    const path = selected.path;
    draftsRef.current.set(path, content);
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current.id);
      saveTimerRef.current = null;
    }
    if (content === savedTextRef.current.get(path)) return undefined;
    const id = window.setTimeout(() => {
      saveTimerRef.current = null;
      const latest = draftsRef.current.get(path);
      if (latest !== undefined) saveFile(path, latest);
    }, 700);
    saveTimerRef.current = { id, path };
    return () => {
      if (saveTimerRef.current?.id === id) {
        window.clearTimeout(id);
        saveTimerRef.current = null;
      }
    };
  }, [content, contentError, contentLoading, saveFile, selected?.editable, selected?.path]);

  const normalizedFileQuery = fileQuery.trim().toLowerCase();
  const visibleFiles = useMemo(() => normalizedFileQuery
    ? files.filter((file) => `${file.name}\n${file.path}`.toLowerCase().includes(normalizedFileQuery))
    : files, [files, normalizedFileQuery]);
  const groups = useMemo(() => [
    { key: "generated", label: t("designFiles.generated"), files: visibleFiles.filter((file) => file.source === "generated") },
    { key: "uploaded", label: t("designFiles.uploads"), files: visibleFiles.filter((file) => file.source === "uploaded") },
  ], [t, visibleFiles]);

  async function uploadFiles(picked: File[]) {
    if (!picked.length || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setUploading(true);
    const form = new FormData();
    picked.forEach((file) => form.append("files", file));
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) {
        window.alert(data.error ?? t("designFiles.uploadFailed"));
        return;
      }
      const next = data.files as ProjectFileRecord[];
      updateFiles(next);
      setListState("ready");
      setFileQuery("");
      const latestUpload = next
        .filter((file) => file.source === "uploaded")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      selectPath(latestUpload?.path ?? next[0]?.path ?? "");
    } catch {
      window.alert(t("designFiles.uploadFailed"));
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    await uploadFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function hasDraggedFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (dragDepthRef.current === 0) dragDepthRef.current = 1;
    if (!dragActive) setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void uploadFiles(Array.from(event.dataTransfer.files ?? []));
  }

  async function handleRefresh() {
    await refresh(undefined, { showSkeleton: false });
    const path = selectedPathRef.current;
    const file = filesRef.current.find((item) => item.path === path);
    if (file?.editable) {
      void loadEditableContent(path, true);
    }
    if (file) {
      setPreviewReady(false);
      setPreviewError(false);
      setPreviewReloadKey((key) => key + 1);
    }
  }

  function handleContentChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!selected?.editable) return;
    const next = event.target.value;
    draftsRef.current.set(selected.path, next);
    setContent(next);
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || !selected?.editable) return;
    event.preventDefault();
    saveFile(selected.path, content, { showSaving: true });
  }

  function selectViewerMode(mode: DesignFileViewerMode) {
    if (mode === "preview" && mode !== viewerMode) {
      setPreviewReady(false);
      setPreviewError(false);
    }
    setViewerMode(mode);
  }

  async function copyFilePath() {
    if (!selected?.absolutePath) return;
    let copied = false;
    try {
      const desktop = (window as typeof window & {
        codexSlidesDesktop?: { copyText?: (value: string) => Promise<boolean> };
      }).codexSlidesDesktop;
      if (desktop?.copyText) {
        copied = await desktop.copyText(selected.absolutePath);
      } else {
        await navigator.clipboard.writeText(selected.absolutePath);
        copied = true;
      }
    } catch {
      const input = document.createElement("textarea");
      input.value = selected.absolutePath;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try {
        copied = document.execCommand("copy");
      } finally {
        input.remove();
      }
    }
    if (!copied) return;
    setCopiedPath(selected.path);
    window.setTimeout(() => {
      setCopiedPath((current) => current === selected.path ? "" : current);
    }, 1800);
  }

  const savedTime = savedAt == null
    ? null
    : new Date(savedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const saveLabel = saveState === "error"
    ? t("designFiles.saveFailed")
    : saveState === "saving"
      ? t("common.saving")
      : savedTime
        ? t("designFiles.autoSaved", { time: savedTime })
        : t("designFiles.autoSaveHint");
  const previewSrc = selected ? `${apiPath(projectId, selected.path)}?preview=${previewReloadKey}` : "";
  const downloadSrc = selected ? `${apiPath(projectId, selected.path)}?download=1` : "";
  const previewUsesFrame = previewKind === "html" || previewKind === "embed";
  const previewUsesImage = previewKind === "image";
  const previewUsesText = previewKind === "markdown" || previewKind === "json";
  const previewLoading = Boolean(
    selected
      && viewerMode === "preview"
      && ((previewUsesFrame || previewUsesImage)
        ? !previewReady && !previewError
        : previewUsesText && contentLoading),
  );
  const viewerLoading = viewerMode === "source" ? contentLoading : previewLoading;

  return (
    <section
      className={`design-files${dragActive ? " is-dragging" : ""}`}
      aria-label={t("designFiles.title")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="design-files-drop-overlay" aria-live="polite">
          <div>
            <UploadSimple size={24} weight="bold" />
            <strong>{t("designFiles.dropToUpload")}</strong>
            <span>{t("designFiles.dropToUploadHelp")}</span>
          </div>
        </div>
      ) : null}
      <header className="design-files-head">
        <div>
          {headerPrefix}
          <span className="design-files-heading">
            <strong>{t("designFiles.title")}</strong>
            {showProjectTitle ? <span>{title}</span> : null}
          </span>
        </div>
        <div className="design-files-actions">
          <button
            type="button"
            className={refreshing ? "is-loading" : ""}
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title={t("designFiles.refresh")}
            aria-label={t("designFiles.refresh")}
          >
            <ArrowClockwise size={17} />
          </button>
          <button
            type="button"
            className="design-files-upload"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <CircleNotch className="design-files-spinner" size={17} /> : <UploadSimple size={17} />}
            <span>{t("common.upload")}</span>
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={upload} />
          {!headerPrefix ? (
            <button type="button" onClick={onClose} title={t("designFiles.back")} aria-label={t("designFiles.back")}>
              <X size={18} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="design-files-body">
        <aside className="design-files-list" aria-busy={listState === "loading" || refreshing}>
          <div className="design-files-list-header">
            <div className="design-files-root">
              <span>{t("designFiles.project")}</span>
              <small aria-live="polite">
                {listState === "loading"
                  ? t("designFiles.loading")
                  : normalizedFileQuery
                    ? t("designFiles.searchResults", { count: visibleFiles.length })
                    : t(files.length === 1 ? "designFiles.fileCountOne" : "designFiles.fileCountMany", { count: files.length })}
              </small>
            </div>
            <div className="design-files-search">
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                type="search"
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setFileQuery("");
                }}
                placeholder={t("designFiles.searchPlaceholder")}
                aria-label={t("designFiles.searchLabel")}
              />
              {fileQuery ? (
                <button
                  type="button"
                  onClick={() => setFileQuery("")}
                  title={t("designFiles.clearSearch")}
                  aria-label={t("designFiles.clearSearch")}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="design-files-scroll" aria-label={t("designFiles.list")}>
            {listState === "loading" ? <FileListSkeleton /> : (
              <>
                {listState === "error" ? (
                  <div className="design-files-inline-error" role="alert">
                    <WarningCircle size={16} />
                    <span>{t("designFiles.loadFailed")}</span>
                    <button type="button" onClick={() => void refresh(undefined, { showSkeleton: files.length === 0 })}>
                      {t("designFiles.retry")}
                    </button>
                  </div>
                ) : null}
                {groups.map((group) => group.files.length > 0 && (
                  <div className="design-files-group" key={group.key}>
                    <h3>{group.label}<span>{group.files.length}</span></h3>
                    {group.files.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className={file.path === selectedPath ? "active" : ""}
                        aria-pressed={file.path === selectedPath}
                        title={file.name}
                        onClick={() => selectPath(file.path)}
                      >
                        <span className={`design-file-icon ${file.kind}`}><KindIcon kind={file.kind} /></span>
                        <span className="design-file-copy">
                          <strong>{file.name}</strong>
                          <small>{file.path.split("/").slice(0, -1).join(" / ")} · {sizeLabel(file.size)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {files.length === 0 && listState !== "error" ? (
                  <p className="design-files-empty">{t("designFiles.empty")}</p>
                ) : null}
                {files.length > 0 && visibleFiles.length === 0 && normalizedFileQuery ? (
                  <div className="design-files-no-results">
                    <MagnifyingGlass size={18} />
                    <span>{t("designFiles.noSearchResults")}</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>

        <main
          className="design-file-viewer"
          aria-busy={listState === "loading" || viewerLoading}
        >
          {listState === "loading" && !selected ? <ViewerSkeleton /> : !selected ? (
            <div className="design-file-placeholder">
              <File size={40} />
              <strong>{t("designFiles.select")}</strong>
              <span>{t("designFiles.selectHelp")}</span>
            </div>
          ) : (
            <div className="design-file-viewer-frame" key={`${selected.path}-${previewReloadKey}`}>
              <div className="design-file-toolbar">
                <div>
                  <strong title={selected.name}>{selected.name}</strong>
                  <span title={selected.path}>{selected.path}</span>
                </div>
                <div className="design-file-toolbar-actions">
                  {selected.editable && previewKind ? (
                    <div className="design-file-view-tabs" role="group" aria-label={t("designFiles.viewMode")}>
                      <button
                        type="button"
                        aria-pressed={viewerMode === "preview"}
                        className={viewerMode === "preview" ? "active" : ""}
                        onClick={() => selectViewerMode("preview")}
                      >
                        <Eye size={14} />
                        <span>{t("designFiles.preview")}</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={viewerMode === "source"}
                        className={viewerMode === "source" ? "active" : ""}
                        onClick={() => selectViewerMode("source")}
                      >
                        <FileCode size={14} />
                        <span>{t("designFiles.source")}</span>
                      </button>
                    </div>
                  ) : null}
                  {selected.editable && viewerMode === "source" ? (
                    <div className={`design-file-save-status ${saveState}`} aria-live="polite">
                      {saveState === "error" ? (
                        <button
                          type="button"
                          className="design-file-save-retry"
                          onClick={() => saveFile(selected.path, content, { showSaving: true })}
                          title={t("designFiles.retrySave")}
                        >
                          <WarningCircle size={15} />
                          <span>{saveLabel}</span>
                        </button>
                      ) : (
                        <span title={saveLabel}>
                          {saveState === "saving" ? <CircleNotch className="design-files-spinner" size={14} /> : null}
                          {saveState !== "saving" && savedTime ? <Check size={14} weight="bold" /> : null}
                          <span>{saveLabel}</span>
                        </span>
                      )}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={copiedPath === selected.path ? "is-copied" : ""}
                    onClick={() => void copyFilePath()}
                    title={selected.absolutePath}
                  >
                    {copiedPath === selected.path ? <Check size={15} weight="bold" /> : <ClipboardText size={15} />}
                    <span>{copiedPath === selected.path ? t("designFiles.pathCopied") : t("designFiles.copyPath")}</span>
                  </button>
                  <a href={downloadSrc} download={selected.name} title={t("designFiles.downloadNamed", { name: selected.name })}>
                    <DownloadSimple size={15} />
                    <span>{t("designFiles.download")}</span>
                  </a>
                  </div>
              </div>

              <div className={`design-file-content${viewerLoading ? " is-loading" : ""}`}>
                {viewerMode === "source" && selected.editable ? (
                  contentLoading ? <DocumentSkeleton /> : contentError ? (
                    <div className="design-file-content-error" role="alert">
                      <WarningCircle size={28} />
                      <strong>{t("designFiles.contentLoadFailed")}</strong>
                      <button type="button" onClick={() => void loadEditableContent(selected.path, true)}>
                        {t("designFiles.retry")}
                      </button>
                    </div>
                  ) : (
                    <textarea
                      value={content}
                      onChange={handleContentChange}
                      onKeyDown={handleEditorKeyDown}
                      spellCheck={false}
                      aria-label={t("designFiles.edit", { name: selected.name })}
                    />
                  )
                ) : workflowPreview ? (
                  <div className="design-file-workflow-preview">
                    <DesignFilePreview file={workflowPreview} />
                  </div>
                ) : previewKind === "markdown" ? (
                  contentLoading ? <DocumentSkeleton /> : contentError ? (
                    <div className="design-file-content-error" role="alert">
                      <WarningCircle size={28} />
                      <strong>{t("designFiles.contentLoadFailed")}</strong>
                      <button type="button" onClick={() => void loadEditableContent(selected.path, true)}>
                        {t("designFiles.retry")}
                      </button>
                    </div>
                  ) : (
                    <div className="design-file-rendered-document design-file-markdown-preview">
                      <Markdown source={content} className="assistant-markdown" />
                    </div>
                  )
                ) : previewKind === "json" ? (
                  contentLoading ? <DocumentSkeleton /> : contentError ? (
                    <div className="design-file-content-error" role="alert">
                      <WarningCircle size={28} />
                      <strong>{t("designFiles.contentLoadFailed")}</strong>
                      <button type="button" onClick={() => void loadEditableContent(selected.path, true)}>
                        {t("designFiles.retry")}
                      </button>
                    </div>
                  ) : <JsonPreview source={content} />
                ) : previewKind === "image" ? (
                  <>
                    {previewLoading ? <DocumentSkeleton preview /> : null}
                    {previewError ? (
                      <div className="design-file-content-error" role="alert">
                        <WarningCircle size={28} />
                        <strong>{t("designFiles.contentLoadFailed")}</strong>
                      </div>
                    ) : (
                      <img
                        className={previewReady ? "is-ready" : ""}
                        src={previewSrc}
                        alt={selected.name}
                        onLoad={() => setPreviewReady(true)}
                        onError={() => setPreviewError(true)}
                      />
                    )}
                  </>
                ) : previewKind === "html" || previewKind === "embed" ? (
                  <>
                    {previewLoading ? <DocumentSkeleton /> : null}
                    {previewError ? (
                      <div className="design-file-content-error" role="alert">
                        <WarningCircle size={28} />
                        <strong>{t("designFiles.contentLoadFailed")}</strong>
                      </div>
                    ) : (
                      <iframe
                        className={previewReady ? "is-ready" : ""}
                        src={previewSrc}
                        title={selected.name}
                        sandbox={previewKind === "html" ? "allow-scripts allow-downloads allow-forms allow-modals allow-popups" : undefined}
                        onLoad={() => setPreviewReady(true)}
                        onError={() => setPreviewError(true)}
                      />
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
