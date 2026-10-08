"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/** Conversational edit panel. onSend classifies + applies the edit, returns a reply. */
export default function ChatEditPanel({
  onSend,
  busy,
}: {
  onSend: (message: string) => Promise<string>;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  async function send() {
    const m = text.trim();
    if (!m || busy) return;
    setText("");
    setMsgs((x) => [...x, { role: "user", content: m }]);
    let reply = "";
    try {
      reply = await onSend(m);
    } catch (e: any) {
      reply = `⚠ ${e?.message ?? e}`;
    }
    setMsgs((x) => [...x, { role: "assistant", content: reply }]);
    setTimeout(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight), 0);
  }

  return (
    <div className="panel" style={{ marginTop: 16, borderColor: "var(--accent-2)" }}>
      <h2>💬 {t("chatEdit.title")}</h2>
      {msgs.length > 0 && (
        <div ref={boxRef} className="log" style={{ maxHeight: 200 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <b style={{ color: m.role === "user" ? "var(--text)" : "var(--accent)" }}>
                {m.role === "user" ? t("chatEdit.you") : t("chatEdit.agent")}:
              </b>{" "}
              {m.content}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          placeholder={t("chatEdit.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button className="primary" style={{ width: "auto" }} onClick={send} disabled={busy || !text.trim()}>
          {busy ? t("common.working") : t("common.send")}
        </button>
      </div>
    </div>
  );
}
