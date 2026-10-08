"use client";

import {
  ArrowClockwise,
  ArrowLineLeft,
  ArrowRight,
  ArrowsOut,
  CircleHalf,
  Minus,
  X,
} from "@phosphor-icons/react";
import { useEffect } from "react";
import type { SlideTransition } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

const OPTIONS = [
  { id: "none", key: "transition.none", Icon: Minus },
  { id: "fade", key: "transition.fade", Icon: CircleHalf },
  { id: "push", key: "transition.push", Icon: ArrowRight },
  { id: "wipe", key: "transition.wipe", Icon: ArrowLineLeft },
  { id: "zoom", key: "transition.zoom", Icon: ArrowsOut },
  { id: "flip", key: "transition.flip", Icon: ArrowClockwise },
] as const;

export default function TransitionPicker({
  slideIndex,
  value,
  saving,
  error,
  onSelect,
  onClose,
}: {
  slideIndex: number;
  value: SlideTransition;
  saving: boolean;
  error?: string;
  onSelect: (transition: SlideTransition) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-bg transition-modal-bg" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="transition-modal" role="dialog" aria-modal="true" aria-labelledby="transition-title">
        <div className="transition-modal-head">
          <div>
            <h3 id="transition-title">{t("transition.slideTitle", { index: slideIndex })}</h3>
            <p>{t("transition.help")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("transition.close")}><X size={18} /></button>
        </div>
        <div className="transition-grid">
          {OPTIONS.map(({ id, key, Icon }) => {
            const selected = value === id;
            return (
              <button
                key={id}
                type="button"
                className={`transition-option${selected ? " selected" : ""}`}
                onClick={() => onSelect(id)}
                disabled={saving}
                aria-pressed={selected}
                autoFocus={selected}
              >
                <span className={`transition-option-demo transition-demo-${id}`} aria-hidden="true">
                  <Icon size={44} weight="regular" />
                </span>
                <b>{t(key)}</b>
              </button>
            );
          })}
        </div>
        <div className="transition-modal-foot">
          <span className={error ? "transition-error" : ""} role={error ? "alert" : undefined}>
            {error
              ? t("transition.saveFailed", { error })
              : saving
                ? t("transition.saving")
                : t("transition.selected", { transition: t(OPTIONS.find((option) => option.id === value)?.key ?? "transition.none") })}
          </span>
          <button type="button" className="primary" onClick={onClose} disabled={saving}>{t("transition.done")}</button>
        </div>
      </div>
    </div>
  );
}
