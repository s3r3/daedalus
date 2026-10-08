"use client";

import {
  CheckCircle,
  FileText,
  Images,
  MagnifyingGlass,
  Question,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Markdown } from "@/components/Markdown";
import { getCommunityTemplate } from "@/lib/community";
import type { DesignFile } from "@/lib/designFiles";
import { CATEGORIES, categoryLabel, getTemplate } from "@/lib/templates";
import { useI18n } from "@/i18n/I18nProvider";
import { COMMUNITY_GROUP_KEYS } from "@/i18n/community";
import { semanticOptionLabel } from "@/lib/questionSemantics";

function FileIcon({ kind }: { kind: DesignFile["kind"] }) {
  if (kind === "questions") return <Question size={17} />;
  if (kind === "inspiration") return <Images size={17} />;
  if (kind === "research") return <MagnifyingGlass size={17} />;
  return <FileText size={17} />;
}

function QuestionsPreview({ file }: { file: Extract<DesignFile, { kind: "questions" }> }) {
  const { t } = useI18n();
  return (
    <div className="workflow-file-document workflow-questions-document">
      {file.answerSummary ? (
        <section className="workflow-file-summary">
          <CheckCircle size={17} weight="fill" />
          <div>
            <strong>{t("designFiles.confirmedAnswers")}</strong>
            <pre>{file.answerSummary}</pre>
          </div>
        </section>
      ) : null}
      <div className="workflow-question-list">
        {file.questions.map((question, index) => (
          <article key={question.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{question.question}</strong>
              {question.options?.length ? (
                <div className="workflow-question-options">
                  {question.options.map((option) => (
                    <small className={option.value === question.recommended ? "recommended" : ""} key={option.value}>
                      {semanticOptionLabel(question, option)}{option.value === question.recommended ? ` · ${t("common.recommended")}` : ""}
                    </small>
                  ))}
                </div>
              ) : question.placeholder ? <p>{question.placeholder}</p> : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function OutlinePreview({ file }: { file: Extract<DesignFile, { kind: "outline" }> }) {
  const { t } = useI18n();
  return (
    <div className="workflow-file-document workflow-outline-document">
      {file.pages.map((page, index) => (
        <article key={`${index}-${page.title}`}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{page.title || t("chat.slide", { index: index + 1 })}</strong>
            {page.points.length ? <ul>{page.points.map((point, pointIndex) => <li key={pointIndex}>{point}</li>)}</ul> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function ResearchPreview({ file }: { file: Extract<DesignFile, { kind: "research" }> }) {
  const { t } = useI18n();
  return file.markdown ? (
    <div className="workflow-file-document workflow-research-document">
      <Markdown source={file.markdown} className="assistant-markdown research-markdown" />
    </div>
  ) : (
    <div className="workflow-file-empty-preview">
      <MagnifyingGlass size={30} />
      <strong>{t("designFiles.researchTitle")}</strong>
      <span>{t("designFiles.researchPending")}</span>
    </div>
  );
}

function InspirationPreview({ file }: { file: Extract<DesignFile, { kind: "inspiration" }> }) {
  const { locale, t } = useI18n();
  const community = getCommunityTemplate(file.selectedTemplateId);
  const curated = community ? undefined : getTemplate(file.selectedTemplateId);
  const candidates = file.candidateTemplateIds
    .map((id) => getCommunityTemplate(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (file.skipped) {
    return (
      <div className="workflow-file-empty-preview">
        <Images size={30} />
        <strong>{t("designFiles.defaultStyle")}</strong>
        <span>{t("designFiles.defaultStyleHelp")}</span>
      </div>
    );
  }

  if (community) {
    return (
      <div className="workflow-inspiration-preview">
        <div className="workflow-inspiration-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={community.cover} alt={community.name} />
        </div>
        <div className="workflow-inspiration-copy">
          <span>{t(COMMUNITY_GROUP_KEYS[community.group])}</span>
          <h2>{community.name}</h2>
          <p>{community.description}</p>
          <small>{community.styleBlock}</small>
        </div>
      </div>
    );
  }

  if (curated) {
    return (
      <div className="workflow-curated-preview">
        <div className="workflow-curated-palette" aria-label={t("designFiles.templatePalette")}>
          {curated.palette.map((color) => <i key={color} style={{ background: color }} title={color} />)}
        </div>
        <span>{(() => {
          const category = CATEGORIES.find((item) => item.id === curated.categoryId);
          return category ? categoryLabel(category, locale) : curated.categoryId;
        })()}</span>
        <h2>{curated.name}</h2>
        <p>{curated.description}</p>
        <small>{curated.styleBlock}</small>
      </div>
    );
  }

  return (
    <div className="workflow-inspiration-grid">
      {candidates.map((candidate) => (
        <article key={candidate.id}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={candidate.cover} alt="" />
          <strong>{candidate.name}</strong>
          <span>{t(COMMUNITY_GROUP_KEYS[candidate.group])}</span>
        </article>
      ))}
    </div>
  );
}

export function DesignFilePreview({ file }: { file: DesignFile }) {
  if (file.kind === "questions") return <QuestionsPreview file={file} />;
  if (file.kind === "outline") return <OutlinePreview file={file} />;
  if (file.kind === "research") return <ResearchPreview file={file} />;
  return <InspirationPreview file={file} />;
}

export default function DesignFilesPanel({
  files,
  selectedId,
  onSelect,
  headerPrefix,
}: {
  files: DesignFile[];
  selectedId?: string;
  onSelect: (id: string) => void;
  headerPrefix?: ReactNode;
}) {
  const { t } = useI18n();
  const selected = files.find((file) => file.id === selectedId) ?? files[0];

  return (
    <section className="stage workflow-files-stage">
      <div className="stage-head">
        {headerPrefix}
        <span className="title">{t("designFiles.title")}</span>
        <span className="count">{t(files.length === 1 ? "designFiles.itemCountOne" : "designFiles.itemCountMany", { count: files.length })}</span>
      </div>
      <div className="workflow-files-workspace">
        <aside className="workflow-files-list" aria-label={t("designFiles.list")}>
          <div className="workflow-files-list-head">
            <strong>{t("designFiles.referenceFiles")}</strong>
            <span>{files.length}</span>
          </div>
          {files.map((file) => (
            <button
              type="button"
              className={file.id === selected?.id ? "active" : ""}
              onClick={() => onSelect(file.id)}
              key={file.id}
            >
              <span className="workflow-file-icon"><FileIcon kind={file.kind} /></span>
              <span className="workflow-file-list-copy">
                <strong>{file.title}</strong>
                <small>{file.subtitle}</small>
              </span>
            </button>
          ))}
          {!files.length ? <p>{t("designFiles.workflowEmpty")}</p> : null}
        </aside>
        <main className="workflow-file-preview">
          {selected ? (
            <>
              <header className="workflow-file-preview-head">
                <span className="workflow-file-icon"><FileIcon kind={selected.kind} /></span>
                <span>
                  <strong>{selected.title}</strong>
                  <small>{selected.subtitle}</small>
                </span>
              </header>
              <div className="workflow-file-preview-body">
                <DesignFilePreview file={selected} />
              </div>
            </>
          ) : (
            <div className="workflow-file-empty-preview">
              <FileText size={30} />
              <strong>{t("designFiles.noPreview")}</strong>
              <span>{t("designFiles.noPreviewHelp")}</span>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
