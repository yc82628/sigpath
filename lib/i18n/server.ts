import { cookies } from "next/headers";
import { LANG_COOKIE, pickLang, type Lang } from "./lang";
import { MESSAGES, type Messages } from "./messages";

/** The page's language, from the shopper's choice (lib/i18n/lang.ts). Server components only. */
export function getLang(): Lang {
  return pickLang(cookies().get(LANG_COOKIE)?.value);
}

export function getMessages(): Messages {
  return MESSAGES[getLang()];
}
