// unicart-web/lib/scraper/parseProduct.ts
import * as cheerio from "cheerio";

export type ParseResult = {
  ok: true;
  url: string;
  title: string;
  imageUrl: string;
  price: number | null;
  currency: string | null;
  source: "shopify_json" | "jsonld" | "opengraph" | "html" | "playwright";
  confidence: number; // 0..1
  warnings?: string[];
  debug?: any;
};

export type ParseFail = {
  ok: false;
  url: string;
  error: string;
  status?: number;
  source?: string;
  debug?: any;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

/** ---------------------------
 * helpers
 * -------------------------- */

function pickFirst(...vals: Array<string | undefined | null>) {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function absUrl(base: string, maybe: string) {
  try {
    if (!maybe) return "";
    return new URL(maybe, base).toString();
  } catch {
    return "";
  }
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const s = String(v).trim();
  if (!s) return null;

  const cleaned = s.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma !== -1 && lastDot !== -1) {
    const decSep = lastComma > lastDot ? "," : ".";
    normalized = cleaned
      .replace(decSep === "," ? /\./g : /,/g, "")
      .replace(decSep, ".");
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
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;

    out.push(node);
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
  if (Array.isArray(raw))
    return raw.map(String).some((x) => x.toLowerCase() === want);
  return false;
}

function parseFromJsonLd(url: string, $: cheerio.CheerioAPI) {
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get();

  let title = "";
  let imageUrl = "";
  let price: number | null = null;
  let currency: string | null = null;

  for (const raw of scripts) {
    try {
      const json = JSON.parse(raw);
      const nodes = flattenJsonLd(json);
      const products = nodes.filter((n) => isType(n, "Product"));
      const candidates = products.length ? products : nodes;

      for (const n of candidates) {
        if (!title && (isType(n, "Product") || n?.name)) {
          const name = n?.name ? String(n.name) : "";
          if (name) title = name;
        }

        if (!imageUrl) {
          const img = n?.image;
          if (typeof img === "string") imageUrl = img;
          if (Array.isArray(img) && typeof img[0] === "string") imageUrl = img[0];
          imageUrl = absUrl(url, imageUrl);
        }

        const offers = n?.offers;
        const offer = Array.isArray(offers) ? offers[0] : offers;

        if (price == null && offer) {
          const p = toNumberOrNull(
            offer?.price ?? offer?.lowPrice ?? offer?.highPrice
          );
          if (p != null) price = p;

          const cur = offer?.priceCurrency
            ? String(offer.priceCurrency)
            : extractCurrencyLoose(String(offer?.price ?? ""));
          if (!currency && cur) currency = cur;
        }

        if (title && imageUrl && (price != null || currency)) break;
      }
    } catch {
      // ignore bad JSON-LD blocks
    }
  }

  return { title, imageUrl, price, currency };
}

function score({ title, imageUrl, price, currency }: any) {
  let s = 0;
  if (title) s += 0.45;
  if (imageUrl) s += 0.2;
  if (price != null) s += 0.25;
  if (currency) s += 0.1;
  return Math.max(0, Math.min(1, s));
}

/** Browser-ish headers help a lot for “semi-protected” sites */
function buildBrowserHeaders(targetUrl: string) {
  const origin = (() => {
    try {
      return new URL(targetUrl).origin;
    } catch {
      return "";
    }
  })();

  return {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    ...(origin ? { Referer: `${origin}/` } : {}),
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
  } as Record<string, string>;
}

async function fetchWithRetry(url: string, maxTries = 2) {
  const errors: any[] = [];
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: buildBrowserHeaders(url),
      });

      const text = await res.text();
      return { res, text };
    } catch (e: any) {
      errors.push({ try: i + 1, message: e?.message ?? String(e) });
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(
    `fetch failed after ${maxTries} tries: ${errors
      .map((x) => x.message)
      .join(" | ")}`
  );
}

