"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  Check,
  ClockCounterClockwise,
  CopySimple,
  MagnifyingGlass,
  Play,
  X,
} from "@phosphor-icons/react";
import ExportMenu from "@/components/ExportMenu";
import PlayMode from "@/components/PlayMode";
import {
  deckVersionExportUrl,
  deckVersionSlideUrl,
  fetchDeckVersion,
  fetchDeckVersions,
  restoreDeckVersionRequest,
} from "@/lib/deckVersionClient";
import type { DeckVersionDetail, DeckVersionSummary, Project } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

function sourceClass(version: DeckVersionSummary) {
  return version.source === "manual" ? "manual" : version.source === "restore" ? "restore" : "ai";
}

export default function DeckVersionDialog({
  projectId,
  initialVersionId,
  initialSlideIndex,
  onClose,
  onRestored,
}: {
  projectId: string;
  initialVersionId?: string;
  initialSlideIndex?: number;
  onClose: () => void;
  onRestored: (project: Project) => void;
}) {
  const { locale, t } = useI18n();
  const [versions, setVersions] = useState<DeckVersionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeckVersionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [playing, setPlaying] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cacheRef = useRef(new Map<string, DeckVersionDetail>());
  const inFlightRef = useRef(new Map<string, Promise<DeckVersionDetail>>());

  const selectedVersion = versions.find((version) => version.id === selectedId) ?? versions[0] ?? null;
  const restoredFrom = selectedVersion?.restoreFromVersionId
    ? versions.find((version) => version.id === selectedVersion.restoreFromVersionId)
    : undefined;
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }), [locale]);
  const sourceLabel = useCallback((version: DeckVersionSummary) => {
    if (version.source === "manual") return t("versions.sourceManual");
    if (version.source === "restore") return t("versions.sourceRestore");
    return t("versions.sourceAi");
  }, [t]);
  const visibleVersions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    if (!query) return versions;
    return versions.filter((version) => [
      `v${version.version}`,
      version.label,
      version.prompt ?? "",
      sourceLabel(version),
      formatter.format(version.createdAt),
    ].join(" ").toLocaleLowerCase(locale).includes(query));
  }, [formatter, locale, search, sourceLabel, versions]);

  const primeDetail = useCallback((versionId: string) => {
    const cached = cacheRef.current.get(versionId);
    if (cached) return Promise.resolve(cached);
    const pending = inFlightRef.current.get(versionId);
    if (pending) return pending;
    const request = fetchDeckVersion(projectId, versionId)
      .then((next) => {
        cacheRef.current.set(versionId, next);
        return next;
      })
      .finally(() => inFlightRef.current.delete(versionId));
    inFlightRef.current.set(versionId, request);
    return request;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDeckVersions(projectId)
      .then((items) => {
        if (cancelled) return;
        setVersions(items);
        setSelectedId(
          items.find((version) => version.id === initialVersionId)?.id
            ?? items.find((version) => version.current)?.id
            ?? items[0]?.id
            ?? null,
        );
        setError("");
      })
      .catch((nextError) => {
        if (!cancelled) setError(String(nextError?.message ?? nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => { cancelled = true; };
  }, [initialVersionId, projectId]);

  useEffect(() => {
    setSelectedSlide(Math.max(0, (initialSlideIndex ?? 1) - 1));
    setPromptOpen(false);
    setConfirmRestore(false);
    setCopied(false);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const cached = cacheRef.current.get(selectedId);
    if (cached) {
      setDetail(cached);
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    primeDetail(selectedId)
      .then((next) => {
        if (!cancelled) {
          setDetail(next);
          setError("");
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(String(nextError?.message ?? nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  }, [initialSlideIndex, primeDetail, selectedId]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || playing) return;
      event.preventDefault();
      if (confirmRestore) setConfirmRestore(false);
      else if (promptOpen) setPromptOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [confirmRestore, onClose, playing, promptOpen]);

  const versionSlides = useMemo(() => {
    if (!detail || !selectedVersion || detail.version.id !== selectedVersion.id) return [];
    return detail.project.pages
      .filter((page) => page.image)
      .map((page) => ({
        index: page.index,
        title: page.title,
        url: deckVersionSlideUrl(projectId, selectedVersion.id, page.image),
        transition: page.transition ?? "none" as const,
        speakerNotes: page.speakerNotes,
      }));
  }, [detail, projectId, selectedVersion]);
  const currentSlide = versionSlides[Math.max(0, Math.min(selectedSlide, versionSlides.length - 1))];

  async function copyPrompt() {
    const prompt = selectedVersion?.prompt?.trim();
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("versions.copyFailed"));
    }
  }

  async function restoreSelected() {
    if (!selectedVersion || selectedVersion.current || restoring) return;
    setRestoring(true);
    setError("");
    try {
      const result = await restoreDeckVersionRequest(projectId, selectedVersion.id);
      onRestored(result.project);
      onClose();
    } catch (nextError: any) {
      setError(String(nextError?.message ?? nextError));
      setRestoring(false);
    }
  }

  const modal = (
    <div
      className="version-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !restoring) onClose();
      }}
    >
      <section className="version-dialog" role="dialog" aria-modal="true" aria-label={t("versions.title")}>
        <aside className="version-sidebar">
          <div className="version-sidebar-head">
            <div>
              <ClockCounterClockwise size={18} weight="duotone" />
              <span>
                <strong>{t("versions.title")}</strong>
                <small>{t("versions.count", { count: versions.length })}</small>
              </span>
            </div>
            {versions.length > 3 ? (
              <label className="version-search">
                <MagnifyingGlass size={14} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("versions.search")}
                  aria-label={t("versions.search")}
                />
              </label>
            ) : null}
          </div>
          <div className="version-list" role="listbox" aria-label={t("versions.listAria")}>
            {loading ? (
              [0, 1, 2, 3].map((item) => (
                <div className="version-list-skeleton" key={item} aria-hidden="true">
                  <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
                </div>
              ))
            ) : visibleVersions.length ? visibleVersions.map((version) => {
              const active = version.id === selectedVersion?.id;
              const prefetch = () => { void primeDetail(version.id); };
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  key={version.id}
                  className={`version-list-item${active ? " active" : ""}`}
                  onClick={() => setSelectedId(version.id)}
                  onMouseEnter={prefetch}
                  onFocus={prefetch}
                >
                  <span className="version-list-meta">
                    {version.current ? <i className="version-current">{t("versions.current")}</i> : null}
                    <i className={`version-source ${sourceClass(version)}`}>{sourceLabel(version)}</i>
                    <time>{formatter.format(version.createdAt)}</time>
                  </span>
                  <b>{version.prompt || version.label}</b>
                  <span className="version-list-foot">
                    v{version.version} · {t("versions.slides", { count: version.renderedCount })}
                    {version.restoreFromVersionId ? ` · ${t("versions.restored")}` : ""}
                  </span>
                </button>
              );
            }) : (
              <div className="version-empty">{search ? t("versions.noResults") : t("versions.empty")}</div>
            )}
          </div>
        </aside>

        <main className="version-main">
          <header className="version-main-head">
            <div className="version-selected-meta">
              {selectedVersion ? (
                <>
                  <span className={`version-source ${sourceClass(selectedVersion)}`}>{sourceLabel(selectedVersion)}</span>
                  {selectedVersion.current ? <span className="version-current">{t("versions.current")}</span> : null}
                  <strong>v{selectedVersion.version}</strong>
                  <time>{formatter.format(selectedVersion.createdAt)}</time>
                  {restoredFrom ? <em>{t("versions.restoredFrom", { version: restoredFrom.version })}</em> : null}
                </>
              ) : <strong>{t("versions.title")}</strong>}
            </div>
            <div className="version-main-actions">
              <button
                type="button"
                className={`version-action${promptOpen ? " active" : ""}`}
                disabled={!selectedVersion}
                onClick={() => setPromptOpen((open) => !open)}
              >
                {t("versions.prompt")}
              </button>
              <button
                type="button"
                className="version-action"
                disabled={!versionSlides.length || loadingDetail}
                onClick={() => setPlaying(true)}
              >
                <Play size={15} weight="fill" /> {t("versions.play")}
              </button>
              {selectedVersion ? (
                <ExportMenu
                  pdfUrl={deckVersionExportUrl(projectId, selectedVersion.id, "pdf")}
                  pptxUrl={deckVersionExportUrl(projectId, selectedVersion.id, "pptx")}
                  buttonClassName="version-action"
                  wrapperClassName="version-export-menu"
                />
              ) : null}
              {!selectedVersion?.current && selectedVersion ? (
                <button
                  type="button"
                  className="version-action primary"
                  disabled={loadingDetail || restoring}
                  onClick={() => setConfirmRestore(true)}
                >
                  <ArrowCounterClockwise size={15} /> {restoring ? t("versions.restoring") : t("versions.restore")}
                </button>
              ) : null}
              <button ref={closeRef} type="button" className="version-close" onClick={onClose} aria-label={t("versions.close")}>
                <X size={17} />
              </button>
            </div>
          </header>

          {promptOpen && selectedVersion ? (
            <section className="version-prompt-panel">
              <div>
                <strong>{t("versions.prompt")}</strong>
                <small>{selectedVersion.promptSource ? t(`versions.promptSource.${selectedVersion.promptSource}`) : ""}</small>
              </div>
              <p>{selectedVersion.prompt || t("versions.noPrompt")}</p>
              <button type="button" onClick={() => void copyPrompt()} disabled={!selectedVersion.prompt}>
                {copied ? <Check size={14} /> : <CopySimple size={14} />}
                {copied ? t("versions.copied") : t("versions.copyPrompt")}
              </button>
            </section>
          ) : null}

          {error ? <div className="version-error" role="alert">{error}</div> : null}
          <div className="version-preview-shell">
            {currentSlide ? (
              <>
                <button
                  type="button"
                  className="version-preview-nav previous"
                  onClick={() => setSelectedSlide((index) => Math.max(0, index - 1))}
                  disabled={selectedSlide <= 0}
                  aria-label={t("slide.previous")}
                ><CaretLeft size={19} /></button>
                <div className="version-preview-canvas" style={{ aspectRatio: detail?.project.config.aspect.replace(":", " / ") }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={currentSlide.url} alt={currentSlide.title} />
                  {loadingDetail ? <span className="version-preview-loading"><i className="spinner" /> {t("versions.loadingPreview")}</span> : null}
                </div>
                <button
                  type="button"
                  className="version-preview-nav next"
                  onClick={() => setSelectedSlide((index) => Math.min(versionSlides.length - 1, index + 1))}
                  disabled={selectedSlide >= versionSlides.length - 1}
                  aria-label={t("slide.next")}
                ><CaretRight size={19} /></button>
              </>
            ) : (
              <div className="version-preview-empty">
                {loading || loadingDetail ? <><span className="spinner" /> {t("versions.loadingPreview")}</> : t("versions.noRenderedSlides")}
              </div>
            )}
          </div>
          {versionSlides.length ? (
            <div className="version-filmstrip" aria-label={t("versions.slidesAria")}>
              {versionSlides.map((slide, index) => (
                <button
                  type="button"
                  key={`${selectedVersion?.id}-${slide.index}`}
                  className={index === selectedSlide ? "active" : ""}
                  onClick={() => setSelectedSlide(index)}
                  aria-label={`${slide.index}. ${slide.title}`}
                >
                  <span>{slide.index}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slide.url} alt="" />
                </button>
              ))}
            </div>
          ) : null}

          {confirmRestore && selectedVersion ? (
            <div className="version-restore-confirm" role="alertdialog" aria-modal="true" aria-label={t("versions.restoreConfirmTitle")}>
              <div>
                <ArrowCounterClockwise size={22} weight="duotone" />
                <span>
                  <strong>{t("versions.restoreConfirmTitle")}</strong>
                  <p>{t("versions.restoreConfirmBody", { version: selectedVersion.version })}</p>
                </span>
              </div>
              <footer>
                <button type="button" onClick={() => setConfirmRestore(false)} disabled={restoring}>{t("common.cancel")}</button>
                <button type="button" className="primary" onClick={() => void restoreSelected()} disabled={restoring}>
                  {restoring ? t("versions.restoring") : t("versions.restoreConfirm")}
                </button>
              </footer>
            </div>
          ) : null}
        </main>
      </section>
      {playing && versionSlides.length ? (
        <PlayMode
          slides={versionSlides}
          initialIndex={selectedSlide}
          projectId={`${projectId}:version:${selectedVersion?.id ?? "unknown"}`}
          deckTitle={`${detail?.project.title ?? selectedVersion?.title ?? ""} · v${selectedVersion?.version ?? ""}`}
          onClose={() => setPlaying(false)}
        />
      ) : null}
    </div>
  );

  return createPortal(modal, document.body);
}
