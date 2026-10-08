"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";

/** Runs the deep-research SSE loop and shows an editable markdown brief (M5). */
export default function ResearchPanel({
  requirement,
  onComplete,
  onCancel,
}: {
  requirement: string;
  onComplete: (doc: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [log, setLog] = useState<string[]>([]);
  const [doc, setDoc] = useState("");
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const draftRound = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  async function run() {
    setRunning(true);
    setLog([]);
    setDoc("");
    draftRound.current = 0;
    try {
      const resp = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirement }),
      });
      if (!resp.ok || !resp.body) throw new Error(await resp.text().catch(() => `HTTP ${resp.status}`));
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "queries") setLog((l) => [...l, t("research.round", { round: ev.round, queries: ev.queries.join(" · ") })]);
          else if (ev.type === "search" && ev.query && ev.state === "complete") setLog((l) => [...l, `  ${t("research.results", { query: ev.query, count: ev.count })}`]);
          else if (ev.type === "synth") setLog((l) => [...l, `  ${t("research.synthesizing", { round: ev.round })}`]);
          else if (ev.type === "delta") setDoc((current) => {
            if (draftRound.current !== ev.round) {
              draftRound.current = ev.round;
              return ev.delta;
            }
            return `${current}${ev.delta}`;
          });
          else if (ev.type === "doc") {
            draftRound.current = ev.round;
            setDoc(ev.markdown);
          }
          else if (ev.type === "error") setLog((l) => [...l, `✗ ${ev.error}`]);
          else if (ev.type === "done") setLog((l) => [...l, t("research.complete")]);
        }
      }
    } catch (e: any) {
      setLog((l) => [...l, `✗ ${e?.message ?? e}`]);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  return (
    <div className="panel" style={{ marginTop: 14, borderColor: "var(--accent-2)" }}>
      <h2>🔍 {t("research.title")} {running ? `(${t("research.running")})` : ""}</h2>
      <div className="log" ref={logRef} style={{ maxHeight: 120 }}>
        {log.length ? log.join("\n") : t("research.starting")}
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>{t("research.brief")}</span>
        <textarea
          style={{ minHeight: 240, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          placeholder={running ? t("research.researching") : t("research.noDocument")}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="ghost" onClick={onCancel} disabled={running}>
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          style={{ flex: 1, width: "auto" }}
          onClick={() => onComplete(doc)}
          disabled={running || !doc.trim()}
        >
          {t("research.generate")}
        </button>
      </div>
    </div>
  );
}
