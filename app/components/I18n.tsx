"use client";

/**
 * The page's language for client components: set once in the layout from the
 * shopper's choice (lib/i18n/lang.ts), read with useMessages(). The switch in
 * the header writes the choice and re-renders the page in the other language.
 */

import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE, LANG_COOKIE_MAX_AGE, type Lang } from "@/lib/i18n/lang";
import { MESSAGES } from "@/lib/i18n/messages";
import { translateCheck } from "@/lib/i18n/checks";

const LangContext = createContext<Lang>("en");

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);
export const useMessages = () => MESSAGES[useContext(LangContext)];
/** A check sentence from the server, in the page's language. */
export function useCheckText() {
  const lang = useContext(LangContext);
  return (text: string) => translateCheck(text, lang);
}

/** The other language, and a switch to it: writes the choice and re-renders the page. */
export function useSwitchLang() {
  const lang = useLang();
  const router = useRouter();
  const other: Lang = lang === "de" ? "en" : "de";
  const switchLang = () => {
    document.cookie = `${LANG_COOKIE}=${other}; path=/; max-age=${LANG_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
    router.refresh();
  };
  return { other, switchLang };
}

/** "DE" on an English page, "EN" on a German one. */
export function LangSwitch() {
  const m = useMessages();
  const { other, switchLang } = useSwitchLang();
  return (
    <button
      type="button"
      className="lang-switch"
      lang={other}
      aria-label={m.nav.switchToLabel}
      data-label={m.nav.switchToLabel}
      onClick={switchLang}
    >
      {other === "de" ? "DE" : "EN"}
    </button>
  );
}
