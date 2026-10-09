import { test } from "node:test";
import assert from "node:assert";
import { encode } from "jpeg-js";
import { analyse, mainCategory } from "../lib/marketplace/anomaly";
import { identify } from "../lib/marketplace/identity";
import { checkPhotos, ebayImageId } from "../lib/marketplace/sources/ebay";
import { dHash, groupHashes, hamming, isStudioShot, MAX_DISTANCE } from "../lib/marketplace/photo";
import { listingKey, type Listing, type SourceResult } from "../lib/marketplace/types";

/**
 * Regressions found on live eBay.de data (9 October 2026): a "PlayStation 5"
 * search flagged games, controllers, a spare HDMI port and a repair service as
 * suspiciously cheap consoles, and no real listing's photo was ever compared.
 * The titles and categories below are real ones from that search.
 */

const CONSOLES = { id: "139971", name: "Konsolen" };
const GAMES = { id: "139973", name: "PC- & Videospiele" };
const CONTROLLERS = { id: "117042", name: "Controller" };
const PARTS = { id: "171833", name: "Ersatzteile & Werkzeuge" };

let n = 0;
function ebay(title: string, euros: number, category?: { id: string; name: string }, over: Partial<Listing> = {}): Listing {
  n++;
  return {
    id: `e${n}`,
    source: "ebay",
    title,
    url: `https://www.ebay.de/itm/${n}`,
    price: { amount: Math.round(euros * 100), currency: "EUR" },
    condition: "new",
    seller: { handle: `seller_${n}` },
    category,
    ...over,
  };
}

const ok = (listings: Listing[]): SourceResult => ({ source: "ebay", status: "ok", listings, comparable: true });

// One configuration (825 GB, no Slim/Pro), so they are compared with each other.
const consoles = () => [
  ebay("Sony PlayStation 5 Digital Edition 825 GB, Neu, OVP", 599, CONSOLES),
  ebay("Sony PlayStation 5 Digital Edition 825 GB", 549.99, CONSOLES),
  ebay("Sony PlayStation 5 825 GB Disc", 600, CONSOLES),
  ebay("Sony PlayStation 5 Digital Edition – 825 GB – NEU", 550, CONSOLES),
  ebay("Sony PlayStation 5 Disc Edition, Weiß, 825GB", 511.97, CONSOLES),
  ebay("Sony PlayStation 5 PS5 825GB CFI-1116A + DualSense", 499.9, CONSOLES),
];

test("a game, a controller and a spare part are never priced against consoles", () => {
  const others = [
    ebay("Still Wakes The Deep PS5 – PlayStation 5 – Horror-Spiel", 15, GAMES),
    ebay("Final Fantasy XVI 16 - Steelbook Edition - PS5 PlayStation 5 NEU OVP", 25, GAMES),
    ebay("Sony DualSense Kabellos Controller für PlayStation 5 - Mitternachtsschwarz", 45, CONTROLLERS),
    ebay("Playstation 5 PS5 Original Ersatz HDMI Port Buchse Socket Connector", 5.59, PARTS),
  ];
  const a = analyse([ok([...consoles(), ...others])], { query: "PlayStation 5" });
  assert.equal(a.flags.filter((f) => f.kind === "underpriced").length, 0, "no false scam flags");
  for (const l of others) {
    assert.ok(!a.priceChecked.includes(listingKey(l)), l.title);
    // Either guard may catch it first: the category, or the title ("für PlayStation 5").
    assert.match(a.notCompared[listingKey(l)], /Listed under ".+", not "Konsolen"|sold for use with/);
  }
  // The consoles themselves are still compared with each other.
  assert.equal(consoles().length, 6);
  assert.ok(a.priceChecked.length >= 5);
});

test("the main category is the one most results share", () => {
  const ls = [ebay("a", 1, CONSOLES), ebay("b", 1, GAMES), ebay("c", 1, CONSOLES), ebay("d", 1)];
  assert.deepEqual(mainCategory(ls), CONSOLES);
  assert.equal(mainCategory([ebay("x", 1)]), undefined, "no categories published: no main category");
});

test("a real scam in the main category is still flagged", () => {
  const bait = ebay("Sony PlayStation 5 Digital Edition 825 GB NEU", 120, CONSOLES);
  const a = analyse([ok([...consoles(), bait])], { query: "PlayStation 5" });
  assert.ok(a.flags.some((f) => f.kind === "underpriced" && f.listingId === bait.id));
});

