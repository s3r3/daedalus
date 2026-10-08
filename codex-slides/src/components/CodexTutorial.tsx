"use client";

import {
  ArrowRight,
  Browser,
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  ListChecks,
  MagicWand,
  Palette,
  PencilSimpleLine,
  Presentation,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";

const STEP_ICONS = [Browser, Presentation, ListChecks, ListChecks, Palette, PencilSimpleLine, MagicWand];

const STEPS: Array<{
  title: MessageKey;
  body: MessageKey;
  prompt: MessageKey;
}> = Array.from({ length: 7 }, (_, index) => ({
  title: `tutorial.step${index + 1}.title` as MessageKey,
  body: `tutorial.step${index + 1}.body` as MessageKey,
  prompt: `tutorial.step${index + 1}.prompt` as MessageKey,
}));

const PROMPTS: Array<{ title: MessageKey; prompt: MessageKey }> = [
  { title: "tutorial.prompt.generate.title", prompt: "tutorial.prompt.generate.body" },
  { title: "tutorial.prompt.sources.title", prompt: "tutorial.prompt.sources.body" },
  { title: "tutorial.prompt.outline.title", prompt: "tutorial.prompt.outline.body" },
  { title: "tutorial.prompt.content.title", prompt: "tutorial.prompt.content.body" },
  { title: "tutorial.prompt.structure.title", prompt: "tutorial.prompt.structure.body" },
  { title: "tutorial.prompt.visual.title", prompt: "tutorial.prompt.visual.body" },
  { title: "tutorial.prompt.mark.title", prompt: "tutorial.prompt.mark.body" },
  { title: "tutorial.prompt.brand.title", prompt: "tutorial.prompt.brand.body" },
];

export default function CodexTutorial() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"guide" | "prompts">("guide");
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tutorial") === "codex") setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (tab !== "guide") return;
      if (event.key === "ArrowLeft") setStep((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setStep((value) => Math.min(STEPS.length - 1, value + 1));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, tab]);

  async function copyPrompt(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? "" : current)), 1600);
    } catch {
      setCopied("");
    }
  }

  const current = STEPS[step];
  const CurrentIcon = STEP_ICONS[step];

  return (
    <>
      <button type="button" className="codex-tutorial-entry" onClick={() => setOpen(true)}>
        <span className="codex-tutorial-entry-icon" aria-hidden="true"><Browser size={22} weight="duotone" /></span>
        <span className="codex-tutorial-entry-copy">
          <small>{t("tutorial.entry.eyebrow")}</small>
          <strong>{t("tutorial.entry.title")}</strong>
          <span>{t("tutorial.entry.body")}</span>
        </span>
        <span className="codex-tutorial-entry-action">
          {t("tutorial.entry.cta")} <ArrowRight size={15} weight="bold" aria-hidden="true" />
        </span>
      </button>

      {open && (
        <div className="codex-tutorial-backdrop" onMouseDown={() => setOpen(false)}>
          <section
            className="codex-tutorial-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-tutorial-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="codex-tutorial-head">
              <div>
                <span className="codex-tutorial-kicker"><Sparkle size={13} weight="fill" /> {t("tutorial.dialog.kicker")}</span>
                <h2 id="codex-tutorial-title">{t("tutorial.dialog.title")}</h2>
                <p>{t("tutorial.dialog.subtitle")}</p>
              </div>
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label={t("tutorial.dialog.close")}>
                <X size={18} />
              </button>
            </header>

            <div className="codex-tutorial-tabs" role="tablist" aria-label={t("tutorial.tabs.label")}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "guide"}
                className={tab === "guide" ? "active" : ""}
                onClick={() => setTab("guide")}
              >
                <ListChecks size={16} /> {t("tutorial.tabs.guide")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "prompts"}
                className={tab === "prompts" ? "active" : ""}
                onClick={() => setTab("prompts")}
              >
                <MagicWand size={16} /> {t("tutorial.tabs.prompts")}
              </button>
            </div>

            {tab === "guide" ? (
              <div className="codex-tutorial-guide">
                <nav className="codex-tutorial-steps" aria-label={t("tutorial.steps.label")}>
                  {STEPS.map((item, index) => {
                    const Icon = STEP_ICONS[index];
                    return (
                      <button
                        type="button"
                        key={item.title}
                        className={step === index ? "active" : ""}
                        aria-current={step === index ? "step" : undefined}
                        onClick={() => setStep(index)}
                      >
                        <span>{index + 1}</span>
                        <Icon size={16} aria-hidden="true" />
                        <strong>{t(item.title)}</strong>
                      </button>
                    );
                  })}
                </nav>

                <article className="codex-tutorial-step">
                  <div className="codex-tutorial-step-icon"><CurrentIcon size={25} weight="duotone" /></div>
                  <span className="codex-tutorial-step-count">{t("tutorial.stepCount", { current: step + 1, total: STEPS.length })}</span>
                  <h3>{t(current.title)}</h3>
                  <p>{t(current.body)}</p>

                  {step === 0 && (
                    <div className="codex-tutorial-rule">
                      <strong>{t("tutorial.browserFirst.title")}</strong>
                      <span>{t("tutorial.browserFirst.body")}</span>
                    </div>
                  )}

                  <div className="codex-tutorial-prompt">
                    <div>
                      <span>{t("tutorial.sayInCodex")}</span>
                      <button type="button" onClick={() => copyPrompt(t(current.prompt), `step-${step}`)}>
                        {copied === `step-${step}` ? <Check size={14} /> : <Copy size={14} />}
                        {copied === `step-${step}` ? t("tutorial.copied") : t("tutorial.copy")}
                      </button>
                    </div>
                    <pre>{t(current.prompt)}</pre>
                  </div>

                  <footer>
                    <button type="button" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>
                      <CaretLeft size={15} /> {t("tutorial.previous")}
                    </button>
                    {step < STEPS.length - 1 ? (
                      <button type="button" className="primary" onClick={() => setStep((value) => value + 1)}>
                        {t("tutorial.next")} <CaretRight size={15} />
                      </button>
                    ) : (
                      <button type="button" className="primary" onClick={() => setTab("prompts")}>
                        {t("tutorial.openPrompts")} <ArrowRight size={15} />
                      </button>
                    )}
                  </footer>
                </article>
              </div>
            ) : (
              <div className="codex-tutorial-library">
                <div className="codex-tutorial-library-head">
                  <span><MagicWand size={18} weight="duotone" /></span>
                  <div>
                    <h3>{t("tutorial.library.title")}</h3>
                    <p>{t("tutorial.library.body")}</p>
                  </div>
                </div>
                <div className="codex-tutorial-prompt-grid">
                  {PROMPTS.map((item, index) => (
                    <article key={item.title}>
                      <header>
                        <strong>{t(item.title)}</strong>
                        <button type="button" onClick={() => copyPrompt(t(item.prompt), `prompt-${index}`)}>
                          {copied === `prompt-${index}` ? <Check size={14} /> : <Copy size={14} />}
                          {copied === `prompt-${index}` ? t("tutorial.copied") : t("tutorial.copy")}
                        </button>
                      </header>
                      <p>{t(item.prompt)}</p>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
