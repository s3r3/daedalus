"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CornersOut,
  FloppyDisk,
  IdentificationCard,
  ImageSquare,
  Palette,
  Robot,
  Ruler,
  Sparkle,
  TextT,
  X,
} from "@phosphor-icons/react";
import MaterialTray, { type MaterialTrayItem } from "@/components/MaterialTray";
import TemplatePicker from "@/components/TemplatePicker";
import { createDeckDesignSystemSeed } from "@/lib/designSystem";
import type { DeckDesignSystem } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";

export interface BrandDesignSystemSubmit {
  designSystem: DeckDesignSystem;
  template?: string;
  materialIds: string[];
  redraw: boolean;
}

interface BrandDesignSystemPanelProps {
  value: DeckDesignSystem;
  initialTemplate?: string;
  initialMaterials?: MaterialTrayItem[];
  slideCount: number;
  saving?: boolean;
  redrawing?: boolean;
  progress?: number;
  error?: string;
  onClose: () => void;
  onSubmit: (value: BrandDesignSystemSubmit) => void;
}

const COLOR_FIELDS: { key: keyof DeckDesignSystem["colors"]; label: MessageKey }[] = [
  { key: "primary", label: "brandSystem.colorPrimary" },
  { key: "primaryTint", label: "brandSystem.colorPrimaryTint" },
  { key: "accent", label: "brandSystem.colorAccent" },
  { key: "accentTint", label: "brandSystem.colorAccentTint" },
  { key: "ink", label: "brandSystem.colorInk" },
  { key: "surface", label: "brandSystem.colorSurface" },
  { key: "background", label: "brandSystem.colorBackground" },
  { key: "backgroundWarm", label: "brandSystem.colorBackgroundWarm" },
];

function validColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
}

function SystemSection({
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="brand-system-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="brand-system-section-icon" aria-hidden="true">{icon}</span>
        <span className="brand-system-section-copy">
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <CaretDown className="brand-system-section-caret" size={15} weight="bold" aria-hidden="true" />
      </summary>
      <div className="brand-system-section-body">{children}</div>
    </details>
  );
}

