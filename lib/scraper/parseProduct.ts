import * as cheerio from "cheerio";

type FieldValue<T> = {
  value: T;
  source: string;
  confidence: number;
};

export type Attempt = {
  layer: string;
  ok: boolean;
  notes?: string;
};

export type ProductDraft = {
  urlInput: string;
  canonicalUrl?: string;
  domain?: string;
  title?: FieldValue<string>;
  image?: FieldValue<string>;
  price?: FieldValue<{ amount: number; currency: string }>;
  status: "complete" | "partial" | "needs_user_input" | "blocked";
  missing: string[];
  attempts: Attempt[];
};

export type ParseResult = {
  ok: true;
  url: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  imageUrl: string;
  price: number | null;
  currency: string | null;
  source: "shopify_json" | "jsonld" | "opengraph" | "html" | "playwright";
  confidence: number;
  draftStatus: ProductDraft["status"];
  missing: string[];
  attempts: Attempt[];
  warnings?: string[];
  debug?: any;
};

export type ParseFail = {
  ok: false;
  url: string;
  error: string;
  status?: number;
  source?: string;
  blockedReason?: string;
  debug?: any;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

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

function normalizeUrl(input: string) {
  try {
    const u = new URL(input);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return input;
  }
}

function getDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "unknown";
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

function inferCurrencyFromDomain(domain?: string) {
  const d = String(domain || "").toLowerCase();
  if (!d) return null;

  if (d.endsWith(".co.uk") || d.endsWith(".uk")) return "GBP";
  if (d.endsWith(".com")) return null;
  if (
    d.endsWith(".nl") ||
    d.endsWith(".de") ||
    d.endsWith(".fr") ||
    d.endsWith(".be") ||
    d.endsWith(".es") ||
    d.endsWith(".it") ||
    d.endsWith(".pt")
  ) {
    return "EUR";
  }

  return null;
}

type PriceCandidate = {
  amount: number;
  currency: string;
  confidence: number;
  source: string;
  notes: string;
};

function getPriceTextCandidates(text: string): string[] {
  const out = new Set<string>();
  const raw = String(text || "").replace(/\s+/g, " ");

  const moneyRegex =
    /(€\s?\d{1,3}(?:[.\s]\d{3})*(?:[,\.]\d{2})?|\$\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|£\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|\d{1,3}(?:[.\s]\d{3})*(?:[,\.]\d{2})\s?(?:EUR|USD|GBP))/gi;

  for (const m of raw.matchAll(moneyRegex)) {
    const v = String(m[0] || "").trim();
    if (v) out.add(v);
  }

  return Array.from(out);
}

function scorePriceContext(context: string) {
  const c = context.toLowerCase();
  let s = 0.5;

  if (/(price|our price|sale|deal|current|now|final|pay)/.test(c)) s += 0.25;
  if (/(old|was|before|list|advies|msrp|rrp|from)/.test(c)) s -= 0.2;
  if (/(shipping|delivery|tax|vat|fee|installment)/.test(c)) s -= 0.2;
  if (/(cart|basket|wishlist)/.test(c)) s -= 0.1;

  return Math.max(0.1, Math.min(0.95, s));
}

function extractDomPriceCandidates(
  $: cheerio.CheerioAPI,
  domain?: string
): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (
    amountRaw: any,
    currencyRaw: any,
    source: string,
    context: string
  ) => {
    const amount = toNumberOrNull(amountRaw);
    let currency = extractCurrencyLoose(String(currencyRaw ?? ""));

    if (!currency) {
      currency = extractCurrencyLoose(String(context || ""));
    }
    if (!currency) {
      currency = inferCurrencyFromDomain(domain) || null;
    }

    if (amount == null || !currency) return;

    const key = `${amount}:${currency}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      amount,
      currency,
      confidence: scorePriceContext(context),
      source,
      notes: context.slice(0, 200),
    });
  };

  // Structured/meta candidates first.
  const structured: Array<{ amount: any; currency: any; source: string; context: string }> = [
    {
      amount: $('meta[property="product:price:amount"]').attr("content"),
      currency: $('meta[property="product:price:currency"]').attr("content"),
      source: "dom_meta_product",
      context: "meta product price",
    },
    {
      amount: $('meta[name="product:price:amount"]').attr("content"),
      currency: $('meta[name="product:price:currency"]').attr("content"),
      source: "dom_meta_name_product",
      context: "meta name product price",
    },
    {
      amount: $('[itemprop="price"]').attr("content") || $('[itemprop="price"]').first().text(),
      currency:
        $('[itemprop="priceCurrency"]').attr("content") ||
        $('[itemprop="priceCurrency"]').first().text(),
      source: "dom_itemprop_price",
      context: "itemprop price",
    },
    {
      amount: $('meta[property="og:price:amount"]').attr("content"),
      currency: $('meta[property="og:price:currency"]').attr("content"),
      source: "dom_meta_og_price",
      context: "meta og price",
    },
  ];

  for (const c of structured) {
    pushCandidate(c.amount, c.currency, c.source, c.context);
  }

  // DOM selectors commonly used by storefronts.
  const domSelector =
    '[data-price], [data-price-amount], [data-product-price], [class*="price" i], [id*="price" i], [aria-label*="price" i]';

  $(domSelector)
    .slice(0, 120)
    .each((_, el) => {
      const node = $(el);
      const text = [
        node.attr("content"),
        node.attr("data-price"),
        node.attr("data-price-amount"),
        node.attr("data-product-price"),
        node.attr("aria-label"),
        node.text(),
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!text) return;

      const currencyHint = [
        node.attr("data-currency"),
        node.attr("data-price-currency"),
        node.attr("content"),
      ]
        .filter(Boolean)
        .join(" ");

      for (const moneyText of getPriceTextCandidates(text)) {
        pushCandidate(moneyText, currencyHint || moneyText, "dom_selector_price", text);
      }
    });

  return candidates;
}

function pickBestPriceCandidate(candidates: PriceCandidate[]): PriceCandidate | null {
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.amount - b.amount;
  });

  return sorted[0] ?? null;
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
  if (Array.isArray(raw)) return raw.map(String).some((x) => x.toLowerCase() === want);
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
          const p = toNumberOrNull(offer?.price ?? offer?.lowPrice ?? offer?.highPrice);
          if (p != null) price = p;

          const cur = offer?.priceCurrency
            ? String(offer.priceCurrency)
            : extractCurrencyLoose(String(offer?.price ?? ""));
          if (!currency && cur) currency = cur;
        }

        if (title && imageUrl && (price != null || currency)) break;
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }

  return { title, imageUrl, price, currency };
}

function parseFastMetadata(url: string, $: cheerio.CheerioAPI) {
  const title = pickFirst(
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("title").text()
  );

  const imageUrl = absUrl(
    url,
    pickFirst(
      $('meta[property="og:image"]').attr("content"),
      $('meta[name="twitter:image"]').attr("content")
    )
  );

  const canonicalRaw = pickFirst(
    $('link[rel="canonical"]').attr("href"),
    $('meta[property="og:url"]').attr("content")
  );

  const canonicalUrl = canonicalRaw ? normalizeUrl(absUrl(url, canonicalRaw)) : "";

  return { title, imageUrl, canonicalUrl };
}

function score({ title, imageUrl, price, currency }: any) {
  let s = 0;
  if (title) s += 0.45;
  if (imageUrl) s += 0.2;
  if (price != null) s += 0.25;
  if (currency) s += 0.1;
  return Math.max(0, Math.min(1, s));
}

function makeDraft(urlInput: string): ProductDraft {
  const canonicalUrl = normalizeUrl(urlInput);
  return {
    urlInput,
    canonicalUrl,
    domain: getDomain(canonicalUrl),
    status: "partial",
    missing: ["title", "image", "price.amount", "price.currency"],
    attempts: [],
  };
}

function computeMissing(draft: ProductDraft) {
  const missing: string[] = [];
  if (!draft.title?.value) missing.push("title");
  if (!draft.image?.value) missing.push("image");
  if (draft.price?.value?.amount == null) missing.push("price.amount");
  if (!draft.price?.value?.currency) missing.push("price.currency");
  if (!draft.canonicalUrl) missing.push("canonicalUrl");
  if (!draft.domain) missing.push("domain");
  return missing;
}

function refreshDraftStatus(draft: ProductDraft) {
  draft.missing = computeMissing(draft);
  if (draft.status === "blocked") return;
  draft.status = draft.missing.length === 0 ? "complete" : "partial";
}

function addAttempt(draft: ProductDraft, layer: string, ok: boolean, notes?: string) {
  draft.attempts.push({ layer, ok, notes });
}

function mergeCanonical(draft: ProductDraft, value: string | null | undefined) {
  const next = String(value ?? "").trim();
  if (!next) return;
  draft.canonicalUrl = normalizeUrl(next);
  draft.domain = getDomain(draft.canonicalUrl);
}

function mergeTitle(
  draft: ProductDraft,
  value: string | null | undefined,
  source: string,
  confidence: number
) {
  if (draft.title?.value) return;
  const next = String(value ?? "").trim();
  if (!next) return;
  draft.title = { value: next, source, confidence };
}

function mergeImage(
  draft: ProductDraft,
  value: string | null | undefined,
  source: string,
  confidence: number
) {
  if (draft.image?.value) return;
  const next = String(value ?? "").trim();
  if (!next) return;
  draft.image = { value: next, source, confidence };
}

function mergePrice(
  draft: ProductDraft,
  amount: number | null | undefined,
  currency: string | null | undefined,
  source: string,
  confidence: number
) {
  if (draft.price?.value?.amount != null && draft.price?.value?.currency) return;

  const cleanAmount = amount != null && Number.isFinite(amount) ? amount : null;
  const cleanCurrency = String(currency ?? "").trim().toUpperCase();
  if (cleanAmount == null || !cleanCurrency) return;

  draft.price = {
    value: { amount: cleanAmount, currency: cleanCurrency },
    source,
    confidence,
  };
}

function isBlockedContent(text: string) {
  return !!detectBlockedReason(text);
}

function detectBlockedReason(text: string): string | null {
  const hay = text.toLowerCase();
  if (hay.includes("captcha") || hay.includes("recaptcha") || hay.includes("hcaptcha")) {
    return "blocked_captcha";
  }
  if (hay.includes("access denied") || hay.includes("forbidden")) {
    return "blocked_access_denied";
  }
  if (hay.includes("verify you are human") || hay.includes("are you human") || hay.includes("bot detection")) {
    return "blocked_human_verification";
  }
  if (hay.includes("sign in") || hay.includes("log in") || hay.includes("login required")) {
    return "blocked_login_wall";
  }
  return null;
}

function missingRequiredFields(draft: ProductDraft): string[] {
  const missing: string[] = [];
  if (!draft.title?.value) missing.push("title");
  if (!draft.image?.value) missing.push("image");
  if (draft.price?.value?.amount == null) missing.push("price.amount");
  if (!draft.price?.value?.currency) missing.push("price.currency");
  return missing;
}

function hasRequiredFields(draft: ProductDraft): boolean {
  return missingRequiredFields(draft).length === 0;
}

function buildBrowserHeaders(targetUrl: string) {
  let origin = "";
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    origin = "";
  }

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
    `fetch failed after ${maxTries} tries: ${errors.map((x) => x.message).join(" | ")}`
  );
}

async function tryShopifyJson(targetUrl: string) {
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

  let price: number | null = null;
  if (Array.isArray(data.variants) && data.variants[0]?.price != null) {
    const cents = toNumberOrNull(data.variants[0].price);
    if (cents != null) price = cents / 100;
  }

  return {
    title,
    imageUrl,
    price,
    currency: null as string | null,
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
      html?: string;
      finalUrl?: string;
      debug?: any;
    }
  | { ok: false; error: string; blockedReason?: string; debug?: any }
> {
  if (!opts.scraperServiceUrl) {
    return { ok: false, error: "scraper_service_not_configured" };
  }

  const fetchWithTimeout = async (timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${opts.scraperServiceUrl}/scrape?debug=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.scraperToken ? { Authorization: `Bearer ${opts.scraperToken}` } : {}),
        },
        body: JSON.stringify({ url: inputUrl }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const attempts: string[] = [];

  try {
    let pwRes: Response | null = null;
    let lastErr: any = null;

    for (let i = 0; i < 2; i++) {
      try {
        pwRes = await fetchWithTimeout(25000 + i * 5000);
        attempts.push(`attempt_${i + 1}:http_${pwRes.status}`);
        break;
      } catch (e: any) {
        lastErr = e;
        attempts.push(`attempt_${i + 1}:error_${e?.name || "unknown"}`);
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }

    if (!pwRes) {
      return {
        ok: false,
        error: `playwright_request_failed:${lastErr?.message || "unknown"}`,
        debug: dbg ? { ...dbg, playwrightAttempts: attempts } : { playwrightAttempts: attempts },
      };
    }

    const data = await pwRes.json().catch(() => null);

    if (!pwRes.ok) {
      return {
        ok: false,
        error: `playwright_http_${pwRes.status}`,
        debug: dbg
          ? { ...dbg, playwrightBody: data, playwrightAttempts: attempts }
          : { playwrightBody: data, playwrightAttempts: attempts },
      };
    }

    if (typeof data?.html === "string") {
      const blockedReason = detectBlockedReason(data.html);
      if (blockedReason) {
        return {
          ok: false,
          error: blockedReason,
          blockedReason,
          debug: dbg
            ? { ...dbg, playwrightAttempts: attempts }
            : { playwrightAttempts: attempts },
        };
      }
    }

    if (data?.ok && data?.title) {
      return {
        ok: true,
        title: String(data.title || ""),
        imageUrl: absUrl(inputUrl, String(data.imageUrl || "")),
        price: data.price != null ? toNumberOrNull(data.price) : null,
        currency: data.currency ? String(data.currency) : null,
        html: typeof data?.html === "string" ? data.html : undefined,
        finalUrl: typeof data?.url === "string" ? data.url : undefined,
        debug: dbg ? { ...dbg, playwrightAttempts: attempts } : { playwrightAttempts: attempts },
      };
    }

    if (data?.html && typeof data.html === "string") {
      const $$ = cheerio.load(data.html);
      const ld2 = parseFromJsonLd(inputUrl, $$);
      const fast2 = parseFastMetadata(inputUrl, $$);

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
        title: pickFirst(ld2.title, fast2.title),
        imageUrl: absUrl(inputUrl, pickFirst(ld2.imageUrl, fast2.imageUrl)),
        price: price2,
        currency: cur2,
        html: data.html,
        finalUrl: typeof data?.url === "string" ? data.url : undefined,
        debug: dbg ? { ...dbg, playwrightAttempts: attempts } : { playwrightAttempts: attempts },
      };
    }

    return { ok: false, error: "playwright_no_data", debug: data };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), debug: dbg };
  }
}

function resultFromDraft(params: {
  draft: ProductDraft;
  source: ParseResult["source"];
  confidence: number;
  warnings?: string[];
  debug?: any;
}): ParseResult {
  const { draft, source, confidence, warnings, debug } = params;
  refreshDraftStatus(draft);
  const canonicalUrl = draft.canonicalUrl || normalizeUrl(draft.urlInput);
  const domain = draft.domain || getDomain(canonicalUrl);

  return {
    ok: true,
    url: canonicalUrl,
    canonicalUrl,
    domain,
    title: draft.title?.value || "",
    imageUrl: draft.image?.value || "",
    price: draft.price?.value?.amount ?? null,
    currency: draft.price?.value?.currency ?? null,
    source,
    confidence,
    draftStatus: draft.status,
    missing: draft.missing,
    attempts: draft.attempts,
    warnings,
    debug,
  };
}

function applyHtmlLayersToDraft(params: {
  draft: ProductDraft;
  html: string;
  pageUrl: string;
  tierTag: "html" | "playwright";
  tierLabel: string;
  dbg?: any;
}) {
  const { draft, html, pageUrl, tierTag, tierLabel, dbg } = params;
  const $ = cheerio.load(html);

  const fast = parseFastMetadata(pageUrl, $);
  mergeCanonical(draft, fast.canonicalUrl || pageUrl);
  mergeTitle(draft, fast.title, tierTag === "playwright" ? "playwright" : "opengraph", tierTag === "playwright" ? 0.78 : 0.7);
  mergeImage(draft, fast.imageUrl, tierTag === "playwright" ? "playwright" : "opengraph", tierTag === "playwright" ? 0.8 : 0.75);
  addAttempt(
    draft,
    `${tierLabel}_layer1_fast_metadata`,
    !!fast.title || !!fast.imageUrl,
    "og/twitter/title/canonical"
  );

  dbg?.tiersTried.push(tierTag === "playwright" ? "playwright_jsonld" : "jsonld");
  const ld = parseFromJsonLd(pageUrl, $);
  mergeTitle(draft, ld.title, tierTag === "playwright" ? "playwright" : "jsonld", 0.9);
  mergeImage(draft, ld.imageUrl, tierTag === "playwright" ? "playwright" : "jsonld", 0.85);
  mergePrice(draft, ld.price, ld.currency, tierTag === "playwright" ? "playwright" : "jsonld", 0.95);
  addAttempt(
    draft,
    `${tierLabel}_layer2_jsonld`,
    !!ld.title || !!ld.imageUrl || ld.price != null,
    "jsonld parsed"
  );

  const domPriceCandidates = extractDomPriceCandidates($, draft.domain);
  const bestDomPrice = pickBestPriceCandidate(domPriceCandidates);

  if (bestDomPrice) {
    mergePrice(
      draft,
      bestDomPrice.amount,
      bestDomPrice.currency,
      tierTag === "playwright" ? "playwright" : "html",
      Math.max(0.65, bestDomPrice.confidence)
    );
  }

  addAttempt(
    draft,
    `${tierLabel}_layer3_dom_heuristics`,
    !!bestDomPrice,
    bestDomPrice
      ? `${bestDomPrice.source} amount=${bestDomPrice.amount} currency=${bestDomPrice.currency}`
      : "no ranked dom price candidate"
  );

  refreshDraftStatus(draft);
}

export async function parseProductUrl(
  inputUrl: string,
  opts: { debug: boolean; scraperServiceUrl?: string; scraperToken?: string }
): Promise<ParseResult | ParseFail> {
  inputUrl = normalizeUrl(inputUrl);

  const draft = makeDraft(inputUrl);
  const warnings: string[] = [];
  const dbg: any = opts.debug ? { tiersTried: [] as string[] } : undefined;
  let fetchedNonOkStatus: number | null = null;

  const hasPlaywrightService =
    !!opts.scraperServiceUrl &&
    /^https?:\/\//i.test(opts.scraperServiceUrl) &&
    !opts.scraperServiceUrl.includes("<");

  if (opts.scraperServiceUrl && !hasPlaywrightService) {
    warnings.push("scraper_service_misconfigured");
    addAttempt(draft, "playwright_config", false, "SCRAPER_SERVICE_URL is not a valid http(s) URL");
  }

  // Layer 0/adapter fast win: Shopify JSON
  try {
    dbg?.tiersTried.push("shopify_json");
    const shop = await tryShopifyJson(inputUrl);
    addAttempt(draft, "layer2_shopify_json", !!shop?.title, shop?.title ? "shopify hit" : "no shopify data");

    if (shop?.title) {
      const conf = score(shop);
      mergeTitle(draft, shop.title, "shopify_json", conf);
      mergeImage(draft, absUrl(inputUrl, shop.imageUrl), "shopify_json", conf);
      mergePrice(draft, shop.price, shop.currency, "shopify_json", conf);
      refreshDraftStatus(draft);

      if (!shop.currency) warnings.push("currency_missing");
      if (draft.status === "complete" && conf >= 0.7) {
        return resultFromDraft({
          draft,
          source: "shopify_json",
          confidence: conf,
          warnings: warnings.length ? warnings : undefined,
          debug: dbg,
        });
      }
    }
  } catch (e: any) {
    warnings.push("shopify_json_failed");
    if (dbg) dbg.shopifyError = e?.message ?? String(e);
  }

  // Fetch HTML once
  let res: Response;
  let html: string;

  try {
    dbg?.tiersTried.push("html_fetch");
    const got = await fetchWithRetry(inputUrl, 2);
    res = got.res;
    html = got.text;

    mergeCanonical(draft, res.url || inputUrl);
    addAttempt(
      draft,
      "layer0_url_canonical",
      !!draft.canonicalUrl,
      draft.canonicalUrl ? "normalized + redirects" : "canonical unresolved"
    );

    if (!res.ok) {
      fetchedNonOkStatus = res.status;
      if (hasPlaywrightService) {
        dbg?.tiersTried.push("playwright");
        const pw = await callPlaywrightFallback(inputUrl, opts, dbg);
        addAttempt(
          draft,
          "layer4_playwright",
          pw.ok,
          pw.ok ? `playwright extraction after http_${res.status}` : pw.error
        );

        if (pw.ok) {
          const confPw = Math.max(0.75, score(pw));
          mergeCanonical(draft, pw.finalUrl || inputUrl);

          if (pw.html) {
            applyHtmlLayersToDraft({
              draft,
              html: pw.html,
              pageUrl: pw.finalUrl || inputUrl,
              tierTag: "playwright",
              tierLabel: "playwright",
              dbg,
            });
          }

          mergeTitle(draft, pw.title, "playwright", confPw);
          mergeImage(draft, pw.imageUrl, "playwright", confPw);
          mergePrice(draft, pw.price, pw.currency, "playwright", confPw);
          refreshDraftStatus(draft);

          if (!pw.title) warnings.push("title_missing");
          if (!pw.imageUrl) warnings.push("image_missing");
          if (pw.price == null) warnings.push("price_missing");
          if (!pw.currency) warnings.push("currency_missing");

          return resultFromDraft({
            draft,
            source: "playwright",
            confidence: confPw,
            warnings: warnings.length ? warnings : undefined,
            debug: dbg,
          });
        }
      }

      if (isBlockedContent(html)) {
        const blockedReason = detectBlockedReason(html) || "blocked_unknown";
        draft.status = "blocked";
        refreshDraftStatus(draft);
        addAttempt(draft, "layer6_blocked_detection", true, blockedReason);

        return {
          ok: false,
          url: draft.canonicalUrl || inputUrl,
          error: blockedReason,
          source: "html",
          blockedReason,
          debug: dbg ? { ...dbg, fetchedStatus: res.status, fetchedBytes: html?.length ?? 0 } : undefined,
        };
      }

      warnings.push(`http_${res.status}`);
      addAttempt(
        draft,
        "layer_http_non_ok",
        true,
        `continue parsing non-ok html status ${res.status}`
      );
    }
  } catch (e: any) {
    return {
      ok: false,
      url: draft.canonicalUrl || inputUrl,
      error: e?.message ?? "Fetch failed",
      source: "html",
      debug: dbg,
    };
  }

  if (isBlockedContent(html)) {
    const blockedReason = detectBlockedReason(html) || "blocked_unknown";
    addAttempt(draft, "layer6_blocked_detection", true, blockedReason);

    if (hasPlaywrightService) {
      dbg?.tiersTried.push("playwright");
      const pw = await callPlaywrightFallback(inputUrl, opts, dbg);
      addAttempt(
        draft,
        "layer4_playwright",
        pw.ok,
        pw.ok ? `playwright extraction after ${blockedReason}` : pw.error
      );

      if (pw.ok) {
        const confPw = Math.max(0.75, score(pw));
        mergeCanonical(draft, pw.finalUrl || inputUrl);

        if (pw.html) {
          applyHtmlLayersToDraft({
            draft,
            html: pw.html,
            pageUrl: pw.finalUrl || inputUrl,
            tierTag: "playwright",
            tierLabel: "playwright",
            dbg,
          });
        }

        mergeTitle(draft, pw.title, "playwright", confPw);
        mergeImage(draft, pw.imageUrl, "playwright", confPw);
        mergePrice(draft, pw.price, pw.currency, "playwright", confPw);
        refreshDraftStatus(draft);

        return resultFromDraft({
          draft,
          source: "playwright",
          confidence: confPw,
          warnings: warnings.length ? warnings : undefined,
          debug: dbg,
        });
      }
    }

    draft.status = "blocked";
    refreshDraftStatus(draft);
    return {
      ok: false,
      url: draft.canonicalUrl || inputUrl,
      error: blockedReason,
      source: "html",
      blockedReason,
      debug: dbg,
    };
  }

  dbg?.tiersTried.push("opengraph");
  applyHtmlLayersToDraft({
    draft,
    html,
    pageUrl: res.url || inputUrl,
    tierTag: "html",
    tierLabel: "layer",
    dbg,
  });

  const mergedForScore = {
    title: draft.title?.value || "",
    imageUrl: draft.image?.value || "",
    price: draft.price?.value?.amount ?? null,
    currency: draft.price?.value?.currency ?? null,
  };
  const conf = score(mergedForScore);

  // Step C: run Playwright only when required fields are still missing.
  const needsPlaywright = !!opts.scraperServiceUrl && !hasRequiredFields(draft);
  if (needsPlaywright) {
    dbg?.tiersTried.push("playwright");
    const pw = await callPlaywrightFallback(inputUrl, opts, dbg);
    addAttempt(draft, "layer4_playwright", pw.ok, pw.ok ? "playwright extraction" : pw.error);

    if (pw.ok) {
      const conf2 = Math.max(conf, score(pw), 0.75);
      mergeCanonical(draft, pw.finalUrl || inputUrl);

      if (pw.html) {
        const renderedBlockedReason = detectBlockedReason(pw.html);
        if (renderedBlockedReason) {
          draft.status = "blocked";
          refreshDraftStatus(draft);
          addAttempt(draft, "layer6_blocked_detection_playwright", true, renderedBlockedReason);

          return {
            ok: false,
            url: draft.canonicalUrl || inputUrl,
            error: renderedBlockedReason,
            source: "playwright",
            blockedReason: renderedBlockedReason,
            debug: dbg,
          };
        }

        applyHtmlLayersToDraft({
          draft,
          html: pw.html,
          pageUrl: pw.finalUrl || inputUrl,
          tierTag: "playwright",
          tierLabel: "playwright",
          dbg,
        });
      }

      // keep direct service fields as a final assist
      mergeTitle(draft, pw.title, "playwright", conf2);
      mergeImage(draft, pw.imageUrl, "playwright", conf2);
      mergePrice(draft, pw.price, pw.currency, "playwright", conf2);
      refreshDraftStatus(draft);

      return resultFromDraft({
        draft,
        source: "playwright",
        confidence: conf2,
        warnings: warnings.length ? warnings : undefined,
        debug: dbg ? { ...dbg, fetchedStatus: res.status, fetchedBytes: html.length } : undefined,
      });
    }

    warnings.push("playwright_failed");
    if (pw.blockedReason) {
      warnings.push(pw.blockedReason);
    }
    if (dbg) dbg.playwrightError = pw.error;
  }

  const finalSource: ParseResult["source"] =
    draft.title?.source === "jsonld" ||
    draft.image?.source === "jsonld" ||
    draft.price?.source === "jsonld"
      ? "jsonld"
      : "opengraph";

  return resultFromDraft({
    draft,
    source: finalSource,
    confidence: conf,
    warnings: warnings.length ? warnings : undefined,
    debug: dbg
      ? {
          ...dbg,
          fetchedStatus: fetchedNonOkStatus ?? res.status,
          fetchedBytes: html.length,
        }
      : undefined,
  });
}
