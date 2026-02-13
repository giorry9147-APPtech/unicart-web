import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import * as cheerio from "cheerio";

type Parsed = {
  title?: string;
  image_url?: string;
  price?: number;
  currency?: string;
  shop?: string;
  domain?: string;
};

function getDomain(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function absUrl(base: string, maybe: string) {
  try {
    if (!maybe) return "";
    return new URL(maybe, base).toString();
  } catch {
    return "";
  }
}

function pickFirst(...vals: Array<string | undefined | null>) {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const s = String(v).trim();
  if (!s) return null;

  // remove currency symbols, keep digits , .
  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  // If both comma and dot exist, assume dot = thousand separator, comma = decimal OR vice versa.
  // We'll pick the last separator as decimal separator.
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma !== -1 && lastDot !== -1) {
    const decSep = lastComma > lastDot ? "," : ".";
    normalized = cleaned
      .replace(decSep === "," ? /\./g : /,/g, "") // remove the other separator as thousands
      .replace(decSep, "."); // decimal to dot
  } else {
    normalized = cleaned.replace(",", ".");
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function extractCurrencyLoose(s: string): string | null {
  const up = (s || "").toUpperCase();
  if (up.includes("EUR") || s.includes("€")) return "EUR";
  if (up.includes("USD") || s.includes("$")) return "USD";
  if (up.includes("GBP") || s.includes("£")) return "GBP";
  return null;
}

function flattenJsonLd(input: any): any[] {
  const out: any[] = [];

  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;

    out.push(node);

    // common containers
    if (node["@graph"]) walk(node["@graph"]);
    if (node.graph) walk(node.graph);
    if (node.mainEntity) walk(node.mainEntity);
    if (node.itemListElement) walk(node.itemListElement);
    if (node.offers) walk(node.offers);
    if (node.hasVariant) walk(node.hasVariant);
    if (node.isVariantOf) walk(node.isVariantOf);
  };

  walk(input);
  return out;
}

function isType(node: any, t: string) {
  const want = t.toLowerCase();
  const raw = node?.["@type"];
  if (!raw) return false;
  if (typeof raw === "string") return raw.toLowerCase() === want;
  if (Array.isArray(raw)) return raw.map(String).some((x) => x.toLowerCase() === want);
  return false;
}

function parseProductFromLd(nodes: any[]): Parsed {
  let best: Parsed = {};

  // Try to pick a Product node first
  const products = nodes.filter((n) => isType(n, "Product"));
  const candidates = products.length ? products : nodes;

  for (const n of candidates) {
    if (!best.title && (isType(n, "Product") || n?.name)) {
      const name = n?.name ? String(n.name) : "";
      if (name) best.title = name;
    }

    if (!best.image_url) {
      const img = n?.image;
      if (typeof img === "string") best.image_url = img;
      if (Array.isArray(img) && typeof img[0] === "string") best.image_url = img[0];
    }

    // Offers parsing
    const offers = n?.offers;
    const offer = Array.isArray(offers) ? offers[0] : offers;

    // Offer
    if (!best.price && offer) {
      const price = offer?.price ?? offer?.lowPrice ?? offer?.highPrice;
      const p = toNumberOrNull(price);
      if (p != null) best.price = p;

      const cur =
        offer?.priceCurrency ? String(offer.priceCurrency) : extractCurrencyLoose(String(price ?? ""));
      if (!best.currency && cur) best.currency = cur;
    }

    // AggregateOffer sometimes has lowPrice/highPrice
    if (!best.price && offer && isType(offer, "AggregateOffer")) {
      const p = toNumberOrNull(offer?.lowPrice ?? offer?.highPrice);
      if (p != null) best.price = p;
      const cur = offer?.priceCurrency ? String(offer.priceCurrency) : null;
      if (!best.currency && cur) best.currency = cur;
    }

    if (best.title && best.image_url && (best.price || best.currency)) break;
  }

  return best;
}

function meta($: cheerio.CheerioAPI, sel: string, attr = "content") {
  return $(sel).attr(attr) || "";
}

function parseFromHtml(url: string, html: string): Parsed {
  const $ = cheerio.load(html);

  const domain = getDomain(url) || "unknown";

  // OG / Twitter basics
  const ogTitle = meta($, 'meta[property="og:title"]');
  const ogImage = meta($, 'meta[property="og:image"]');
  const twTitle = meta($, 'meta[name="twitter:title"]');
  const twImage = meta($, 'meta[name="twitter:image"]');

  // Price meta variations
  const metaPrice =
    meta($, 'meta[property="product:price:amount"]') ||
    meta($, 'meta[property="og:price:amount"]') ||
    meta($, 'meta[name="twitter:data1"]') ||
    meta($, 'meta[itemprop="price"]') ||
    meta($, 'meta[name="price"]');

  const metaCurrency =
    meta($, 'meta[property="product:price:currency"]') ||
    meta($, 'meta[property="og:price:currency"]') ||
    meta($, 'meta[itemprop="priceCurrency"]') ||
    extractCurrencyLoose(metaPrice || "") ||
    null;

  // JSON-LD
  let ldParsed: Parsed = {};
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get();

  for (const raw of scripts) {
    try {
      const json = JSON.parse(raw);
      const nodes = flattenJsonLd(json);
      const got = parseProductFromLd(nodes);

      // merge "best"
      ldParsed = {
        title: ldParsed.title || got.title,
        image_url: ldParsed.image_url || got.image_url,
        price: ldParsed.price ?? got.price,
        currency: ldParsed.currency || got.currency,
      };

      if (ldParsed.title && ldParsed.image_url && (ldParsed.price || ldParsed.currency)) break;
    } catch {
      // ignore
    }
  }

  // Compose final
  const title = pickFirst(ldParsed.title, ogTitle, twTitle, $("title").first().text(), domain);
  const imageRaw = pickFirst(ldParsed.image_url, ogImage, twImage, "");
  const image_url = imageRaw ? absUrl(url, imageRaw) : "";

  const price =
    ldParsed.price ??
    (metaPrice ? toNumberOrNull(metaPrice) ?? undefined : undefined);

  const currency =
    ldParsed.currency || (metaCurrency ? String(metaCurrency) : undefined);

  return {
    title,
    image_url,
    ...(typeof price === "number" ? { price } : {}),
    ...(currency ? { currency } : {}),
    shop: domain,
    domain,
  };
}

export async function POST(req: Request) {
  try {
    const secret = req.headers.get("x-enrich-secret");
    if (!process.env.ENRICH_SECRET || secret !== process.env.ENRICH_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const uid = String(body?.uid || "");
    const itemId = String(body?.itemId || "");
    const url = String(body?.url || "");

    if (!uid || !itemId || !url) {
      return NextResponse.json({ ok: false, error: "Missing uid/itemId/url" }, { status: 400 });
    }

    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UniCartBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const ref = adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId);

    if (!res.ok) {
      await ref.set(
        {
          enrichStatus: "failed",
          enrichError: `HTTP ${res.status}`,
          enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return NextResponse.json({ ok: false, error: "Fetch failed" }, { status: 200 });
    }

    const html = await res.text();
    const parsed = parseFromHtml(url, html);

    // If still no useful fields, mark failed
    const hasUseful =
      !!parsed.title || !!parsed.image_url || typeof parsed.price === "number";

    await ref.set(
      {
        ...parsed,
        enrichStatus: hasUseful ? "ok" : "failed",
        ...(hasUseful ? {} : { enrichError: "No product data found" }),
        enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return NextResponse.json({ ok: true, ...parsed });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
