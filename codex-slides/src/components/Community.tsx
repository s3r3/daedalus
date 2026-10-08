"use client";

import { SquaresFour } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import InspireDialog from "@/components/InspireDialog";
import { COMMUNITY_GROUPS, COMMUNITY_TEMPLATES } from "@/lib/community";
import { CATEGORIES, categoryLabel, getTemplate } from "@/lib/templates";
import { useI18n } from "@/i18n/I18nProvider";
import { COMMUNITY_GROUP_KEYS } from "@/i18n/community";

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const FORYOU_GROUP = "For you";

// Curated "For you" picks (finished visual directions), previewed with real
// generated slides. The previews ship as static assets in public/community —
// they must never point at /api/files/<project>, which only resolves on the
// machine that generated those projects (fresh web and desktop installs have
// an empty data dir, so every card would render broken).
const FORYOU_PREVIEWS: Record<string, string> = {
  "pitch-clean-daylight": "/community/foryou-pitch-clean-daylight.jpg",
  "craft-editorial-ink": "/community/foryou-craft-editorial-ink.jpg",
  "data-answer-first": "/community/foryou-data-answer-first.jpg",
  "pitch-midnight-traction": "/community/foryou-pitch-midnight-traction.jpg",
};
interface GalleryItem {
  id: string;
  name: string;
  group: string;
  sub: string;
  img: string;
  palette: string[];
  desc?: string;
  categoryId?: string;
}

const FORYOU_ITEMS: GalleryItem[] = Object.entries(FORYOU_PREVIEWS)
  .map(([id, img]): GalleryItem | null => {
    const t = getTemplate(id);
    if (!t) return null;
    return {
      id,
      name: t.name,
      group: FORYOU_GROUP,
      sub: t.categoryId,
      categoryId: t.categoryId,
      img,
      palette: t.palette,
      desc: t.description,
    };
  })
  .filter((x): x is GalleryItem => Boolean(x));

const COMMUNITY_ITEMS: GalleryItem[] = COMMUNITY_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  group: t.group,
  sub: t.group,
  img: t.cover,
  palette: t.palette,
  desc: t.description,
}));

const ALL_ITEMS: GalleryItem[] = [...FORYOU_ITEMS, ...COMMUNITY_ITEMS];
const GROUPS: string[] = [FORYOU_GROUP, ...COMMUNITY_GROUPS];

/** Home gallery — finished "For you" directions + reusable Nano Banana Pro
 *  community styles, unified into one "For you"-style strip under the composer.
 *  Picking one seeds config.template (styleBlock). */
export default function Community({
  selected,
  requirement = "",
  onPick,
}: {
  selected?: string;
  requirement?: string;
  onPick: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [group, setGroup] = useState<string>("all");
  const [browserOpen, setBrowserOpen] = useState(false);

  const cards = useMemo(() => {
    const list = group === "all" ? ALL_ITEMS : ALL_ITEMS.filter((i) => i.group === group);
    return list.map((i) => ({ i, ground: [...i.palette].sort((a, b) => lum(a) - lum(b))[0] }));
  }, [group]);

  function nudge(dir: number) {
    scrollRef.current?.scrollBy({ left: dir * 440, behavior: "smooth" });
  }

  const groupLabel = (value: string) => value === FORYOU_GROUP
    ? t("community.forYou")
    : value in COMMUNITY_GROUP_KEYS
      ? t(COMMUNITY_GROUP_KEYS[value as keyof typeof COMMUNITY_GROUP_KEYS])
      : value;
  const itemSub = (item: GalleryItem) => {
    if (!item.categoryId) return groupLabel(item.sub);
    const category = CATEGORIES.find((candidate) => candidate.id === item.categoryId);
    return category ? categoryLabel(category, locale) : item.sub;
  };

  return (
    <>
    <section className="foryou community" aria-labelledby="community-heading">
      <div className="section-head foryou-head">
        <div>
          <h2 id="community-heading">{t("community.title")}</h2>
          <p>{t("community.subtitle")}</p>
        </div>
        <div className="foryou-nav">
          <button type="button" className="community-browser-button" onClick={() => setBrowserOpen(true)}>
            <SquaresFour size={15} aria-hidden="true" />
            {t("community.browseCount", { count: COMMUNITY_TEMPLATES.length })}
          </button>
          <button className="round-btn" onClick={() => nudge(-1)} aria-label={t("community.scrollLeft")}>
            ‹
          </button>
          <button className="round-btn" onClick={() => nudge(1)} aria-label={t("community.scrollRight")}>
            ›
          </button>
        </div>
      </div>
      <div className="community-groups" role="tablist" aria-label={t("community.filter")}>
        <button
          className={`group-chip ${group === "all" ? "on" : ""}`}
          role="tab"
          aria-selected={group === "all"}
          onClick={() => setGroup("all")}
        >
          {t("community.all")} <span className="group-count">{ALL_ITEMS.length}</span>
        </button>
        {GROUPS.map((g) => {
          const n = ALL_ITEMS.filter((i) => i.group === g).length;
          if (!n) return null;
          return (
            <button
              key={g}
              className={`group-chip ${group === g ? "on" : ""}`}
              role="tab"
              aria-selected={group === g}
              onClick={() => setGroup(g)}
            >
              {groupLabel(g)} <span className="group-count">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="foryou-scroll" ref={scrollRef}>
        {cards.map(({ i, ground }) => (
          <button
            key={i.id}
            className={`tpl-card ${selected === i.id ? "on" : ""}`}
            onClick={() => onPick(i.id)}
            title={i.desc}
            aria-pressed={selected === i.id}
          >
            <div className="tpl-cover" style={{ background: ground }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={i.img} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
              <span className="tpl-selected" aria-hidden="true">
                ✓
              </span>
            </div>
            <div className="tpl-info">
              <div>
                <div className="tpl-meta">{i.name}</div>
                <div className="tpl-cat">{itemSub(i)}</div>
              </div>
              <span className="inspire-palette" aria-hidden="true">
                {i.palette.slice(0, 4).map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
    {browserOpen ? (
      <InspireDialog
        requirement={requirement}
        outlineTitles={[]}
        selected={selected}
        intent="select"
        onClose={() => setBrowserOpen(false)}
        onSubmit={(id) => {
          if (id !== selected) onPick(id);
          setBrowserOpen(false);
        }}
      />
    ) : null}
    </>
  );
}
