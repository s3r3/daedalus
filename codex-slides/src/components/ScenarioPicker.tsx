"use client";

import {
  ArrowsClockwise,
  Books,
  Briefcase,
  CalendarDots,
  ChartDonut,
  ChartLineUp,
  Check,
  CurrencyDollar,
  FileText,
  GraduationCap,
  Images,
  Layout,
  MagicWand,
  MagnifyingGlass,
  Megaphone,
  Notebook,
  PaintBrush,
  PresentationChart,
  RocketLaunch,
  Rows,
  Sparkle,
  SquaresFour,
  Stack,
  Translate,
  TrendUp,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import {
  FEATURED_SCENARIOS,
  PRESENTATION_SCENARIOS,
  SCENARIO_GROUPS,
  getScenarioGroup,
  scenarioText,
  type PresentationScenario,
  type ScenarioGroupId,
  type ScenarioIcon,
} from "@/lib/scenarios";

const ICONS: Record<ScenarioIcon, typeof Sparkle> = {
  sparkle: Sparkle,
  report: PresentationChart,
  rocket: RocketLaunch,
  briefcase: Briefcase,
  wand: MagicWand,
  document: FileText,
  notes: Notebook,
  images: Images,
  chart: ChartLineUp,
  calendar: CalendarDots,
  finance: CurrencyDollar,
  survey: ChartDonut,
  search: MagnifyingGlass,
  trend: TrendUp,
  compare: SquaresFour,
  books: Books,
  brand: PaintBrush,
  replica: Layout,
  translate: Translate,
  restructure: Rows,
  training: GraduationCap,
  keynote: Megaphone,
  portfolio: Stack,
  batch: ArrowsClockwise,
};

function ScenarioGlyph({ scenario, size = 19 }: { scenario: PresentationScenario; size?: number }) {
  const Icon = ICONS[scenario.icon];
  return <Icon size={size} weight={scenario.featured ? "fill" : "regular"} />;
}

export default function ScenarioPicker({
  selected,
  onSelect,
  openRequestKey = 0,
}: {
  selected?: string;
  onSelect: (scenario: PresentationScenario) => void;
  /** Increment to open the catalog from a Codex Browser deep link. */
  openRequestKey?: number;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<ScenarioGroupId | "all">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (openRequestKey > 0) setOpen(true);
  }, [openRequestKey]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return PRESENTATION_SCENARIOS.filter((scenario) => {
      if (group !== "all" && scenario.group !== group) return false;
      if (!normalized) return true;
      const haystack = [
        scenario.name["zh-CN"],
        scenario.name.en,
        scenario.name.ja,
        scenario.description["zh-CN"],
        scenario.description.en,
        scenario.description.ja,
        scenario.output["zh-CN"],
        scenario.output.en,
        scenario.output.ja,
        ...scenario.keywords,
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(normalized);
    });
  }, [group, query]);

  function choose(scenario: PresentationScenario) {
    onSelect(scenario);
    setOpen(false);
  }

  return (
    <>
      <div className="scenario-quick" aria-label={t("scenario.quickLabel")}>
        {FEATURED_SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            className={`scenario-quick-card${selected === scenario.id ? " selected" : ""}`}
            onClick={() => onSelect(scenario)}
            aria-pressed={selected === scenario.id}
          >
            <span className="scenario-quick-icon" aria-hidden="true"><ScenarioGlyph scenario={scenario} /></span>
            <span>{scenarioText(scenario.name, locale)}</span>
            {selected === scenario.id && <Check className="scenario-quick-check" size={12} weight="bold" aria-hidden="true" />}
          </button>
        ))}
        <button
          type="button"
          className={`scenario-quick-card scenario-quick-all${selected && !FEATURED_SCENARIOS.some((scenario) => scenario.id === selected) ? " selected" : ""}`}
          onClick={() => setOpen(true)}
        >
          <span className="scenario-quick-icon" aria-hidden="true"><SquaresFour size={19} /></span>
          <span>{t("scenario.all")}</span>
          <small>{PRESENTATION_SCENARIOS.length}</small>
        </button>
      </div>

      {open && (
        <div className="scenario-dialog-backdrop" onMouseDown={() => setOpen(false)}>
          <section
            className="scenario-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scenario-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="scenario-dialog-head">
              <div>
                <span className="scenario-dialog-kicker">Codex Slides</span>
                <h2 id="scenario-dialog-title">{t("scenario.dialogTitle")}</h2>
                <p>{t("scenario.dialogSubtitle", { count: PRESENTATION_SCENARIOS.length })}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label={t("scenario.close")}>
                <X size={18} />
              </button>
            </header>

            <div className="scenario-search">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("scenario.search")}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label={t("scenario.clearSearch")}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="scenario-dialog-body">
              <nav className="scenario-groups" aria-label={t("scenario.groupLabel")}>
                <button
                  type="button"
                  className={group === "all" ? "selected" : ""}
                  onClick={() => setGroup("all")}
                >
                  <span><SquaresFour size={16} /> {t("scenario.allGroup")}</span>
                  <small>{PRESENTATION_SCENARIOS.length}</small>
                </button>
                {SCENARIO_GROUPS.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={group === item.id ? "selected" : ""}
                    onClick={() => setGroup(item.id)}
                  >
                    <span>{scenarioText(item.label, locale)}</span>
                    <small>{PRESENTATION_SCENARIOS.filter((scenario) => scenario.group === item.id).length}</small>
                  </button>
                ))}
              </nav>

              <div className="scenario-results" aria-live="polite">
                <div className="scenario-results-summary">
                  <strong>{group === "all" ? t("scenario.allGroup") : scenarioText(getScenarioGroup(group)!.label, locale)}</strong>
                  <span>{t("scenario.resultCount", { count: results.length })}</span>
                </div>
                {results.length ? (
                  <div className="scenario-grid">
                    {results.map((scenario) => {
                      const groupInfo = getScenarioGroup(scenario.group)!;
                      const isSelected = selected === scenario.id;
                      return (
                        <button
                          type="button"
                          key={scenario.id}
                          className={`scenario-card${isSelected ? " selected" : ""}`}
                          onClick={() => choose(scenario)}
                          aria-pressed={isSelected}
                        >
                          <span className="scenario-card-icon" aria-hidden="true"><ScenarioGlyph scenario={scenario} size={20} /></span>
                          <span className="scenario-card-copy">
                            <span className="scenario-card-meta">{scenarioText(groupInfo.label, locale)}</span>
                            <strong>{scenarioText(scenario.name, locale)}</strong>
                            <span className="scenario-card-desc">{scenarioText(scenario.description, locale)}</span>
                            <span className="scenario-card-output">{t("scenario.output")}: {scenarioText(scenario.output, locale)}</span>
                          </span>
                          {isSelected && <span className="scenario-card-selected"><Check size={13} weight="bold" /></span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="scenario-empty">
                    <MagnifyingGlass size={24} />
                    <strong>{t("scenario.noResults")}</strong>
                    <span>{t("scenario.noResultsHelp")}</span>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
