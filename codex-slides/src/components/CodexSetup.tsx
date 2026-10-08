"use client";

import {
  ArrowClockwise,
  Check,
  Copy,
  Cpu,
  FileArrowDown,
  ImageSquare,
  Monitor,
  Sparkle,
  Terminal,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n/I18nProvider";

interface CodexStatus {
  ready: boolean;
  tokenPresent: boolean;
  cliAvailable: boolean;
  cliPath: string | null;
}

/**
 * Codex connection dialog. Detects the local Codex (ChatGPT token the CLI
 * stored at ~/.codex/auth.json, plus the `codex` binary on PATH), guides the
 * user to sign in or to use the Codex desktop app, and showcases the core
 * capabilities Codex powers here. Reachable on first run, from Settings, and
 * from the composer's Codex button. Dismissible — the product is zero-config.
 */
export default function CodexSetup({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);
  const isDesktop =
    typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);

  useEffect(() => setMounted(true), []);

  const detect = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
      const data = await response.json();
      const codex = data.codex ?? {};
      setStatus({
        ready: Boolean(data.codexReady),
        tokenPresent: Boolean(codex.tokenPresent ?? data.codexReady),
        cliAvailable: Boolean(codex.cliAvailable),
        cliPath: codex.cliPath ?? null,
      });
    } catch {
      setStatus({ ready: false, tokenPresent: false, cliAvailable: false, cliPath: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyLogin = useCallback(async () => {
    try {
      await navigator.clipboard.writeText("codex login");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const ready = status?.ready ?? false;

  const capabilities = [
    { icon: <Cpu size={18} weight="duotone" />, title: t("codexSetup.capAgent"), body: t("codexSetup.capAgentBody") },
    { icon: <ImageSquare size={18} weight="duotone" />, title: t("codexSetup.capImage"), body: t("codexSetup.capImageBody") },
    { icon: <Sparkle size={18} weight="duotone" />, title: t("codexSetup.capResearch"), body: t("codexSetup.capResearchBody") },
    { icon: <FileArrowDown size={18} weight="duotone" />, title: t("codexSetup.capExport"), body: t("codexSetup.capExportBody") },
  ];

  if (!mounted) return null;

  return createPortal(
    <div
      className="codex-setup-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("codexSetup.title")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="codex-setup" onMouseDown={(event) => event.stopPropagation()}>
        <button className="codex-setup-close" onClick={onClose} aria-label={t("codexSetup.close")}>
          <X size={16} />
        </button>

        <header className="codex-setup-head">
          <span className="codex-setup-mark" aria-hidden="true">
            <Terminal size={20} weight="bold" />
          </span>
          <div>
            <strong>{t("codexSetup.title")}</strong>
            <span>{t("codexSetup.subtitle")}</span>
          </div>
        </header>

        <section className={`codex-detect${ready ? " ok" : loading ? "" : " warn"}`}>
          <div className="codex-detect-status">
            <span className="codex-detect-dot" aria-hidden="true" />
            <div className="codex-detect-copy">
              <strong>
                {loading
                  ? t("codexSetup.detecting")
                  : ready
                    ? t("codexSetup.readyTitle")
                    : t("codexSetup.notReadyTitle")}
              </strong>
              <span>{ready ? t("codexSetup.readyBody") : t("codexSetup.notReadyBody")}</span>
            </div>
            <button className="codex-redetect" onClick={detect} disabled={loading}>
              <ArrowClockwise size={14} weight="bold" className={loading ? "spin" : ""} />
              {t("codexSetup.redetect")}
            </button>
          </div>
          <ul className="codex-detect-checks">
            <li className={status?.tokenPresent ? "on" : "off"}>
              <span className="codex-check-icon" aria-hidden="true">
                {status?.tokenPresent ? <Check size={13} weight="bold" /> : <X size={12} weight="bold" />}
              </span>
              <span className="codex-check-label">{t("codexSetup.tokenLabel")}</span>
              <em>{status?.tokenPresent ? t("codexSetup.tokenReady") : t("codexSetup.tokenMissing")}</em>
            </li>
            <li className={status?.cliAvailable ? "on" : "off"}>
              <span className="codex-check-icon" aria-hidden="true">
                {status?.cliAvailable ? <Check size={13} weight="bold" /> : <X size={12} weight="bold" />}
              </span>
              <span className="codex-check-label">{t("codexSetup.cliLabel")}</span>
              <em title={status?.cliPath ?? undefined}>
                {status?.cliAvailable ? status?.cliPath ?? t("codexSetup.cliReady") : t("codexSetup.cliMissing")}
              </em>
            </li>
          </ul>
        </section>

        <div className="codex-options">
          <section className="codex-option">
            <div className="codex-option-icon"><Terminal size={17} weight="bold" /></div>
            <strong>{t("codexSetup.optionLocalTitle")}</strong>
            <p>{t("codexSetup.optionLocalBody")}</p>
            {ready ? (
              <button className="codex-option-cta primary" onClick={onClose}>
                <Check size={15} weight="bold" /> {t("codexSetup.optionLocalCta")}
              </button>
            ) : (
              <div className="codex-cmd">
                <span className="codex-cmd-hint">{t("codexSetup.optionLocalStep")}</span>
                <div className="codex-cmd-row">
                  <code>codex login</code>
                  <button onClick={copyLogin} aria-label={t("codexSetup.copy")}>
                    {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                    {copied ? t("codexSetup.copied") : t("codexSetup.copy")}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className={`codex-option${isDesktop ? " current" : ""}`}>
            <div className="codex-option-icon"><Monitor size={17} weight="bold" /></div>
            <strong>{t("codexSetup.optionDesktopTitle")}</strong>
            <p>{isDesktop ? t("codexSetup.optionDesktopHere") : t("codexSetup.optionDesktopBody")}</p>
            {isDesktop && (
              <span className="codex-option-badge">
                <Check size={13} weight="bold" /> {t("codexSetup.optionDesktopBadge")}
              </span>
            )}
          </section>
        </div>

        <section className="codex-caps">
          <div className="codex-caps-title">{t("codexSetup.capabilitiesTitle")}</div>
          <div className="codex-caps-grid">
            {capabilities.map((cap) => (
              <div className="codex-cap" key={cap.title}>
                <span className="codex-cap-icon">{cap.icon}</span>
                <div className="codex-cap-copy">
                  <strong>{cap.title}</strong>
                  <span>{cap.body}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="codex-setup-foot">
          <button className="codex-skip" onClick={onClose}>
            {t("codexSetup.skip")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
