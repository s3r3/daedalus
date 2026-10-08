"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, MagnifyingGlass, Palette } from "@phosphor-icons/react";
import {
  COMMUNITY_TEMPLATES,
  communityByGroup,
  getCommunityTemplate,
  type CommunityGroup,
  type CommunityTemplate,
} from "@/lib/community";
import { COMMUNITY_GROUP_KEYS } from "@/i18n/community";
import {
  CATEGORIES,
  TEMPLATES,
  categoryLabel as localizedCategoryLabel,
  getTemplate,
  templatesByCategory,
  type DeckCategory,
  type DeckTemplate,
} from "@/lib/templates";
import { useI18n } from "@/i18n/I18nProvider";

function matchesSearch(template: DeckTemplate, category: DeckCategory, query: string) {
  if (!query) return true;
  return [template.name, template.description, template.font, category.labelZh, category.labelEn, category.labelJa]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

function matchesCommunitySearch(template: CommunityTemplate, localizedGroup: string, query: string) {
  if (!query) return true;
  return [template.name, template.description, template.group, localizedGroup, template.author, ...template.tags]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** A searchable, in-product visual style picker (avoids the browser's native long select menu). */
export default function TemplatePicker({
  value,
  onChange,
}: {
  value?: string;
  onChange: (id: string | undefined) => void;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedPreset = getTemplate(value);
  const selectedCommunity = getCommunityTemplate(value);
  const selected = selectedPreset ?? selectedCommunity;
  const selectedCategory = CATEGORIES.find((category) => category.id === selectedPreset?.categoryId);
  const query = search.trim().toLocaleLowerCase();
  const categoryLabel = (category?: DeckCategory) => category
    ? localizedCategoryLabel(category, locale)
    : t("template.presetShort");
  const densityLabel = (density: DeckTemplate["density"]) => t(
    density === "low" ? "template.densityLow" : density === "high" ? "template.densityHigh" : "template.densityMedium",
  );
  const communityGroupLabel = (group: CommunityGroup) => t(COMMUNITY_GROUP_KEYS[group]);

  const groups = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        templates: templatesByCategory(category.id).filter((template) => matchesSearch(template, category, query)),
      })).filter((group) => group.templates.length > 0),
    [query],
  );
  const communityGroups = useMemo(
    () => communityByGroup()
      .map(({ group, templates }) => ({
        group,
        templates: templates.filter((template) => matchesCommunitySearch(template, t(COMMUNITY_GROUP_KEYS[group]), query)),
      }))
      .filter((group) => group.templates.length > 0),
    [query, t],
  );

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const gap = 8;
    const viewportPadding = 12;
    const rect = trigger.getBoundingClientRect();
    const panel = trigger.closest<HTMLElement>(".brand-system-panel");
    const panelRect = panel?.getBoundingClientRect();
    const footerRect = panel?.querySelector<HTMLElement>(".brand-system-footer")?.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const upperLimit = Math.max(viewportPadding, panelRect?.top ?? viewportPadding);
    const lowerLimit = Math.min(
      viewportHeight - viewportPadding,
      footerRect?.top ?? panelRect?.bottom ?? viewportHeight - viewportPadding,
    );
    const spaceBelow = Math.max(0, lowerLimit - rect.bottom - gap);
    const spaceAbove = Math.max(0, rect.top - upperLimit - gap);
    const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;
    const width = Math.min(rect.width, viewportWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, viewportWidth - width - viewportPadding),
    );

    setMenuPosition({
      left,
      width,
      maxHeight: Math.min(420, Math.max(120, availableHeight)),
      ...(placeAbove
        ? { bottom: viewportHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    });
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();
    const frame = requestAnimationFrame(() => {
      updateMenuPosition();
      searchRef.current?.focus();
    });
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  function choose(id?: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div className="style-field" ref={rootRef}>
      <div className="restyle-field-head">
        <label id="visual-style-label">{t("template.title")}</label>
        <span>{t("template.stylesCount", { count: TEMPLATES.length + COMMUNITY_TEMPLATES.length })}</span>
      </div>
      <button
        ref={triggerRef}
        type="button"
        className={`style-picker-trigger${open ? " open" : ""}`}
        aria-labelledby="visual-style-label"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="style-picker-icon" aria-hidden="true">
          <Palette size={18} weight="regular" />
        </span>
        <span className="style-picker-copy">
          <strong>{selected?.name ?? t("template.useCurrent")}</strong>
          <small>
            {selectedPreset
              ? t("template.density", { category: categoryLabel(selectedCategory), density: densityLabel(selectedPreset.density) })
              : selectedCommunity
                ? t("template.density", {
                  category: `${t("template.community")} · ${communityGroupLabel(selectedCommunity.group)}`,
                  density: densityLabel(selectedCommunity.density),
                })
              : t("template.noPreset")}
          </small>
        </span>
        {selected && (
          <span className="style-palette" aria-label={t("template.palette", { colors: selected.palette.join(", ") })}>
            {selected.palette.map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </span>
        )}
        <CaretDown className="style-picker-caret" size={16} weight="bold" aria-hidden="true" />
      </button>

      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="style-menu style-menu-portal"
          style={menuPosition}
        >
          <div className="style-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("template.search")}
              aria-label={t("template.searchLabel")}
            />
          </div>
          <div id={menuId} className="style-menu-list" role="listbox" aria-label={t("template.styles")}>
            {!query && (
              <button
                type="button"
                className={`style-option${!selected ? " selected" : ""}`}
                role="option"
                aria-selected={!selected}
                onClick={() => choose(undefined)}
              >
                <span className="style-option-copy">
                  <strong>{t("template.current")}</strong>
                  <small>{t("template.currentHelp")}</small>
                </span>
                {!selected && <Check size={17} weight="bold" aria-hidden="true" />}
              </button>
            )}
            {communityGroups.map(({ group, templates }) => (
              <section className="style-group style-group-community" key={group} role="group" aria-label={`${t("template.community")} · ${communityGroupLabel(group)}`}>
                <div className="style-group-label">
                  <span>{t("template.community")}</span>
                  <span>{communityGroupLabel(group)}</span>
                </div>
                {templates.map((template) => {
                  const active = template.id === value;
                  return (
                    <button
                      type="button"
                      className={`style-option${active ? " selected" : ""}`}
                      key={template.id}
                      role="option"
                      aria-selected={active}
                      onClick={() => choose(template.id)}
                    >
                      <span className="style-option-cover" aria-hidden="true">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={template.cover} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
                      </span>
                      <span className="style-option-copy">
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                      {active && <Check size={17} weight="bold" aria-hidden="true" />}
                    </button>
                  );
                })}
              </section>
            ))}
            {groups.map(({ category, templates }) => (
              <section className="style-group" key={category.id} role="group" aria-label={categoryLabel(category)}>
                <div className="style-group-label">
                  <span>{categoryLabel(category)}</span>
                  <span>{locale === "zh-CN" ? category.labelEn : locale === "ja" ? category.labelEn : category.labelZh}</span>
                </div>
                {templates.map((template) => {
                  const active = template.id === value;
                  return (
                    <button
                      type="button"
                      className={`style-option${active ? " selected" : ""}`}
                      key={template.id}
                      role="option"
                      aria-selected={active}
                      onClick={() => choose(template.id)}
                    >
                      <span className="style-option-palette" aria-hidden="true">
                        {template.palette.slice(0, 4).map((color) => (
                          <span key={color} style={{ background: color }} />
                        ))}
                      </span>
                      <span className="style-option-copy">
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                      {active && <Check size={17} weight="bold" aria-hidden="true" />}
                    </button>
                  );
                })}
              </section>
            ))}
            {!groups.length && !communityGroups.length && (
              <div className="style-menu-empty">{t("template.noMatch", { query: search.trim() })}</div>
            )}
          </div>
        </div>
      , document.body)}
      {selected && (
        <p className="style-detail">
          {selectedPreset ? (
            <>
              <span>{selectedPreset.font}</span>
              <span aria-hidden="true">·</span>
              <span>{selectedPreset.imageStyle}</span>
            </>
          ) : selectedCommunity ? (
            <>
              <span>{t("template.community")}</span>
              <span aria-hidden="true">·</span>
              <span>{communityGroupLabel(selectedCommunity.group)}{selectedCommunity.author ? ` · ${selectedCommunity.author}` : ""}</span>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}