async function tryShopifyJson(targetUrl: string) {
  // Shopify: /products/<handle> -> /products/<handle>.js
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return null;
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const pIndex = parts.indexOf("products");
  if (pIndex === -1 || !parts[pIndex + 1]) return null;

  const handle = parts[pIndex + 1];
  const jsonUrl = `${u.origin}/products/${handle}.js`;

  const res = await fetch(jsonUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Referer: targetUrl,
    },
    redirect: "follow",
  });

  if (!res.ok) return null;

  const data: any = await res.json().catch(() => null);
  if (!data || !data.title) return null;

  const title = String(data.title || "").trim();
  const imageUrl =
    Array.isArray(data.images) && data.images[0] ? String(data.images[0]) : "";

  // Shopify variant price often in cents
  let price: number | null = null;
  if (Array.isArray(data.variants) && data.variants[0]?.price != null) {
    const cents = toNumberOrNull(data.variants[0].price);
    if (cents != null) price = cents / 100;
  }

  return {
    title,
    imageUrl,
    price,
    currency: null as string | null, // can be filled later
  };
}

async function callPlaywrightFallback(
  inputUrl: string,
  opts: { scraperServiceUrl?: string; scraperToken?: string },
  dbg?: any
): Promise<
  | {
      ok: true;
      title: string;
      imageUrl: string;
      price: number | null;
      currency: string | null;
      debug?: any;
    }
  | { ok: false; error: string; debug?: any }
