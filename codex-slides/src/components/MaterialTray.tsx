"use client";

import { useRef, useState } from "react";
import { ImageSquare, UploadSimple, X } from "@phosphor-icons/react";
import { useI18n } from "@/i18n/I18nProvider";

export interface MaterialTrayItem {
  id: string;
  name: string;
  url: string;
}

/** Upload brand references (logo / product shot / visual sample) to guide the restyle. */
export default function MaterialTray({
  initialItems = [],
  disabled = false,
  onChange,
  onItemsChange,
}: {
  initialItems?: MaterialTrayItem[];
  disabled?: boolean;
  onChange?: (ids: string[]) => void;
  onItemsChange?: (items: MaterialTrayItem[]) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<MaterialTrayItem[]>(initialItems);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const next = [...items];
    for (const file of Array.from(files)) {
      try {
        const body = new FormData();
        body.append("image", file);
        const response = await fetch("/api/materials", { method: "POST", body });
        const data = await response.json();
        if (response.ok) next.push({ id: data.id, name: data.name, url: data.url });
      } catch {
        /* Let the remaining files continue uploading. */
      }
    }
    setItems(next);
    onChange?.(next.map((item) => item.id));
    onItemsChange?.(next);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(id: string) {
    if (disabled) return;
    const next = items.filter((item) => item.id !== id);
    setItems(next);
    onChange?.(next.map((item) => item.id));
    onItemsChange?.(next);
  }

  return (
    <section className="material-field" aria-labelledby="brand-reference-label">
      <div className="restyle-field-head">
        <label id="brand-reference-label">{t("material.title")}</label>
        <span>{t("material.optional")}</span>
      </div>
      <p className="material-help">{t("material.help")}</p>
      <div className="material-list">
        {items.map((item) => (
          <div className="material-item" key={item.id} title={item.name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt={item.name} />
            <button type="button" disabled={disabled} onClick={() => remove(item.id)} aria-label={t("material.remove", { name: item.name })}>
              <X size={12} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`material-add${items.length ? " compact" : ""}`}
          disabled={busy || disabled}
          aria-label={items.length ? t("material.addMore") : t("material.add")}
          onClick={() => inputRef.current?.click()}
        >
          {items.length ? <UploadSimple size={20} /> : <ImageSquare size={22} />}
          <span>
            <strong>{busy ? t("material.uploading") : items.length ? t("material.addMoreShort") : t("material.add")}</strong>
            {!items.length && <small>{t("material.guidance")}</small>}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            if (!disabled) void upload(event.target.files);
          }}
        />
      </div>
    </section>
  );
}
