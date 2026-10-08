"use client";

import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  FileText,
  GlobeHemisphereWest,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AgentToolActivity } from "@/components/AgentToolActivity";
import { Markdown } from "@/components/Markdown";
import type { AgentToolCall } from "@/lib/agentActivity";
import type { ResearchActivity, ResearchProgress, ResearchSource } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

function sourceDomain(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function safeSourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "#";
  } catch {
    return "#";
  }
}

function SourceFavicon({ source }: { source: ResearchSource }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source.url]);
  if (failed) return <GlobeHemisphereWest size={16} />;
  let favicon = "";
  try { favicon = new URL("/favicon.ico", source.url).toString(); } catch { /* fallback below */ }
  if (!favicon) return <GlobeHemisphereWest size={16} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={favicon} alt="" onError={() => setFailed(true)} />;
}

function activityTool(activity: ResearchActivity, t: ReturnType<typeof useI18n>["t"]): AgentToolCall {
  if (activity.kind === "search") {
    return {
      id: activity.id,
      name: "web_search",
      kind: "search",
      label: activity.detail || t("research.searchPreparing"),
      detail: t("research.activityRound", { round: activity.round }),
      state: activity.state,
    };
  }
  if (activity.kind === "writing") {
    return {
      id: activity.id,
      name: "write_markdown",
      kind: "write",
      label: t("research.writingReport"),
      detail: t("research.writingRound", { round: activity.round }),
      state: activity.state,
    };
  }
  return {
    id: activity.id,
    name: "deep_research",
    kind: "tool",
    label: t("research.roundPlan", { round: activity.round }),
    detail: t("research.roundPlanDetail"),
    state: activity.state,
  };
}

function phasePercent(progress: ResearchProgress, outlineStarting: boolean) {
  if (progress.status === "complete") return outlineStarting ? 100 : 96;
  const phaseWeight = progress.phase === "starting"
    ? 0.08
    : progress.phase === "planning"
      ? 0.16
      : progress.phase === "searching"
        ? 0.5
        : progress.phase === "writing"
          ? 0.82
          : 0.9;
  return Math.min(94, Math.max(3, (((Math.max(1, progress.round) - 1) + phaseWeight) / progress.totalRounds) * 96));
}

export default function ResearchStage({
  progress,
  headerPrefix,
  outlineStarting = false,
}: {
  progress: ResearchProgress;
  headerPrefix?: ReactNode;
  outlineStarting?: boolean;
}) {
  const { t } = useI18n();
  const processRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const running = progress.status === "running";
  const percent = phasePercent(progress, outlineStarting);

  useEffect(() => {
    processRef.current?.scrollTo({ top: processRef.current.scrollHeight, behavior: "smooth" });
  }, [progress.activities.length, progress.sources.length]);

  useEffect(() => {
    if (!running) return;
    reportRef.current?.scrollTo({ top: reportRef.current.scrollHeight });
  }, [progress.markdown, running]);

  return (
    <section className="stage research-stage">
      <div className="stage-head without-title">
        {headerPrefix}
        <span className="stage-collapsed-title">{t("research.title")}</span>
        <span className={`research-stage-status ${progress.status}`}>
          {running ? <CircleNotch size={13} className="spin" /> : progress.status === "error" ? <WarningCircle size={13} weight="fill" /> : <CheckCircle size={13} weight="fill" />}
          {progress.status === "complete"
            ? t("research.sourceCount", { count: progress.sources.length })
            : progress.status === "error"
              ? t("research.failed")
              : t("research.stageRound", { round: Math.max(1, progress.round), total: progress.totalRounds })}
        </span>
      </div>

      <div className="research-workspace">
        <header className="research-overview">
          <div className={`research-overview-icon ${progress.status}`}>
            {progress.status === "error" ? <WarningCircle size={24} weight="fill" /> : <MagnifyingGlass size={24} />}
          </div>
          <div className="research-overview-copy">
            <span>{t("research.stageEyebrow")}</span>
            <h1>{progress.status === "complete" ? t("research.completeTitle") : progress.status === "error" ? t("research.failedTitle") : t("research.liveTitle")}</h1>
            <p>{outlineStarting ? t("research.outlineStarting") : progress.status === "complete" ? t("research.completeHelp") : progress.status === "error" ? progress.error || t("research.failedHelp") : t("research.stageHelp")}</p>
          </div>
          <div className="research-overview-metrics">
            <span><strong>{progress.searchCount}</strong>{t("research.searchMetric")}</span>
            <span><strong>{progress.sources.length}</strong>{t("research.sourceMetric")}</span>
          </div>
          <div className="research-overview-progress" aria-label={t("research.progressLabel")}>
            <i style={{ width: `${percent}%` }} />
          </div>
        </header>

        <div className="research-grid">
          <aside className="research-process-panel">
            <div className="research-panel-head">
              <span>
                {running ? <CircleNotch size={15} className="spin" /> : <CheckCircle size={15} weight="fill" />}
                <strong>{t("research.liveProcess")}</strong>
              </span>
              <small>{t("research.activityCount", { count: progress.activities.length })}</small>
            </div>
            <div className="research-process-scroll" ref={processRef} aria-live="polite">
              {progress.activities.length ? (
                <div className="research-activity-list">
                  {progress.activities.map((activity) => (
                    <AgentToolActivity tool={activityTool(activity, t)} key={activity.id} />
                  ))}
                </div>
              ) : (
                <div className="research-process-empty">
                  <CircleNotch size={18} className="spin" />
                  <span>{t("research.startingDetail")}</span>
                </div>
              )}

              <div className="research-sources-head">
                <strong>{t("research.sourcesTitle")}</strong>
                <span>{progress.sources.length}</span>
              </div>
              {progress.sources.length ? (
                <div className="research-source-list">
                  {progress.sources.map((source) => (
                    <a href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer noopener" className="research-source-card" key={source.id || source.url}>
                      <span className="research-source-icon"><SourceFavicon source={source} /></span>
                      <span className="research-source-copy">
                        <small>{sourceDomain(source.url)}</small>
                        <strong>{source.title || sourceDomain(source.url)}</strong>
                        <p>{source.snippet || t("research.sourceFallback")}</p>
                      </span>
                      <ArrowSquareOut size={13} />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="research-source-empty">{t("research.sourcesPending")}</p>
              )}
            </div>
          </aside>

          <main className="research-report-panel">
            <div className="research-panel-head">
              <span><FileText size={15} /><strong>{t("research.reportTitle")}</strong></span>
              <small className={running ? "streaming" : ""}>
                {running ? t("research.reportStreaming") : progress.markdown ? t("research.reportSaved") : t("research.noDocument")}
              </small>
            </div>
            <div className="research-report-scroll" ref={reportRef} aria-live="polite">
              {progress.markdown ? (
                <>
                  <Markdown source={progress.markdown} className="assistant-markdown research-markdown" />
                  {running ? <span className="research-stream-caret" aria-hidden="true" /> : null}
                </>
              ) : (
                <div className="research-report-skeleton">
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <p>{t("research.reportPending")}</p>
                </div>
              )}
            </div>
            <footer className={`research-report-foot ${progress.status}`}>
              {running ? <CircleNotch size={14} className="spin" /> : progress.status === "error" ? <WarningCircle size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}
              <span>{running ? t("research.persisting") : progress.status === "error" ? t("research.partialSaved") : t("research.persisted")}</span>
            </footer>
          </main>
        </div>
      </div>
    </section>
  );
}
