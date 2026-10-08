"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_UI_LOCALE,
  isUiLocale,
  RTL_LOCALES,
  translate,
  UI_LOCALE_STORAGE_KEY,
  type MessageKey,
  type MessageValues,
  type UiLocale,
} from "@/i18n/messages";

interface I18nValue {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export default function I18nProvider({
  children,
  initial = DEFAULT_UI_LOCALE,
}: {
  children: React.ReactNode;
  initial?: UiLocale;
}) {
  const [locale, setLocaleState] = useState<UiLocale>(initial);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
      if (isUiLocale(saved)) setLocaleState(saved);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, next);
    } catch {
      // The in-memory choice still applies for this session.
    }
  }, []);

  const t = useCallback((key: MessageKey, values?: MessageValues) => translate(locale, key, values), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  return value ?? {
    locale: "en",
    setLocale: () => {},
    t: (key, values) => translate("en", key, values),
  };
}
