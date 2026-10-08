"use client";

import { Lightning, MagicWand, MagnifyingGlass, Palette, SlidersHorizontal, StackSimple, X } from "@phosphor-icons/react";
import type { ContextOptionItem } from "@/lib/types";
import { useI18n } from "@/i18n/I18nProvider";

function OptionIcon({ kind }: { kind: ContextOptionItem["kind"] }) {
  if (kind === "research") return <MagnifyingGlass size={13} />;
  if (kind === "scenario") return <MagicWand size={13} />;
  if (kind === "style") return <Palette size={13} />;
  if (kind === "template") return <StackSimple size={13} />;
  if (kind === "speed") return <Lightning size={13} weight="fill" />;
  return <SlidersHorizontal size={13} />;
}

/** Non-file inputs (research, design, and generation settings) shown as context chips. */
export default function ContextOptionItems({
  items,
  onRemove,
  compact = false,
}: {
  items: ContextOptionItem[];
  onRemove?: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <div className={`context-option-items${compact ? " compact" : ""}`}>
      {items.map((item) => (
        <div
          className="context-option-item"
          key={item.id}
          title={item.value ? `${item.label}: ${item.value}` : item.label}
        >
          <span className="context-option-icon" aria-hidden="true">
            <OptionIcon kind={item.kind} />
          </span>
          <span className="context-option-label">{item.label}</span>
          {item.value && <span className="context-option-value">{item.value}</span>}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label={t("context.remove", { name: `${item.label}${item.value ? ` ${item.value}` : ""}` })}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
