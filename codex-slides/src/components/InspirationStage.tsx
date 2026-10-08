"use client";

import { MagnifyingGlass, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  COMMUNITY_GROUPS,
  COMMUNITY_TEMPLATES,
  getCommunitySource,
  getCommunityTemplate,
  matchCommunityTemplates,
  scoreCommunityTemplates,
  type CommunityTemplate,
} from "@/lib/community";
import { rankInspire } from "@/lib/deckEdit";
import { COMMUNITY_GROUP_KEYS } from "@/i18n/community";
import { useI18n } from "@/i18n/I18nProvider";
import InspirationLightbox from "@/components/InspirationLightbox";

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const normalized = raw.length === 3 ? raw.split("").map((char) => char + char).join("") : raw;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
  const linear = (channel: number) => (
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
}

/** Full workspace step for choosing a visual direction before any slide render
 * begins. Selection is controlled by the parent so it survives checkpoints. */
export default function InspirationStage({
  requirement,
  outlineTitles,
  selected,
  busy = false,
  headerPrefix,
  headerExtra,
  onSelect,
  onSkip,
  onConfirm,
}: {
  requirement: string;
  outlineTitles: string[];
  selected?: string;
  busy?: boolean;
  headerPrefix?: ReactNode;
  headerExtra?: ReactNode;
  onSelect: (templateId: string | undefined) => void;
  onSkip: () => void;
  onConfirm: (templateId: string) => void;
}) {
  const { t } = useI18n();
  const outlineKey = outlineTitles.join("\u0000");
  const stableOutlineTitles = useMemo(
    () => (outlineKey ? outlineKey.split("\u0000") : []),
    [outlineKey],
  );
  const matchQuery = useMemo(
    () => [requirement, ...stableOutlineTitles].filter(Boolean).join(" "),
    [requirement, stableOutlineTitles],
  );
  const [order, setOrder] = useState<string[]>(() => (
    matchCommunityTemplates(matchQuery).map((template) => template.id)
  ));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [ranking, setRanking] = useState(Boolean(matchQuery.trim()));
  const [group, setGroup] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<string>();
  const rankingRequest = useRef(0);

  useEffect(() => {
    const requestId = rankingRequest.current + 1;
    rankingRequest.current = requestId;
    setOrder(matchCommunityTemplates(matchQuery).map((template) => template.id));
    setReasons({});
    if (!matchQuery.trim()) {
      setRanking(false);
      return;
    }
    setRanking(true);
    let active = true;
    rankInspire(requirement, stableOutlineTitles)
      .then((result) => {
        if (!active || rankingRequest.current !== requestId) return;
        if (result.ranked?.length) setOrder(result.ranked);
        if (result.reasons) setReasons(result.reasons);
      })
      .catch(() => {
        // Offline matching already provides a deterministic, useful order.
      })
      .finally(() => {
        if (active && rankingRequest.current === requestId) setRanking(false);
      });
    return () => { active = false; };
  }, [matchQuery, requirement, stableOutlineTitles]);

  const ordered = useMemo(() => {
    const byId = new Map(COMMUNITY_TEMPLATES.map((template) => [template.id, template]));
    const ranked = order.flatMap((id) => byId.get(id) ?? []);
    const rankedIds = new Set(order);
    return [...ranked, ...COMMUNITY_TEMPLATES.filter((template) => !rankedIds.has(template.id))];
  }, [order]);

  const normalizedSearch = search.trim().toLowerCase();
  const searchScores = useMemo(() => new Map(
    normalizedSearch
      ? scoreCommunityTemplates(normalizedSearch).map(({ t: template, score }) => [template.id, score] as const)
      : [],
  ), [normalizedSearch]);
  const visible = ordered
    .filter((template) => {
      if (group !== "all" && template.group !== group) return false;
      if (!normalizedSearch) return true;
      const sources = (template.sourceIds ?? [])
        .map((sourceId) => getCommunitySource(sourceId)?.name ?? sourceId)
        .join(" ");
      const directMatch = [
        template.name,
        template.group,
        template.description,
        template.author,
        template.tags.join(" "),
        sources,
      ].join(" ").toLowerCase().includes(normalizedSearch);
      return directMatch || (searchScores.get(template.id) ?? 0) > 0;
    })
    .sort((left, right) => normalizedSearch
      ? (searchScores.get(right.id) ?? 0) - (searchScores.get(left.id) ?? 0)
      : 0);
  const selectedTemplate = getCommunityTemplate(selected);

  return (
    <section className="stage inspire-stage">
      <div className="stage-head">
        {headerPrefix}
        <span className="title">{t("designFiles.inspirationTitle")}</span>
        <span className="count">
          {ranking
            ? t("inspire.ranking")
            : t("inspire.libraryCount", { count: visible.length })}
        </span>
        {headerExtra}
      </div>

      <div className="inspire-board">
        <div className="inspire-stage-intro">
          <div>
            <h2>{t("designFiles.inspirationTitle")}</h2>
            <p>{t("flow.stylePrompt")}</p>
          </div>
          {ranking ? <span className="inspire-ranking">{t("inspire.ranking")}<span className="spinner sm" /></span> : null}
        </div>

        <div className="inspire-controls">
          <label className="inspire-search-wrap">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input
              className="inspire-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("inspire.search")}
              aria-label={t("inspire.searchLabel")}
            />
          </label>
          <div className="community-groups" role="tablist" aria-label={t("community.filter")}>
            <button
              type="button"
              className={`group-chip ${group === "all" ? "on" : ""}`}
              role="tab"
              aria-selected={group === "all"}
              onClick={() => setGroup("all")}
            >
              {t("community.all")}
            </button>
            {COMMUNITY_GROUPS.map((item) => (
              <button
                key={item}
                type="button"
                className={`group-chip ${group === item ? "on" : ""}`}
                role="tab"
                aria-selected={group === item}
                onClick={() => setGroup(item)}
              >
                {t(COMMUNITY_GROUP_KEYS[item])}
              </button>
            ))}
          </div>
        </div>

        <div className="inspire-grid">
          {visible.map((template: CommunityTemplate, index) => {
            const ground = [...template.palette].sort((a, b) => luminance(a) - luminance(b))[0];
            const source = template.sourceIds?.map(getCommunitySource).find(Boolean);
            const recommended = !ranking && group === "all" && !normalizedSearch && index < 3;
            const active = selected === template.id;
            return (
              <button
                key={template.id}
                type="button"
                className={`tpl-card inspire-card ${active ? "on" : ""}`}
                onClick={() => setPreviewId(template.id)}
                title={template.description}
                aria-label={t("inspire.previewNamed", { name: template.name })}
              >
                <div className="tpl-cover" style={{ background: ground }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={template.cover}
                    alt=""
                    loading="lazy"
                    onError={(event) => { event.currentTarget.hidden = true; }}
                  />
                  {recommended ? <span className="inspire-badge">{t("inspire.recommended")}</span> : null}
                  <span className="inspire-card-expand" aria-hidden="true">
                    <MagnifyingGlassPlus size={17} weight="bold" />
                  </span>
                  <span className="tpl-selected" aria-hidden="true">✓</span>
                </div>
                <div className="tpl-info">
                  <div>
                    <div className="tpl-meta">{template.name}</div>
                    <div className="tpl-cat">
                      {t(COMMUNITY_GROUP_KEYS[template.group])}
                      {source ? ` · ${source.name}` : ""}
                    </div>
                  </div>
                  <span className="inspire-palette" aria-hidden="true">
                    {template.palette.slice(0, 4).map((color) => <span key={color} style={{ background: color }} />)}
                  </span>
                </div>
                <div className="inspire-card-description">{template.description}</div>
                {reasons[template.id] ? <div className="inspire-reason">{reasons[template.id]}</div> : null}
              </button>
            );
          })}
          {!visible.length ? <div className="inspire-empty">{t("inspire.empty")}</div> : null}
        </div>
      </div>

      <footer className="outline-confirm inspire-confirm">
        <div className="inspire-confirm-selection">
          {selectedTemplate ? (
            <>
              <strong>{selectedTemplate.name}</strong>
              <small>{selectedTemplate.description}</small>
            </>
          ) : (
            <small>{t("inspire.pickOne")}</small>
          )}
        </div>
        <button type="button" className="ghost inspire-skip-btn" disabled={busy} onClick={onSkip}>
          {t("inspire.skip")}
        </button>
        <button
          type="button"
          className="outline-confirm-btn"
          disabled={busy || !selected}
          onClick={() => selected && onConfirm(selected)}
        >
          {busy
            ? t("outline.generating")
            : selectedTemplate
              ? t("inspire.selectNamed", { name: selectedTemplate.name })
              : t("inspire.choose")}
        </button>
      </footer>

      {previewId ? (
        <InspirationLightbox
          templates={visible}
          activeId={previewId}
          selectedId={selected}
          onNavigate={setPreviewId}
          onSelect={onSelect}
          onClose={() => setPreviewId(undefined)}
        />
      ) : null}
    </section>
  );
}