/** Project-wide brand tokens and style rules. Saving changes future agent context; redraw is explicit. */
export function BrandDesignSystemPanel({
  value,
  initialTemplate,
  initialMaterials = [],
  slideCount,
  saving = false,
  redrawing = false,
  progress = 0,
  error,
  onClose,
  onSubmit,
}: BrandDesignSystemPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<DeckDesignSystem>(value);
  const [template, setTemplate] = useState(initialTemplate);
  const [materialItems, setMaterialItems] = useState<MaterialTrayItem[]>(initialMaterials);
  const materialIds = materialItems.map((item) => item.id);
  const formRef = useRef<HTMLFormElement>(null);
  const locked = saving || redrawing;

  function chooseTemplate(id?: string) {
    setTemplate(id);
    if (!id) return;
    const seed = createDeckDesignSystemSeed({ template: id });
    setDraft((current) => ({
      ...current,
      style: seed.style,
      colors: seed.colors,
      typography: {
        ...current.typography,
        headingFont: seed.typography.headingFont,
      },
      spacing: {
        ...current.spacing,
        density: seed.spacing.density,
        sectionGap: seed.spacing.sectionGap,
      },
    }));
  }

  function submit(redraw: boolean) {
    if (locked || !formRef.current?.reportValidity()) return;
    onSubmit({
      designSystem: {
        ...draft,
        brand: { ...draft.brand, assetMaterialIds: materialIds },
      },
      template,
      materialIds,
      redraw,
    });
  }

  return (
    <aside
      id="brand-design-system-panel"
      className="retune-panel brand-system-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="brand-design-system-title"
      tabIndex={-1}
    >
      <div className="retune-panel-head brand-system-panel-head">
        <div className="retune-heading">
          <span className="retune-heading-icon brand-system-heading-icon" aria-hidden="true">
            <Palette size={19} weight="regular" />
          </span>
          <div className="brand-system-heading-copy">
            <h2 id="brand-design-system-title">{t("brandSystem.title")}</h2>
            <div className="brand-system-heading-subline">
              <p>{t("brandSystem.subtitle")}</p>
              <span className="brand-system-context-chip" title={t("brandSystem.alwaysOnHelp")}>
                <Robot size={12} weight="duotone" aria-hidden="true" />
                {t("brandSystem.alwaysOn")}
              </span>
            </div>
          </div>
        </div>
        <button type="button" className="retune-close" disabled={locked} onClick={onClose} aria-label={t("brandSystem.close")}>
          <X size={17} weight="bold" aria-hidden="true" />
        </button>
      </div>

      <section className="brand-system-overview" aria-label={t("brandSystem.overview")}>
        <div className="brand-system-overview-brand">
          <span className="brand-system-logo-preview">
            {materialItems[0]?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={materialItems[0].url} alt={materialItems[0].name} />
            ) : (
              <b aria-hidden="true">{draft.brand.name.trim().slice(0, 2).toUpperCase() || "Aa"}</b>
            )}
          </span>
          <span>
            <small>{t("brandSystem.overview")}</small>
            <strong>{draft.brand.name || t("brandSystem.unnamedBrand")}</strong>
            <em>{draft.brand.tagline || draft.style.direction || t("brandSystem.systemReady")}</em>
          </span>
        </div>
        <div className="brand-system-overview-swatches" aria-label={t("brandSystem.colors")}>
          {COLOR_FIELDS.map(({ key, label }) => (
            <span key={key} title={`${t(label)} ${draft.colors[key]}`} style={{ background: validColor(draft.colors[key]) }} />
          ))}
        </div>
        <div className="brand-system-overview-meta">
          <span>
            <small>{t("brandSystem.visualStyle")}</small>
            <strong>{draft.style.direction || t("brandSystem.systemReady")}</strong>
          </span>
          <span style={{ fontFamily: draft.typography.headingFont.split("/")[0].trim() }}>
            <small>{t("brandSystem.headingFont")}</small>
            <strong>{draft.typography.headingFont} · {draft.typography.headingWeight}</strong>
          </span>
          <span style={{ fontFamily: draft.typography.bodyFont.split("/")[0].trim() }}>
            <small>{t("brandSystem.bodyFont")}</small>
            <strong>{draft.typography.bodyFont} · {draft.typography.bodyWeight}</strong>
          </span>
        </div>
      </section>

      <form
        ref={formRef}
        className="retune-panel-body brand-system-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        <SystemSection
          icon={<IdentificationCard size={17} />}
          title={t("brandSystem.identity")}
          description={t("brandSystem.identityHelp")}
        >
          <div className="brand-system-fields two-col">
            <label className="brand-system-field">
              <span>{t("brandSystem.brandName")}</span>
              <input
                value={draft.brand.name}
                maxLength={120}
                placeholder={t("brandSystem.brandNamePlaceholder")}
                onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, name: event.target.value } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.tagline")}</span>
              <input
                value={draft.brand.tagline}
                maxLength={240}
                placeholder={t("brandSystem.taglinePlaceholder")}
                onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, tagline: event.target.value } }))}
              />
            </label>
          </div>
          <label className="brand-system-field">
            <span>{t("brandSystem.voice")}</span>
            <textarea
              rows={2}
              value={draft.brand.voice}
              maxLength={500}
              placeholder={t("brandSystem.voicePlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, voice: event.target.value } }))}
            />
          </label>
          <label className="brand-system-field">
            <span>{t("brandSystem.logoUsage")}</span>
            <textarea
              rows={2}
              value={draft.brand.logoUsage}
              maxLength={500}
              placeholder={t("brandSystem.logoUsagePlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, logoUsage: event.target.value } }))}
            />
          </label>
        </SystemSection>

        <SystemSection
          icon={<Sparkle size={17} />}
          title={t("brandSystem.visualStyle")}
          description={t("brandSystem.visualStyleHelp")}
          defaultOpen
        >
          <TemplatePicker value={template} onChange={chooseTemplate} />
          <label className="brand-system-field brand-system-field-spaced">
            <span>{t("brandSystem.direction")}</span>
            <input
              value={draft.style.direction}
              maxLength={160}
              placeholder={t("brandSystem.directionPlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, style: { ...current.style, direction: event.target.value } }))}
            />
          </label>
          <label className="brand-system-field">
            <span>{t("brandSystem.keywords")}</span>
            <textarea
              rows={2}
              value={draft.style.keywords}
              maxLength={500}
              placeholder={t("brandSystem.keywordsPlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, style: { ...current.style, keywords: event.target.value } }))}
            />
          </label>
          <label className="brand-system-field">
            <span>{t("brandSystem.imageTreatment")}</span>
            <textarea
              rows={2}
              value={draft.style.imageTreatment}
              maxLength={500}
              placeholder={t("brandSystem.imageTreatmentPlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, style: { ...current.style, imageTreatment: event.target.value } }))}
            />
          </label>
        </SystemSection>

        <SystemSection
          icon={<Palette size={17} />}
          title={t("brandSystem.colors")}
          description={t("brandSystem.colorsHelp")}
        >
          <div className="brand-color-grid">
            {COLOR_FIELDS.map(({ key, label }) => (
              <label className="brand-color-field" key={key}>
                <span>{t(label)}</span>
                <span className="brand-color-control">
                  <input
                    type="color"
                    value={validColor(draft.colors[key])}
                    aria-label={t(label)}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      colors: { ...current.colors, [key]: event.target.value.toUpperCase() },
                    }))}
                  />
                  <input
                    type="text"
                    value={draft.colors[key]}
                    pattern="#[0-9A-Fa-f]{6}"
                    maxLength={7}
                    spellCheck={false}
                    aria-label={`${t(label)} HEX`}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      colors: { ...current.colors, [key]: event.target.value.toUpperCase() },
                    }))}
                  />
                </span>
              </label>
            ))}
          </div>
        </SystemSection>

        <SystemSection
          icon={<TextT size={17} />}
          title={t("brandSystem.typography")}
          description={t("brandSystem.typographyHelp")}
        >
          <div className="brand-system-fields two-col">
            <label className="brand-system-field">
              <span>{t("brandSystem.headingFont")}</span>
              <input
                value={draft.typography.headingFont}
                maxLength={160}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, headingFont: event.target.value } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.bodyFont")}</span>
              <input
                value={draft.typography.bodyFont}
                maxLength={160}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, bodyFont: event.target.value } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.monoFont")}</span>
              <input
                value={draft.typography.monoFont}
                maxLength={160}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, monoFont: event.target.value } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.typeScale")}</span>
              <input
                value={draft.typography.scale}
                maxLength={300}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, scale: event.target.value } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.headingWeight")}</span>
              <input
                type="number"
                min={100}
                max={900}
                step={100}
                value={draft.typography.headingWeight}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, headingWeight: Number(event.target.value) } }))}
              />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.bodyWeight")}</span>
              <input
                type="number"
                min={100}
                max={900}
                step={100}
                value={draft.typography.bodyWeight}
                onChange={(event) => setDraft((current) => ({ ...current, typography: { ...current.typography, bodyWeight: Number(event.target.value) } }))}
              />
            </label>
          </div>
        </SystemSection>

        <SystemSection
          icon={<Sparkle size={17} />}
          title={t("brandSystem.effects")}
          description={t("brandSystem.effectsHelp")}
        >
          <label className="brand-system-field">
            <span>{t("brandSystem.shadow")}</span>
            <textarea rows={2} value={draft.effects.shadow} maxLength={300} onChange={(event) => setDraft((current) => ({ ...current, effects: { ...current.effects, shadow: event.target.value } }))} />
          </label>
          <label className="brand-system-field">
            <span>{t("brandSystem.border")}</span>
            <textarea rows={2} value={draft.effects.border} maxLength={300} onChange={(event) => setDraft((current) => ({ ...current, effects: { ...current.effects, border: event.target.value } }))} />
          </label>
          <label className="brand-system-field">
            <span>{t("brandSystem.texture")}</span>
            <textarea rows={2} value={draft.effects.texture} maxLength={300} onChange={(event) => setDraft((current) => ({ ...current, effects: { ...current.effects, texture: event.target.value } }))} />
          </label>
        </SystemSection>

        <SystemSection
          icon={<Ruler size={17} />}
          title={t("brandSystem.spacing")}
          description={t("brandSystem.spacingHelp")}
        >
          <div className="brand-system-fields three-col">
            <label className="brand-system-field">
              <span>{t("brandSystem.density")}</span>
              <select
                value={draft.spacing.density}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  spacing: { ...current.spacing, density: event.target.value as DeckDesignSystem["spacing"]["density"] },
                }))}
              >
                <option value="compact">{t("brandSystem.densityCompact")}</option>
                <option value="balanced">{t("brandSystem.densityBalanced")}</option>
                <option value="spacious">{t("brandSystem.densitySpacious")}</option>
              </select>
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.baseUnit")}</span>
              <input type="number" min={2} max={24} value={draft.spacing.baseUnit} onChange={(event) => setDraft((current) => ({ ...current, spacing: { ...current.spacing, baseUnit: Number(event.target.value) } }))} />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.sectionGap")}</span>
              <input type="number" min={8} max={96} value={draft.spacing.sectionGap} onChange={(event) => setDraft((current) => ({ ...current, spacing: { ...current.spacing, sectionGap: Number(event.target.value) } }))} />
            </label>
          </div>
        </SystemSection>

        <SystemSection
          icon={<CornersOut size={17} />}
          title={t("brandSystem.radius")}
          description={t("brandSystem.radiusHelp")}
        >
          <div className="brand-system-fields three-col">
            <label className="brand-system-field">
              <span>{t("brandSystem.cardRadius")}</span>
              <input type="number" min={0} max={48} value={draft.radius.card} onChange={(event) => setDraft((current) => ({ ...current, radius: { ...current.radius, card: Number(event.target.value) } }))} />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.controlRadius")}</span>
              <input type="number" min={0} max={32} value={draft.radius.control} onChange={(event) => setDraft((current) => ({ ...current, radius: { ...current.radius, control: Number(event.target.value) } }))} />
            </label>
            <label className="brand-system-field">
              <span>{t("brandSystem.pillRadius")}</span>
              <input type="number" min={0} max={999} value={draft.radius.pill} onChange={(event) => setDraft((current) => ({ ...current, radius: { ...current.radius, pill: Number(event.target.value) } }))} />
            </label>
          </div>
        </SystemSection>

        <SystemSection
          icon={<ImageSquare size={17} />}
          title={t("brandSystem.assets")}
          description={t("brandSystem.assetsHelp")}
        >
          <MaterialTray
            initialItems={initialMaterials}
            disabled={locked}
            onItemsChange={setMaterialItems}
          />
        </SystemSection>
      </form>

      <div className="retune-panel-footer brand-system-footer">
        {error ? <div className="brand-system-error" role="alert">{error}</div> : null}
        <div className="brand-system-footer-note">
          <Robot size={17} weight="duotone" aria-hidden="true" />
          <span>{t("brandSystem.saveHelp")}</span>
        </div>
        <div className="brand-system-footer-actions">
          <button
            type="button"
            className="brand-system-redraw"
            disabled={locked || slideCount === 0}
            onClick={() => submit(true)}
          >
            <ArrowsClockwise size={16} weight="bold" aria-hidden="true" />
            {redrawing
              ? t("brandSystem.redrawProgress", { current: progress, total: slideCount })
              : t("brandSystem.saveAndRedraw", { count: slideCount })}
          </button>
          <button type="button" className="retune-apply brand-system-save" disabled={locked} onClick={() => submit(false)}>
            <FloppyDisk size={16} weight="bold" aria-hidden="true" />
            {saving && !redrawing ? t("common.saving") : t("brandSystem.save")}
          </button>
        </div>
      </div>
    </aside>
  );
}
