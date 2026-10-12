"use client";

/**
 * The menu at the top left, beside the logo, laid out like a big shop's
 * catalogue drawer: categories first, then shopping, selling and help. Only
 * what SigPath has (catalog.ts).
 *
 * A modal <dialog>: the browser keeps focus inside it, Escape closes it, and
 * the page behind can't be clicked. A click on the dimmed backdrop closes it
 * too. The category icons arrive rendered from the server, so the icon shapes
 * stay out of the page's script.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { CATEGORIES, MENU_SECTIONS, categoryHref } from "./catalog";
import { useMessages, useSwitchLang } from "./I18n";

function Chevron() {
  return (
    <svg className="catalog-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function CatalogMenu({ categoryIcons }: { categoryIcons: React.ReactNode[] }) {
  const m = useMessages();
  const lang = useSwitchLang();
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const close = () => ref.current?.close();

  // Each link closes the menu as it's followed; this closes it on back and forward too.
  useEffect(() => ref.current?.close(), [pathname]);

  return (
    <>
      <button
        type="button"
        className="catalog-open"
        aria-haspopup="dialog"
        aria-label={m.menu.openLabel}
        onClick={() => ref.current?.showModal()}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <dialog
        ref={ref}
        className="catalog"
        aria-labelledby="catalog-title"
        onClick={(e) => {
          // The dialog box itself is only hit outside the drawer: on the backdrop.
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="catalog-panel">
          <div className="catalog-head">
            <h2 id="catalog-title">{m.menu.title}</h2>
            <button type="button" className="catalog-close" aria-label={m.menu.close} onClick={close}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <nav className="catalog-body" aria-labelledby="catalog-title">
            <section>
              <h3>{m.menu.categories}</h3>
              <ul>
                {CATEGORIES.map((c, i) => (
                  <li key={c.label}>
                    <Link href={categoryHref(c.q)} className="catalog-link" onClick={close}>
                      <span className="catalog-icon">{categoryIcons[i]}</span>
                      <span>{m.home.categories[c.label] ?? c.label}</span>
                      <Chevron />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
            {MENU_SECTIONS.map((s) => (
              <section key={s.links[0].href}>
                <h3>{s.title(m)}</h3>
                <ul>
                  {s.links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className="catalog-link" onClick={close}>
                        <span>{l.label(m)}</span>
                        <Chevron />
                      </Link>
                    </li>
                  ))}
                  {s.links[0].href === "/how" && (
                    <li>
                      <button type="button" className="catalog-link" onClick={lang.switchLang}>
                        <span>{m.menu.language}</span>
                        <span className="catalog-lang" lang={lang.other}>
                          {m.nav.switchTo}
                        </span>
                      </button>
                    </li>
                  )}
                </ul>
              </section>
            ))}
          </nav>
        </div>
      </dialog>
    </>
  );
}
