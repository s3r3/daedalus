"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MagnifyingGlass, MagnifyingGlassPlus, X } from "@phosphor-icons/react";
import {
  COMMUNITY_GROUPS,
  COMMUNITY_TEMPLATES,
  getCommunityTemplate,
  getCommunitySource,
  inspireChips,
  matchCommunityTemplates,
  scoreCommunityTemplates,
  type CommunityTemplate,
} from "@/lib/community";
import { rankInspire } from "@/lib/deckEdit";
import { useI18n } from "@/i18n/I18nProvider";
import { COMMUNITY_GROUP_KEYS, COMMUNITY_QUERY_KEYS } from "@/i18n/community";
import InspirationLightbox from "@/components/InspirationLightbox";

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Inspiration browser (参考灵感) — the "Browse" popup opened from the in-chat
 * inspiration card. Community styles are pre-filtered against the deck topic +
 * outline (instant offline keyword rank, upgraded by a codex re-rank when it
 * returns), filterable by group, and freely searchable. Pick one (max 1) to
 * render with, or skip to use the default style.
 */
export default function InspireDialog({
  requirement,
  outlineTitles,
  selected,
  intent = "generate",
  onClose,
  onSkip,
  onSubmit,
}: {
  requirement: string;
  outlineTitles: string[];
  selected?: string;
  intent?: "select" | "generate" | "apply";
  onClose: () => void;
  onSkip?: () => void;
  onSubmit: (templateId: string) => void;
}) {
  const { t: tr } = useI18n();
  const matchQuery = useMemo(
    () => [requirement, ...outlineTitles].filter(Boolean).join(" "),
    [requirement, outlineTitles],
  );
  // Instant offline order first; codex re-ranks it when it returns.
  const [order, setOrder] = useState<string[]>(() =>
    matchCommunityTemplates(matchQuery).map((t) => t.id),
  );
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [ranking, setRanking] = useState(true);
  const [group, setGroup] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | undefined>(selected);
  const [previewId, setPreviewId] = useState<string>();
  const chips = useMemo(() => inspireChips(matchQuery), [matchQuery]);
  const ranReq = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc closes this dialog unless its image-browser layer is open.
  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !previewId) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, previewId]);

  // Codex re-rank (best effort — the offline order stays if it fails).
  useEffect(() => {
    if (ranReq.current) return;
    ranReq.current = true;
    if (!matchQuery.trim()) {
      setRanking(false);
      return;
    }
    let alive = true;
    rankInspire(requirement, outlineTitles)
      .then((res) => {
        if (!alive) return;
        if (res.ranked?.length) setOrder(res.ranked);
        if (res.reasons) setReasons(res.reasons);
      })
      .catch(() => {
        /* keep the offline order */
      })
      .finally(() => {
        if (alive) setRanking(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ordered = useMemo(() => {
    const byId = new Map(COMMUNITY_TEMPLATES.map((t) => [t.id, t]));
    const list = order.map((id) => byId.get(id)).filter(Boolean) as CommunityTemplate[];
    for (const t of COMMUNITY_TEMPLATES) if (!order.includes(t.id)) list.push(t);
    return list;
  }, [order]);

  const q = search.trim().toLowerCase();
  const searchScores = useMemo(
    () => new Map(
      q
        ? scoreCommunityTemplates(q).map(({ t, score }) => [t.id, score] as const)
        : [],
    ),
    [q],
  );
  const visible = ordered
    .filter((t) => {
      if (group !== "all" && t.group !== group) return false;
      if (!q) return true;
      const sources = (t.sourceIds ?? [])
        .map((sourceId) => getCommunitySource(sourceId)?.name ?? sourceId)
        .join(" ");
      const directMatch = [t.name, t.group, t.description, t.author, t.tags.join(" "), sources]
        .join(" ")
        .toLowerCase()
        .includes(q);
      return directMatch || (searchScores.get(t.id) ?? 0) > 0;
    })
    .sort((a, b) => q
      ? (searchScores.get(b.id) ?? 0) - (searchScores.get(a.id) ?? 0)
      : 0);

  const pickedTpl = getCommunityTemplate(picked);
  const pickedSource = pickedTpl?.sourceIds?.map(getCommunitySource).find(Boolean);
  const submitLabel = pickedTpl
    ? intent === "select"
      ? tr("inspire.selectNamed", { name: pickedTpl.name })
      : intent === "apply"
        ? tr("inspire.applyNamed", { name: pickedTpl.name })
        : tr("inspire.generateNamed", { name: pickedTpl.name })
    : tr("inspire.choose");

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="inspire-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="inspire-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspire-dialog-title"
      >
        <header className="inspire-dialog-head">
          <div className="inspire-search-wrap">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              className="inspire-dialog-search"
              placeholder={tr("inspire.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={tr("inspire.searchLabel")}
              autoFocus
            />
            {search && (
              <button
                type="button"
                className="inspire-search-clear"
                onClick={() => setSearch("")}
                aria-label={tr("inspire.clear")}
              >
                ×
              </button>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="inspire-dialog-close"
            onClick={onClose}
            aria-label={tr("inspire.close")}
          >
            <X size={18} weight="bold" />
          </button>
        </header>

        <div className="inspire-dialog-filters">
          <div className="inspire-try">
            <span className="inspire-try-label">{tr("inspire.try")}</span>
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                className="inspire-try-chip"
                onClick={() => setSearch(c)}
              >
                {COMMUNITY_QUERY_KEYS[c] ? tr(COMMUNITY_QUERY_KEYS[c]) : c}
              </button>
            ))}
            <span id="inspire-dialog-title" className="inspire-rank-note">
              {ranking ? (
                <>
                  {tr("inspire.ranking")}<span className="spinner sm" />
                </>
              ) : (
                <>{tr("inspire.ranked")} · {tr("inspire.libraryCount", { count: visible.length })}</>
              )}
            </span>
          </div>
          <div className="community-groups" role="tablist" aria-label={tr("community.filter")}>
            <button
              type="button"
              className={`group-chip ${group === "all" ? "on" : ""}`}
              role="tab"
              aria-selected={group === "all"}
              onClick={() => setGroup("all")}
            >
              {tr("community.all")}
            </button>
            {COMMUNITY_GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                className={`group-chip ${group === g ? "on" : ""}`}
                role="tab"
                aria-selected={group === g}
                onClick={() => setGroup(g)}
              >
                {tr(COMMUNITY_GROUP_KEYS[g])}
              </button>
            ))}
          </div>
        </div>

        <div className="inspire-dialog-grid">
          {visible.map((t, i) => {
            const ground = [...t.palette].sort((a, b) => lum(a) - lum(b))[0];
            const reason = reasons[t.id];
            const source = t.sourceIds?.map(getCommunitySource).find(Boolean);
            const recommended = !ranking && group === "all" && !q && i < 3;
            return (
              <button
                key={t.id}
                type="button"
                className={`tpl-card inspire-card ${picked === t.id ? "on" : ""}`}
                onClick={() => setPreviewId(t.id)}
                title={t.description}
                aria-label={tr("inspire.previewNamed", { name: t.name })}
              >
                <div className="tpl-cover" style={{ background: ground }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.cover} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
                  {recommended && <span className="inspire-badge">{tr("inspire.recommended")}</span>}
                  <span className="inspire-card-expand" aria-hidden="true">
                    <MagnifyingGlassPlus size={17} weight="bold" />
                  </span>
                  <span className="tpl-selected" aria-hidden="true">
                    ✓
                  </span>
                </div>
                <div className="tpl-info">
                  <div>
                    <div className="tpl-meta">{t.name}</div>
                    <div className="tpl-cat">
                      {tr(COMMUNITY_GROUP_KEYS[t.group])}
                      {source ? ` · ${source.name}` : ""}
                    </div>
                  </div>
                  <span className="inspire-palette" aria-hidden="true">
                    {t.palette.slice(0, 4).map((c) => (
                      <span key={c} style={{ background: c }} />
                    ))}
                  </span>
                </div>
                <div className="inspire-card-description">{t.description}</div>
                {reason && <div className="inspire-reason">{reason}</div>}
              </button>
            );
          })}
          {!visible.length && (
            <div className="inspire-empty">{tr("inspire.empty")}</div>
          )}
        </div>

        <footer className="inspire-dialog-foot">
          {pickedTpl ? (
            <div className="inspire-foot-selection">
              <strong>{pickedTpl.name}</strong>
              <span>{pickedTpl.description}</span>
              {pickedSource ? (
                <a href={pickedTpl.sourceUrl ?? pickedSource.url} target="_blank" rel="noreferrer">
                  {tr("inspire.sourceMeta", { source: pickedSource.name, license: pickedSource.license })}
                </a>
              ) : null}
            </div>
          ) : (
            <span className="inspire-foot-hint">{tr("inspire.pickOne")}</span>
          )}
          <div className="inspire-foot-actions">
            {onSkip ? (
              <button type="button" className="iconbtn ghost" onClick={onSkip}>
                {tr("inspire.skip")}
              </button>
            ) : null}
            <button
              type="button"
              className="iconbtn primary"
              disabled={!picked}
              onClick={() => picked && onSubmit(picked)}
            >
              {submitLabel}
            </button>
          </div>
        </footer>

        {previewId ? (
          <InspirationLightbox
            templates={visible}
            activeId={previewId}
            selectedId={picked}
            onNavigate={setPreviewId}
            onSelect={(templateId) => setPicked(templateId)}
            onClose={() => setPreviewId(undefined)}
          />
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