test("far below the median on a title that doesn't name the product: silence, with the reason", () => {
  const portal = ebay("Sony PlayStation Portal Handheld-System Remote Player für PS5 Schwarz", 145, CONSOLES);
  const a = analyse([ok([...consoles(), portal])], { query: "PlayStation 5" });
  assert.ok(!a.flags.some((f) => f.listingId === portal.id));
  assert.match(a.notCompared[listingKey(portal)], /doesn't name the PlayStation 5/);
  // A normally priced listing that doesn't name it is still compared.
  const slim = ebay("PS5 Slim Digital", 520, CONSOLES);
  const b = analyse([ok([...consoles(), slim])], { query: "PlayStation 5" });
  assert.ok(b.priceChecked.includes(listingKey(slim)));
});

test("German titles: accessories, broken units and repair services are recognised", () => {
  assert.equal(identify("Panzerglas Schutzfolie für iPhone 13", "iPhone 13").kind, "accessory");
  assert.equal(identify("iPhone 13 Handyhülle Silikon schwarz", "iPhone 13").kind, "accessory");
  assert.equal(identify("Netzteil für Lenovo ThinkPad X1 65W", "ThinkPad X1").kind, "accessory");
  assert.equal(identify("Sony PlayStation 5 Disk Edition CFI-1216A defekt", "PlayStation 5").kind, "parts");
  assert.equal(identify("iPhone 13 128GB iCloud gesperrt", "iPhone 13").kind, "parts");
  const repair = identify("Playstation 5 Controller Stick Drift Reparatur (z.B. Hall Effect)", "PlayStation 5");
  assert.equal(repair.kind, "accessory");
  assert.match(repair.kindReason!, /service/);
  assert.equal(identify("Kabel für PlayStation 5", "PlayStation 5").kind, "accessory", "sold for use with it");
  const motor = identify("Dyson V11 SV17 SV15 Hauptgerät Motor Zyklon + Filter - Gebraucht", "Dyson V11");
  assert.equal(motor.kind, "parts");
  assert.match(motor.kindReason!, /only part of the product/);
});

test("German titles: what comes WITH the product, and negations, don't change what it is", () => {
  assert.equal(identify("iPhone 13 128GB mit Hülle und Panzerglas", "iPhone 13").kind, "product");
  assert.equal(identify("iPhone 13 128GB inkl. Ladekabel", "iPhone 13").kind, "product");
  assert.equal(identify("Sony PlayStation 5 nicht defekt, top Zustand", "PlayStation 5").kind, "product");
  assert.equal(identify("Sony PlayStation 5 PS5 Disc Edition Controller HDMI Kabel", "PlayStation 5").kind, "product");
});

// --- photos -------------------------------------------------------------------

/** A synthetic RGBA picture: a diagonal gradient, optionally mirrored. */
function picture(w: number, h: number, flip = false): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((((flip ? w - 1 - x : x) + y * 2) / (w + h * 2)) * 255);
      const i = (y * w + x) * 4;
      px[i] = v;
      px[i + 1] = (v * 3) % 256;
      px[i + 2] = 255 - v;
      px[i + 3] = 255;
    }
  }
  return px;
}

test("dHash: the same photo re-encoded at another size matches; a different photo doesn't", () => {
  const a = dHash(picture(225, 169), 225, 169);
  const b = dHash(picture(400, 300), 400, 300);
  const c = dHash(picture(225, 169, true), 225, 169);
  assert.equal(a.length, 16);
  assert.ok(hamming(a, b) <= MAX_DISTANCE, `resized: ${hamming(a, b)} bits apart`);
  assert.ok(hamming(a, c) > MAX_DISTANCE, `different: ${hamming(a, c)} bits apart`);
  const groups = groupHashes([a, b, c]);
  assert.equal(groups.get(a), groups.get(b));
  assert.notEqual(groups.get(a), groups.get(c));
});