> {
  if (!opts.scraperServiceUrl) {
    return { ok: false, error: "scraper_service_not_configured" };
  }

  try {
    const pwRes = await fetch(`${opts.scraperServiceUrl}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.scraperToken
          ? { Authorization: `Bearer ${opts.scraperToken}` }
          : {}),
      },
      body: JSON.stringify({ url: inputUrl }),
    });

    const data = await pwRes.json().catch(() => null);

    if (!pwRes.ok) {
      return {
        ok: false,
        error: `playwright_http_${pwRes.status}`,
        debug: dbg ? { ...dbg, playwrightBody: data } : undefined,
      };
    }

    // expected shape from our scraper: { ok:true, title, imageUrl, price, currency, html? }
    if (data?.ok && data?.title) {
      return {
        ok: true,
        title: String(data.title || ""),
        imageUrl: absUrl(inputUrl, String(data.imageUrl || "")),
        price: data.price != null ? toNumberOrNull(data.price) : null,
        currency: data.currency ? String(data.currency) : null,
      };
    }

    // fallback if service returns html but not extracted
    if (data?.html && typeof data.html === "string") {
      const $$ = cheerio.load(data.html);
      const ld2 = parseFromJsonLd(inputUrl, $$);

      const title2 = pickFirst(
        ld2.title,
        $$('meta[property="og:title"]').attr("content"),
        $$('meta[name="twitter:title"]').attr("content"),
        $$("title").text()
      );

      const img2 = absUrl(
        inputUrl,
        pickFirst(
          ld2.imageUrl,
          $$('meta[property="og:image"]').attr("content"),
          $$('meta[name="twitter:image"]').attr("content")
        )
      );

      const metaPrice2 = pickFirst(
        $$('meta[property="product:price:amount"]').attr("content"),
        $$('meta[name="product:price:amount"]').attr("content"),
        $$('[itemprop="price"]').attr("content"),
        $$('[itemprop="price"]').first().text()
      );

      const metaCurrency2 = pickFirst(
        $$('meta[property="product:price:currency"]').attr("content"),
        $$('meta[name="product:price:currency"]').attr("content"),
        $$('[itemprop="priceCurrency"]').attr("content"),
        $$('[itemprop="priceCurrency"]').first().text()
      );

      const price2 = ld2.price != null ? ld2.price : toNumberOrNull(metaPrice2);
      const cur2 =
        ld2.currency ||
        (metaCurrency2 ? metaCurrency2.trim() : null) ||
        extractCurrencyLoose(metaPrice2 || "");

      return {
        ok: true,
        title: title2 || "",
        imageUrl: img2 || "",
        price: price2,
        currency: cur2,
      };
    }

    return { ok: false, error: "playwright_no_data", debug: data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), debug: dbg };
  }
}

/** ---------------------------
 * main
 * -------------------------- */

export async function parseProductUrl(
  inputUrl: string,
  opts: {
    debug: boolean;
    scraperServiceUrl?: string;
    scraperToken?: string;
  }
): Promise<ParseResult | ParseFail> {
  const warnings: string[] = [];
  const dbg: any = opts.debug ? { tiersTried: [] as string[] } : undefined;

  // Tier 0: Shopify JSON (fast win)
  try {
    dbg?.tiersTried.push("shopify_json");
    const shop = await tryShopifyJson(inputUrl);
    if (shop?.title) {
      const conf = score(shop);

      if (!shop.currency) warnings.push("currency_missing");

      if (conf >= 0.7) {
        return {
          ok: true,
          url: inputUrl,
          title: shop.title,
          imageUrl: absUrl(inputUrl, shop.imageUrl),
          price: shop.price ?? null,
          currency: shop.currency ?? null,
          source: "shopify_json",
          confidence: conf,
          warnings: warnings.length ? warnings : undefined,
          debug: dbg,
        };
      }
      // else keep going for better completeness
    }
  } catch (e: any) {
    warnings.push("shopify_json_failed");
    if (dbg) dbg.shopifyError = e?.message ?? String(e);
  }

  // Tier 1: HTML fetch
  let res: Response;
  let html: string;

  try {
    dbg?.tiersTried.push("html_fetch");
    const got = await fetchWithRetry(inputUrl, 2);
    res = got.res;
    html = got.text;

    // Improvement: on 403/429 try Playwright instead of failing immediately
    if (!res.ok) {
      const blocked = res.status === 403 || res.status === 429;
      const status = res.status;

      if (blocked && opts.scraperServiceUrl) {
        dbg?.tiersTried.push("playwright");
        const pw = await callPlaywrightFallback(inputUrl, opts, dbg);

        if (pw.ok) {
          const confPw = score(pw);

          if (!pw.title) warnings.push("title_missing");
          if (!pw.imageUrl) warnings.push("image_missing");
          if (pw.price == null) warnings.push("price_missing");
          if (!pw.currency) warnings.push("currency_missing");

          return {
            ok: true,
            url: inputUrl,
            title: pw.title || "",
            imageUrl: pw.imageUrl || "",
            price: pw.price ?? null,
            currency: pw.currency ?? null,
            source: "playwright",
            confidence: Math.max(0.75, confPw),
            warnings: warnings.length ? warnings : undefined,
            debug: dbg,
          };
        }

        return {
          ok: false,
          url: inputUrl,
          error: `Blocked (${status}) and playwright failed: ${pw.error}`,
          status,
          source: "playwright",
          debug: dbg,
        };
      }

      return {
        ok: false,
        url: inputUrl,
        error: `Fetch failed: ${res.status} ${res.statusText}`,
        status: res.status,
        source: "html",
        debug: dbg ? { ...dbg, fetchedBytes: html?.length ?? 0 } : undefined,
      };
    }
  } catch (e: any) {
    return {
      ok: false,
      url: inputUrl,
      error: e?.message ?? "Fetch failed",
      source: "html",
      debug: dbg,
    };
  }

  const $ = cheerio.load(html);

  // Tier 2: JSON-LD
  dbg?.tiersTried.push("jsonld");
  const ld = parseFromJsonLd(inputUrl, $);

  // Tier 3: OG/meta fallback
  dbg?.tiersTried.push("opengraph");
  const ogTitle = pickFirst(
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("title").text()
  );

  const ogImage = pickFirst(
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content")
  );

  const metaPrice = pickFirst(
    $('meta[property="product:price:amount"]').attr("content"),
    $('meta[name="product:price:amount"]').attr("content"),
    $('[itemprop="price"]').attr("content"),
    $('[itemprop="price"]').first().text(),
    $('meta[property="og:price:amount"]').attr("content")
  );

  const metaCurrency = pickFirst(
    $('meta[property="product:price:currency"]').attr("content"),
    $('meta[name="product:price:currency"]').attr("content"),
    $('[itemprop="priceCurrency"]').attr("content"),
    $('[itemprop="priceCurrency"]').first().text()
  );

  const merged = {
    title: pickFirst(ld.title, ogTitle),
    imageUrl: absUrl(inputUrl, pickFirst(ld.imageUrl, ogImage)),
    price: ld.price != null ? ld.price : toNumberOrNull(metaPrice),
    currency:
      ld.currency ||
      (metaCurrency ? metaCurrency.trim() : null) ||
      extractCurrencyLoose(metaPrice || ""),
  };

  const conf = score(merged);
  if (!merged.title) warnings.push("title_missing");
  if (!merged.imageUrl) warnings.push("image_missing");
  if (merged.price == null) warnings.push("price_missing");
  if (!merged.currency) warnings.push("currency_missing");

  // Improvement: low-confidence or missing title => try Playwright (if configured)
  const needsPlaywright = !!opts.scraperServiceUrl && (!merged.title || conf < 0.4);

  if (needsPlaywright) {
    dbg?.tiersTried.push("playwright");
    const pw = await callPlaywrightFallback(inputUrl, opts, dbg);

    if (!pw.ok) {
      warnings.push("playwright_failed");
      if (dbg) dbg.playwrightError = pw.error;
    } else if (pw.title) {
      const conf2 = score(pw);
      const finalConf = Math.max(conf, conf2, 0.75);

      const finalTitle = pw.title || merged.title || "";
      const finalImage = pw.imageUrl || merged.imageUrl || "";
      const finalPrice = pw.price ?? merged.price ?? null;
      const finalCurrency = pw.currency ?? merged.currency ?? null;

      const w2: string[] = [];
      if (!finalTitle) w2.push("title_missing");
      if (!finalImage) w2.push("image_missing");
      if (finalPrice == null) w2.push("price_missing");
      if (!finalCurrency) w2.push("currency_missing");

      return {
        ok: true,
        url: inputUrl,
        title: finalTitle,
        imageUrl: finalImage,
        price: finalPrice,
        currency: finalCurrency,
        source: "playwright",
        confidence: finalConf,
        warnings: w2.length ? w2 : undefined,
        debug: dbg
          ? { ...dbg, fetchedStatus: res.status, fetchedBytes: html.length }
          : undefined,
      };
    }
  }

  // If "good enough" return HTML-derived
  if (conf >= 0.55 || merged.title) {
    return {
      ok: true,
      url: inputUrl,
      title: merged.title || "",
      imageUrl: merged.imageUrl || "",
      price: merged.price ?? null,
      currency: merged.currency ?? null,
      source: ld.title || ld.price != null ? "jsonld" : "opengraph",
      confidence: conf,
      warnings: warnings.length ? warnings : undefined,
      debug: dbg
        ? { ...dbg, fetchedStatus: res.status, fetchedBytes: html.length }
        : undefined,
    };
  }

  // Last fallback: return what we have (low confidence)
  return {
    ok: true,
    url: inputUrl,
    title: merged.title || "",
    imageUrl: merged.imageUrl || "",
    price: merged.price ?? null,
    currency: merged.currency ?? null,
    source: "html",
    confidence: conf,
    warnings: warnings.length ? warnings : undefined,
    debug: dbg
      ? { ...dbg, fetchedStatus: res.status, fetchedBytes: html.length }
      : undefined,
  };
}