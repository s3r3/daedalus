"use client";

import { Check, Paperclip, Plus, UploadSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useCodexSetup } from "@/components/CodexSetupProvider";
import ContextItems from "@/components/ContextItems";
import ContextOptionItems from "@/components/ContextOptionItems";
import ProjectTemplatePicker from "@/components/ProjectTemplatePicker";
import {
  CONTEXT_ITEM_ACCEPT,
  contextItemMatchesAccept,
  hasDraggedFiles,
  mergeContextItems,
  uploadContextItems,
  type ContextItem,
} from "@/lib/contextItems";
import { shouldSubmitTextarea } from "@/lib/keyboard";
import {
  scenarioText,
  type PresentationScenario,
  type ScenarioInputSlot,
} from "@/lib/scenarios";
import type { ContextOptionItem, PptConfig, ProjectTemplateSummary } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

interface EngineInfo {
  engine: string;
  label: string;
  available: boolean;
}
export type Material = ContextItem;

const QUALITY = [
  { id: "auto", res: "2K" },
  { id: "high", res: "4K" },
  { id: "medium", res: "2K" },
  { id: "low", res: "1K" },
] as const satisfies readonly { id: string; res: PptConfig["resolution"] }[];
type QualityId = (typeof QUALITY)[number]["id"];
const QUALITY_KEYS = {
  auto: "composer.auto",
  high: "composer.high",
  medium: "composer.medium",
  low: "composer.low",
} as const;
const QUALITY_TOOLTIP_KEYS = {
  auto: "composer.qualityTip.auto",
  high: "composer.qualityTip.high",
  medium: "composer.qualityTip.medium",
  low: "composer.qualityTip.low",
} as const;
const ASPECTS = [
  { label: "16:9", value: "16:9", w: 22, h: 13, tip: "composer.aspectTip.16x9" },
  { label: "9:16", value: "9:16", w: 12, h: 20, tip: "composer.aspectTip.9x16" },
  { label: "4:3", value: "4:3", w: 20, h: 15, tip: "composer.aspectTip.4x3" },
  { label: "3:4", value: "3:4", w: 15, h: 20, tip: "composer.aspectTip.3x4" },
  { label: "1:1", value: "1:1", w: 17, h: 17, tip: "composer.aspectTip.1x1" },
] as const;

function useOutside(ref: React.RefObject<HTMLElement>, close: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [ref, close, active]);
}

