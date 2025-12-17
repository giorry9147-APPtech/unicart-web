import { NextResponse } from "next/server";
import * as cheerio from "cheerio";

export const runtime = "nodejs";

function pickFirst(...vals: Array<string | undefined | null>) {
  return vals.find((v) => typeof v === "string" && v.trim().length > 0)?.trim() || "";
}

function toAbsoluteUrl(maybeUrl: string, baseUrl: string) {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return maybeUrl;
  }
}

function parseJsonLdPrices($: cheerio.CheerioAPI) {
  const scripts = $('script[type="application/ld+json"]');
  for (const el of scripts.toArray()) {
    const raw = $(el).contents().text();
    if (!raw) continue;

    try {
      const json = JSON.parse(raw);

      // JSON-LD kan een object of array zijn
      const candidates = Array.isArray(json) ? json : [json];

      for (const obj of candidates) {
        // Veel webshops gebruiken Product -> offers
        const offers = obj?.offers;
        const offerArr = Array.isArray(offers) ? offers : offers ? [offers] : [];

        for (const offer of offerArr) {
          const price =
            offer?.price ??
            offer?.lowPrice ??
            offer?.highPrice ??
            offer?.priceSpecification?.price;

          const currency =
            offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency;

          if (price != null) {
            const num = Number(String(price).replace(",", "."));
            if (!Number.isNaN(num)) {
              return { price: num, currency: currency || "" };
            }
          }
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }

  return { price: null as number | null, currency: "" };
}

export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (!text) {
      return NextResponse.json({ error: "Missing request body" }, { status: 400 });
    }

    let body: { url?: string };
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON in body" }, { status: 400 });
    }

    const url = body.url;
    if (!url) {
      return NextResponse.json({ error: "Missing 'url' field in body" }, { status: 400 });
    }

    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
    }

    // Fetch pagina HTML
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        // Veel sites geven anders bot/lege HTML terug
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "nl-NL,nl;q=0.9,en;q=0.8",
      },
      // Next.js caching uit
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Failed to fetch page (${res.status})`, url, shop: hostname },
        { status: 502 }
      );
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Title (OG / Twitter / <title>)
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const twTitle = $('meta[name="twitter:title"]').attr("content");
    const docTitle = $("title").first().text();
    const h1 = $("h1").first().text();

    const title = pickFirst(ogTitle, twTitle, h1, docTitle);

    // Image (OG / Twitter / eerste product image fallback)
    const ogImage = $('meta[property="og:image"]').attr("content");
    const twImage = $('meta[name="twitter:image"]').attr("content");
    const imgFallback =
      $('img[itemprop="image"]').attr("src") ||
      $('img[data-testid*="image"]').attr("src") ||
      $("img").first().attr("src");

    const imageRaw = pickFirst(ogImage, twImage, imgFallback);
    const image = imageRaw ? toAbsoluteUrl(imageRaw, url) : "";

    // Price (JSON-LD eerst)
    const { price: jsonLdPrice } = parseJsonLdPrices($);

    // Extra price fallbacks (meta itemprop / common attributes)
    const metaPrice =
      $('meta[itemprop="price"]').attr("content") ||
      $('[itemprop="price"]').attr("content") ||
      $('[data-testid*="price"]').first().text() ||
      $('[class*="price"]').first().text();

    let price: number | null = jsonLdPrice;
    if (price == null && metaPrice) {
      const cleaned = String(metaPrice)
        .replace(/\s/g, "")
        .replace("€", "")
        .replace(",", ".")
        .match(/(\d+(\.\d+)?)/)?.[0];

      if (cleaned) {
        const num = Number(cleaned);
        if (!Number.isNaN(num)) price = num;
      }
    }

    return NextResponse.json({
      url,
      title: title || "",
      price: price ?? null,
      shop: hostname.replace(/^www\./, ""),
      image: image || "",
    });
  } catch (err) {
    console.error("Parse API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}


