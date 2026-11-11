import { test } from "node:test";
import assert from "node:assert";
import { identify, sameProduct } from "../lib/marketplace/identity";
import { sameCategory } from "../lib/marketplace/anomaly";

/**
 * Titles from a live "AirPods Pro" search on eBay.de (2026-11-11): German
 * generations, complete sets that name their case, and eBay's two categories
 * for the same earbuds.
 */

const Q = "AirPods Pro";
const gen = (title: string, q = Q) => identify(title, q).generation;

test("generation: German ordinals and words, as eBay.de titles write them", () => {
  assert.equal(gen("Apple AirPods Pro (2. Generation) MTJV3ZM/A In-Ear Bluetooth Weiß / USB C"), 2);
  assert.equal(gen("Apple AirPods Pro (2. Gen) In-Ear Kopfhörer weiß mit MagSafe USB-C"), 2);
  assert.equal(gen("Apple AirPods Pro 1. Generation In-Ear-Kopfhörer"), 1);
  assert.equal(gen("Apple AirPods Pro Erste Generation"), 1);
  assert.equal(gen("Apple Airpods Pro 3. Generation, Top Zustand mit Originalverpackung !"), 3);
  assert.equal(gen("Apple AirPods Pro 3 (3rd Generation) Wireless Earbuds Refurbished"), 3);
});

test("generation: the number straight after the model", () => {
  assert.equal(gen("Apple AirPods Pro 3 In-Ear Bluetooth Kopfhörer mit Ladecase Weiß"), 3);
  assert.equal(gen("Apple AirPods Pro 2 mit USB-C MagSafe Ladecase Weiß"), 2);
  assert.equal(gen("Apple AirPods Pro2 2022 2. generation A2700 weiß mit MagSafe Case"), 2);
  assert.equal(gen("Apple AirPod’s pro 3"), 3);
  assert.equal(gen("Nintendo Switch 2 Konsole", "Nintendo Switch"), 2);
});

test("generation: not a size, a count, a year, a list or a range", () => {
  assert.equal(gen("Apple AirPods Pro In-Ear-Kopfhörer Weiß Bluetooth"), undefined, "none stated");
  assert.equal(gen("AirPods Pro 2022 Ladecase"), undefined, "a year");
  assert.equal(gen("AirPods Pro 2er Set"), undefined);
  assert.equal(gen("AirPods Pro 2 Stück"), undefined);
  assert.equal(gen("For Apple AirPods Pro 1/2/3 Ear Hook"), undefined);
  assert.equal(gen("Sony A7 III 28-70 Kit", "Sony A7 III"), undefined);
  assert.equal(gen("Sony A7 III 24 MP", "Sony A7 III"), undefined);
  assert.equal(gen("iPad 10.9 Zoll WiFi", "iPad"), undefined);
  assert.equal(gen("Nintendo Switch OLED 64 GB", "Nintendo Switch OLED"), undefined);
  assert.equal(gen("iPhone 15 128GB Schwarz", "iPhone 15"), undefined, "the model ends in its own number");
  assert.equal(gen("ThinkPad X1 Carbon Gen 11", "ThinkPad X1"), 11, "a stated generation still counts");
});

test("generation: a Pro 1 is never the same product as a Pro 3", () => {
  const pro1 = identify("Apple AirPods Pro Erste Generation", Q);
  const pro3 = identify("Apple AirPods Pro 3 In-Ear Bluetooth Kopfhörer mit Ladecase Weiß", Q);
  const unknown = identify("Apple AirPods Pro In-Ear-Kopfhörer Weiß Bluetooth", Q);
  assert.equal(sameProduct(pro1, pro3), false);
  assert.equal(sameProduct(pro1, unknown), true, "an unknown generation never conflicts");
});

test("a complete set that names its case is the product", () => {
  for (const title of [
    "Apple AirPods Pro 3 mit MagSafe Case (USB-C) weiß",
    "Apple AirPods Pro2 2022 2. generation A2700 weiß mit MagSafe Case",
    "Apple AirPods Pro 3 In-Ear-Kopfhörer Kabellos Bluetooth USB‑C Ladecase Weiß",
    "Apple Airpods Pro 2 Bluetooth Kopfhörer Lightning Case Original Wireless ANC",
    "Apple AirPods Pro 1. Generation Kopfhörer A2083 A2084 Ladecase A2190 #70",
    "Apple AirPods Pro 2 mit USB-C MagSafe Ladecase Weiß",
  ]) {
    assert.equal(identify(title, Q).kind, "product", title);
  }
});

test("the case alone, or an accessory, still isn't", () => {
  for (const title of [
    "Original Apple AirPod Pro 2 Lightning Ladecase Airpods A2970",
    "Apple AirPods Pro 2. Generation Ladecase A2968 Case LEER USB-C #18",
    "Original Apple AirPod Pro Ladecase Airpods Pro Ladegerät Hülle",
    "Silikon Case für AirPods Pro Kopfhörer",
    "AirPods Pro Kopfhörer Schutzhülle Case",
    "Clear TPU Case for AirPods 4/5 2026, Pro3, Pro2, Pro, AirPods3, Shockproof",
    "Apple AirPods Pro (1. Generation) A2084 – Links – Original",
  ]) {
    assert.notEqual(identify(title, Q).kind, "product", title);
  }
});

test("category: eBay's Headsets hold the same earbuds as Kopfhörer; other categories stay apart", () => {
  const kopfhoerer = { id: "112529", name: "Kopfhörer" };
  assert.equal(sameCategory({ id: "80077", name: "Headsets" }, kopfhoerer), true);
  assert.equal(sameCategory({ id: "112529", name: "Kopfhörer" }, kopfhoerer), true);
  assert.equal(sameCategory({ id: "99", name: "Kopfhörer-Teile" }, kopfhoerer), false);
  assert.equal(sameCategory({ id: "88433", name: "Sonstige" }, kopfhoerer), false);
  assert.equal(sameCategory({ id: "139973", name: "Videospiele" }, { id: "139971", name: "Konsolen" }), false);
});
