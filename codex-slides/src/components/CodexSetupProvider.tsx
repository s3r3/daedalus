"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import CodexSetup from "@/components/CodexSetup";

/** Once the user has seen the setup dialog, we don't auto-open it again. */
const SEEN_KEY = "codex-slides-setup-seen";

interface CodexSetupValue {
  openSetup: () => void;
  closeSetup: () => void;
}

const CodexSetupContext = createContext<CodexSetupValue | null>(null);

export function useCodexSetup(): CodexSetupValue {
  const value = useContext(CodexSetupContext);
  if (!value) throw new Error("useCodexSetup must be used within CodexSetupProvider");
  return value;
}

/**
 * Owns the Codex setup dialog so it can be opened from anywhere in the tree —
 * first run (auto), Settings, or the composer's Codex button. Auto-opens once
 * per browser until dismissed; after that it stays a click away.
 */
export default function CodexSetupProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  const openSetup = useCallback(() => setOpen(true), []);

  const closeSetup = useCallback(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* storage unavailable — first-run prompt just repeats next visit */
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <CodexSetupContext.Provider value={{ openSetup, closeSetup }}>
      {children}
      {open && <CodexSetup onClose={closeSetup} />}
    </CodexSetupContext.Provider>
  );
}