/** Agent-native launcher input: textarea + toolbar (add / model / settings / send). */
export default function Composer({
  config,
  setConfig,
  engines,
  running,
  researchMode,
  setResearchMode,
  materials,
  onAddItems,
  onRemoveMaterial,
  styleTemplate,
  onClearStyle,
  projectTemplates,
  projectTemplate,
  onSelectProjectTemplate,
  onClearProjectTemplate,
  scenario,
  onClearScenario,
  onSubmit,
}: {
  config: PptConfig;
  setConfig: (patch: Partial<PptConfig>) => void;
  engines: EngineInfo[];
  running: boolean;
  researchMode: boolean;
  setResearchMode: (v: boolean) => void;
  materials: ContextItem[];
  onAddItems: (items: ContextItem[]) => void;
  onRemoveMaterial: (id: string) => void;
  /** Currently chosen deck style (from Community / For you), shown as a chip. */
  styleTemplate?: { id: string; name: string; cover?: string; palette?: string[]; sub?: string } | null;
  onClearStyle?: () => void;
  projectTemplates?: ProjectTemplateSummary[];
  projectTemplate?: ProjectTemplateSummary | null;
  onSelectProjectTemplate?: (template: ProjectTemplateSummary) => void;
  onClearProjectTemplate?: () => void;
  scenario?: PresentationScenario | null;
  onClearScenario?: () => void;
  onSubmit: (
    contextOptions: ContextOptionItem[],
    materialContexts: Array<{ id: string; name: string; role: string }>,
  ) => void;
}) {
  const { locale, t } = useI18n();
  const { openSetup } = useCodexSetup();
  const [focus, setFocus] = useState(false);
  const [menu, setMenu] = useState<null | "add" | "settings">(null);
  const [quality, setQuality] = useState<QualityId>("auto");
  const [aspectSel, setAspectSel] = useState<PptConfig["aspect"] | "auto">("auto");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [slotAssignments, setSlotAssignments] = useState<Record<string, string[]>>({});
  const [dragActive, setDragActive] = useState(false);
  const [dragSlotId, setDragSlotId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slotFileRef = useRef<HTMLInputElement>(null);
  const activeSlotRef = useRef<string | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  useOutside(addRef, () => setMenu((m) => (m === "add" ? null : m)), menu === "add");
  useOutside(setRef, () => setMenu((m) => (m === "settings" ? null : m)), menu === "settings");

  const engine = engines.find((e) => e.engine === config.engine);
  const modelLabel = engine ? engine.label.replace(/\s*\(.*\)$/, "") : "Codex";
  const qualityLabel = t(QUALITY_KEYS[quality]);
  const qualityResolution = QUALITY.find((item) => item.id === quality)?.res ?? "2K";
  const qualitySummary = `${qualityLabel} ${qualityResolution}`;
  const aspectLabel = aspectSel === "auto" ? t("composer.auto") : aspectSel;

  useEffect(() => setSlotAssignments({}), [scenario?.id]);

  useEffect(() => {
    setSlotAssignments((current) => {
      if (!scenario) return {};
      const materialIds = new Set(materials.map((item) => item.id));
      const next: Record<string, string[]> = {};
      for (const [slotId, ids] of Object.entries(current)) {
        const kept = ids.filter((id) => materialIds.has(id));
        if (kept.length) next[slotId] = kept;
      }
      const assigned = new Set(Object.values(next).flat());
      for (const item of materials) {
        if (assigned.has(item.id)) continue;
        const target = scenario.slots.find((candidate) =>
          candidate.required && !next[candidate.id]?.length && contextItemMatchesAccept(item, candidate.accept),
        );
        if (!target) continue;
        next[target.id] = [...(next[target.id] ?? []), item.id];
        assigned.add(item.id);
      }
      return next;
    });
  }, [materials, scenario]);

  async function addFiles(files: Iterable<File>, slotId?: string | null) {
    const selected = Array.from(files);
    if (!selected.length) return;
    setUploading(true);
    setUploadError("");
    const result = await uploadContextItems(selected);
    if (result.items.length) {
      onAddItems(mergeContextItems(materials, result.items));
      if (slotId) {
        const slot = scenario?.slots.find((candidate) => candidate.id === slotId);
        const assignedItems = slot
          ? result.items.filter((item) => contextItemMatchesAccept(item, slot.accept))
          : [];
        setSlotAssignments((current) => ({
          ...current,
          ...(assignedItems.length
            ? { [slotId]: [...new Set([...(current[slotId] ?? []), ...assignedItems.map((item) => item.id)])] }
            : {}),
        }));
      }
    }
    if (result.errors.length) setUploadError(result.errors.join(" · "));
    setUploading(false);
  }

  const contextOptions: ContextOptionItem[] = [
    ...(scenario
      ? [{ id: "scenario", kind: "scenario" as const, label: t("scenario.context"), value: scenarioText(scenario.name, locale) }]
      : []),
    ...(researchMode
      ? [{ id: "research", kind: "research" as const, label: t("composer.research") }]
      : []),
    ...(config.fast
      ? [{ id: "fast", kind: "speed" as const, label: t("composer.fast"), value: t("composer.fastValue") }]
      : []),
    ...(styleTemplate
      ? [{ id: "style", kind: "style" as const, label: t("composer.design"), value: styleTemplate.name }]
      : []),
    ...(projectTemplate
      ? [{ id: "project-template", kind: "template" as const, label: t("projectTemplates.context"), value: projectTemplate.name }]
      : []),
    ...(quality !== "auto"
      ? [{ id: "quality", kind: "setting" as const, label: t("composer.quality"), value: qualitySummary }]
      : []),
    ...(aspectSel !== "auto"
      ? [{ id: "aspect", kind: "setting" as const, label: t("composer.aspect"), value: aspectSel }]
      : []),
  ];

  function removeContextOption(id: string) {
    if (id === "scenario") onClearScenario?.();
    else if (id === "research") setResearchMode(false);
    else if (id === "fast") setConfig({ fast: false });
    else if (id === "style") onClearStyle?.();
    else if (id === "project-template") onClearProjectTemplate?.();
    else if (id === "quality") {
      setQuality("auto");
      setConfig({ resolution: "2K" });
    } else if (id === "aspect") {
      setAspectSel("auto");
      setConfig({ aspect: "16:9" });
    }
  }

  const missingRequiredSlots = scenario?.slots.filter((slot) =>
    slot.required && !slotAssignments[slot.id]?.some((id) => materials.some((item) => item.id === id)),
  ) ?? [];
  const submitDisabled = running || uploading || missingRequiredSlots.length > 0 || (!config.requirement.trim() && !materials.length);

  function submitComposer() {
    if (submitDisabled) return;
    const materialContexts = scenario
      ? scenario.slots.flatMap((slot) =>
          (slotAssignments[slot.id] ?? []).flatMap((id) => {
            const item = materials.find((candidate) => candidate.id === id);
            return item ? [{ id: item.id, name: item.name, role: slot.label.en }] : [];
          }),
        )
      : [];
    onSubmit(contextOptions, materialContexts);
  }

  function openScenarioSlot(slot: ScenarioInputSlot) {
    const input = slotFileRef.current;
    if (!input) return;
    activeSlotRef.current = slot.id;
    input.accept = slot.accept;
    input.multiple = slot.multiple !== false;
    input.click();
  }

  function slotIdAt(target: EventTarget | null): string | null {
    return target instanceof Element
      ? target.closest<HTMLElement>("[data-scenario-slot]")?.dataset.scenarioSlot ?? null
      : null;
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
    setDragSlotId(slotIdAt(event.target));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
    setDragSlotId(slotIdAt(event.target));
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
      setDragSlotId(null);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    const slotId = slotIdAt(event.target) ?? dragSlotId;
    dragDepthRef.current = 0;
    setDragActive(false);
    setDragSlotId(null);
    void addFiles(Array.from(event.dataTransfer.files), slotId);
  }

  return (
    <div
      className={`composer${focus ? " focus" : ""}${dragActive ? " context-drop-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-busy={uploading}
    >
      {dragActive && (
        <div className="context-drop-overlay" role="status" aria-live="polite">
          <UploadSimple size={22} weight="bold" />
          <strong>{dragSlotId ? t("composer.dropIntoSlot") : t("composer.dropFiles")}</strong>
          <span>{dragSlotId ? t("composer.dropIntoSlotHelp") : t("composer.dropFilesHelp")}</span>
        </div>
      )}
      <ContextOptionItems items={contextOptions} onRemove={removeContextOption} />
      {scenario && (
        <div className="scenario-composer-context">
          <div className="scenario-context-output">
            <span>{t("scenario.expectedOutput")}</span>
            <strong>{scenarioText(scenario.output, locale)}</strong>
          </div>
          {scenario.slots.length > 0 && (
            <div className="scenario-context-materials">
              <span className="scenario-context-label">{t("scenario.suggestedMaterial")}</span>
              <div className="scenario-context-slots">
                {scenario.slots.map((slot) => {
                  const count = (slotAssignments[slot.id] ?? []).filter((id) => materials.some((item) => item.id === id)).length;
                  return (
                    <button
                      type="button"
                      key={slot.id}
                      data-scenario-slot={slot.id}
                      className={`scenario-context-slot${count ? " added" : ""}${slot.required && !count ? " required" : ""}${dragSlotId === slot.id ? " drop-target" : ""}`}
                      onClick={() => openScenarioSlot(slot)}
                      title={scenarioText(slot.detail, locale)}
                      aria-label={t("scenario.addMaterial", { name: scenarioText(slot.label, locale) })}
                    >
                      <span className="scenario-slot-icon" aria-hidden="true">
                        {count ? <Check size={13} weight="bold" /> : <UploadSimple size={14} />}
                      </span>
                      <span className="scenario-slot-copy">
                        <strong>{scenarioText(slot.label, locale)}</strong>
                        <small>{count ? `${t("scenario.added")}${count > 1 ? ` · ${count}` : ""}` : scenarioText(slot.detail, locale)}</small>
                      </span>
                      <em>{slot.required ? t("scenario.required") : t("scenario.optional")}</em>
                    </button>
                  );
                })}
              </div>
              {missingRequiredSlots.length > 0 && (
                <div className="scenario-context-missing" role="status">
                  {t("scenario.missingMaterial")} {missingRequiredSlots.map((slot) => scenarioText(slot.label, locale)).join(" · ")}
                </div>
              )}
            </div>
          )}
          <input
            ref={slotFileRef}
            type="file"
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []), activeSlotRef.current);
              event.target.value = "";
              activeSlotRef.current = null;
            }}
          />
        </div>
      )}
      {materials.length > 0 && (
        <ContextItems items={materials} onRemove={onRemoveMaterial} scrollable />
      )}
      {uploadError && <div className="context-upload-error" role="alert">{uploadError}</div>}

      <textarea
        rows={4}
        placeholder={scenario ? scenarioText(scenario.starter, locale) : t("composer.placeholder")}
        value={config.requirement}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onChange={(e) => {
          setConfig({ requirement: e.target.value });
          const el = e.target;
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 320) + "px";
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          if (shouldSubmitTextarea({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.nativeEvent.keyCode,
          })) {
            e.preventDefault();
            submitComposer();
          }
        }}
      />

      <div className="composer-bar">
        {/* + add menu */}
        <div ref={addRef} style={{ position: "relative" }}>
          <button
            className="cbtn icononly"
            title={t("composer.addOptions")}
            aria-label={t("composer.addFiles")}
            onClick={() => setMenu(menu === "add" ? null : "add")}
          >
            <Plus size={18} />
          </button>
          {menu === "add" && (
            <div className="pop up">
              <button
                className="pop-item"
                onClick={() => {
                  fileRef.current?.click();
                  setMenu(null);
                }}
              >
                <span className="ic"><Paperclip size={17} /></span> {t("composer.addFiles")}
              </button>
              <div className="pop-sep" />
              <button className="pop-item" onClick={() => setResearchMode(!researchMode)}>
                <span className="ic">🔍</span>
                <span className="grow">{t("composer.research")}</span>
                <span className={`toggle ${researchMode ? "on" : ""}`} />
              </button>
              <button
                className="pop-item"
                onClick={() => setConfig({ fast: !config.fast })}
                title={t("composer.fastHelp")}
              >
                <span className="ic">⚡</span>
                <span className="grow">
                  {t("composer.fast")}
                  <span className="pop-sub">
                    {config.fast
                      ? t("composer.fastOn")
                      : t("composer.fastOff")}
                  </span>
                </span>
                <span className={`toggle ${config.fast ? "on" : ""}`} />
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={CONTEXT_ITEM_ACCEPT}
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              if (fileRef.current) fileRef.current.value = "";
            }}
          />
        </div>

        {/* mode (Slides) */}
        <button className="cbtn active" title={t("composer.outputType")}>
          ▦ {t("composer.slides")}
        </button>

        <ProjectTemplatePicker
          templates={projectTemplates ?? []}
          selected={projectTemplate}
          disabled={running || uploading}
          onSelect={(template) => onSelectProjectTemplate?.(template)}
          onClear={() => onClearProjectTemplate?.()}
        />

        {/* engine — Codex is the only orchestrator; opens the setup dialog */}
        <button
          className="cbtn"
          onClick={() => openSetup()}
          title={t("codexSetup.openEntry")}
        >
          ◍ {modelLabel} <span className="caret">▾</span>
        </button>

        {/* settings: quality · aspect */}
        <div ref={setRef} style={{ position: "relative" }}>
          <button className="cbtn" onClick={() => setMenu(menu === "settings" ? null : "settings")}>
            {qualitySummary} · {aspectLabel} <span className="caret">▾</span>
          </button>
          {menu === "settings" && (
            <div className="pop up composer-settings-pop" style={{ minWidth: 360, padding: 14 }}>
              <div className="pop-section" style={{ padding: "0 0 8px" }}>
                {t("composer.quality")}
              </div>
              <div className="seg">
                {QUALITY.map((q) => (
                  <button
                    key={q.id}
                    className={`setting-option-tooltip quality-option${quality === q.id ? " on" : ""}`}
                    data-tooltip={t(QUALITY_TOOLTIP_KEYS[q.id])}
                    aria-label={`${t(QUALITY_KEYS[q.id])} ${q.res}. ${t(QUALITY_TOOLTIP_KEYS[q.id])}`}
                    onClick={() => {
                      setQuality(q.id);
                      setConfig({ resolution: q.res });
                    }}
                  >
                    <span>{t(QUALITY_KEYS[q.id])}</span>
                    <small>{q.res}</small>
                  </button>
                ))}
              </div>
              <div className="pop-section" style={{ padding: "14px 0 0" }}>
                {t("composer.aspect")}
              </div>
              <div className="aspect-grid">
                <button
                  className={`aspect-cell setting-option-tooltip ${aspectSel === "auto" ? "on" : ""}`}
                  data-tooltip={t("composer.aspectTip.auto")}
                  aria-label={`${t("composer.auto")}. ${t("composer.aspectTip.auto")}`}
                  onClick={() => {
                    setAspectSel("auto");
                    setConfig({ aspect: "16:9" });
                  }}
                >
                  <span className="aspect-icon" style={{ width: 20, height: 14 }} />
                  {t("composer.auto")}
                </button>
                {ASPECTS.map((a) => (
                  <button
                    key={a.value}
                    className={`aspect-cell setting-option-tooltip ${aspectSel === a.value ? "on" : ""}`}
                    data-tooltip={t(a.tip)}
                    aria-label={`${a.label}. ${t(a.tip)}`}
                    onClick={() => {
                      setAspectSel(a.value);
                      setConfig({ aspect: a.value });
                    }}
                  >
                    <span className="aspect-icon" style={{ width: a.w, height: a.h }} />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="spacer" />

        <button className="cbtn icononly" title={t("composer.voiceSoon")} disabled>
          🎙
        </button>
        <button
          className="send-btn"
          disabled={submitDisabled}
          onClick={submitComposer}
          title={missingRequiredSlots.length ? t("scenario.missingMaterial") : t("composer.generateHint")}
        >
          {running || uploading ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}
