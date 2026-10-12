/**
 * What SigPath offers, as the menu at the top left lists it (CatalogMenu) and
 * the home page's category tiles: only pages that exist, nothing for accounts
 * or settings SigPath doesn't have.
 */

import type { IconName } from "./icon-paths";
import type { Messages } from "@/lib/i18n/messages";

/** A category is a search for a product that shows it well. The label is translated by m.home.categories. */
export const CATEGORIES: { label: string; q: string; icon: IconName }[] = [
  { label: "Headphones", q: "AirPods Pro", icon: "headphones" },
  { label: "Phones", q: "iPhone 15", icon: "device-mobile" },
  { label: "Laptops", q: "ThinkPad X1", icon: "laptop" },
  { label: "Gaming", q: "Nintendo Switch OLED", icon: "game-controller" },
  { label: "Sneakers", q: "Nike Air Max 90", icon: "sneaker" },
  { label: "Watches", q: "Apple Watch", icon: "watch" },
  { label: "Cameras", q: "Sony A7 III", icon: "camera" },
  { label: "Handmade", q: "handmade ceramic mug", icon: "gift" },
];

export const categoryHref = (q: string) => `/search?q=${encodeURIComponent(q)}`;

type Section = { title: (m: Messages) => string; links: { href: string; label: (m: Messages) => string }[] };

/** The menu's sections after the categories. */
export const MENU_SECTIONS: Section[] = [
  {
    title: (m) => m.menu.shop,
    links: [
      { href: "/search", label: (m) => m.menu.search },
      { href: "/check", label: (m) => m.menu.check },
      { href: "/cart", label: (m) => m.menu.cart },
      { href: "/alerts", label: (m) => m.menu.alerts },
    ],
  },
  {
    title: (m) => m.menu.sell,
    links: [
      { href: "/seller/verify", label: (m) => m.menu.verifySeller },
      { href: "/seller/business", label: (m) => m.menu.verifyBusiness },
      { href: "/suppliers", label: (m) => m.menu.supplier },
      { href: "/developers", label: (m) => m.menu.api },
    ],
  },
  {
    title: (m) => m.menu.help,
    links: [
      { href: "/how", label: (m) => m.menu.how },
      { href: "/privacy", label: (m) => m.menu.privacy },
      { href: "/impressum", label: (m) => m.menu.impressum },
    ],
  },
];