function jpeg(w: number, h: number, flip = false): ArrayBuffer {
  const { data } = encode({ data: picture(w, h, flip), width: w, height: h }, 80);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

test("used listings: one photo under two sellers is caught; new items and eBay stock photos are skipped, with the reason", async () => {
  const img = (id: string) => `https://i.ebayimg.com/images/g/${id}/s-l225.jpg`;
  const files: Record<string, ArrayBuffer> = {
    [img("copyA")]: jpeg(225, 169),
    [img("copyB")]: jpeg(300, 225), // the same photo, uploaded again by another seller
    [img("own")]: jpeg(225, 169, true),
  };
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url));
    const body = files[String(url)];
    return body ? new Response(body, { headers: { "content-type": "image/jpeg" } }) : new Response("gone", { status: 404 });
  }) as unknown as typeof fetch;

  const ls = [
    ebay("PlayStation 5 gebraucht", 400, CONSOLES, { condition: "used", imageUrl: img("copyA"), seller: { handle: "honest" } }),
    ebay("PlayStation 5 wie neu", 300, CONSOLES, { condition: "used", imageUrl: img("copyB"), seller: { handle: "copycat" } }),
    ebay("PlayStation 5 refurbished", 420, CONSOLES, { condition: "refurbished", imageUrl: img("own"), seller: { handle: "third" } }),
    ebay("PlayStation 5 neu", 550, CONSOLES, { condition: "new", imageUrl: img("maker"), seller: { handle: "shop" } }),
    ebay("PlayStation 5 used", 410, CONSOLES, { condition: "used", imageUrl: img("stock"), seller: { handle: "s1" } }),
    ebay("PlayStation 5 used too", 415, CONSOLES, { condition: "used", imageUrl: img("stock"), seller: { handle: "s2" } }),
    ebay("PlayStation 5 broken link", 405, CONSOLES, { condition: "used", imageUrl: img("missing"), seller: { handle: "s3" } }),
  ];
  await checkPhotos(ls, fakeFetch);

  const [honest, copycat, own, fresh, stock1, stock2, missing] = ls;
  assert.ok(honest.imageHash && honest.imageHash === copycat.imageHash, "the copied photo groups with the original");
  assert.ok(own.imageHash && own.imageHash !== honest.imageHash);
  assert.equal(fresh.imageHash, undefined);
  assert.match(fresh.photoNote!, /new items/);
  assert.match(stock1.photoNote!, /stock photo/);
  assert.match(stock2.photoNote!, /stock photo/);
  assert.match(missing.photoNote!, /couldn't be loaded/);
  assert.ok(!fetched.some((u) => u.includes("maker") || u.includes("stock")), "skipped photos aren't even downloaded");

  // And the analysis says so: both sellers of the copied photo are flagged.
  const a = analyse([ok(ls)], { query: "PlayStation 5" });
  const dupes = a.flags.filter((f) => f.kind === "duplicate_image").map((f) => f.listingId).sort();
  assert.deepEqual(dupes, [honest.id, copycat.id].sort());
});

/** A product on a plain white background: a grey block in the middle of white. */
function studio(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4).fill(255);
  for (let y = Math.round(h * 0.25); y < h * 0.75; y++) {
    for (let x = Math.round(w * 0.3); x < w * 0.7; x++) {
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 90;
    }
  }
  return px;
}

test("a studio picture on white, like the maker's render, is never compared", async () => {
  assert.equal(isStudioShot(studio(225, 225), 225, 225), true);
  assert.equal(isStudioShot(picture(225, 169), 225, 169), false, "a real-looking photo is compared");

  // Two refurbishers showing the same maker's render (as two AirPods dealers did on eBay.de): no flag.
  const url = (id: string) => `https://i.ebayimg.com/images/g/${id}/s-l225.jpg`;
  const render = encode({ data: studio(225, 225), width: 225, height: 225 }, 85).data;
  const body = () => render.buffer.slice(render.byteOffset, render.byteOffset + render.byteLength) as ArrayBuffer;
  const fakeFetch = (async () => new Response(body(), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  const ls = [
    ebay("Apple AirPods Pro 2 refurbished", 119, undefined, { condition: "used", imageUrl: url("one"), seller: { handle: "dealer_a" } }),
    ebay("Apple AirPods Pro 2nd Gen", 139, undefined, { condition: "used", imageUrl: url("two"), seller: { handle: "dealer_b" } }),
  ];
  await checkPhotos(ls, fakeFetch);
  for (const l of ls) {
    assert.equal(l.imageHash, undefined);
    assert.match(l.photoNote!, /white background/);
  }
  assert.equal(analyse([ok(ls)], { query: "AirPods Pro 2" }).flags.filter((f) => f.kind === "duplicate_image").length, 0);
});

test("eBay picture ids are read from the image URL", () => {
  assert.equal(ebayImageId("https://i.ebayimg.com/images/g/FL8AAeSwDahpOHWS/s-l225.jpg"), "FL8AAeSwDahpOHWS");
  assert.equal(ebayImageId("https://example.com/x.jpg"), undefined);
});
