import { NextResponse } from "next/server";
import * as cheerio from "cheerio";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing 'url' in body" }, { status: 400 });
    }

    // Basic validation
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "Invalid url (must start with http/https)" }, { status: 400 });
    }

    // Fetch the page HTML
    const res = await fetch(url, {
      // Some sites block default fetch user-agent; this helps a bit
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      redirect: "follow",
      // cache: "no-store" // optional
    });

    const html = await res.text();

    // If blocked, return useful info (so you can see it in the extension)
    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Fetch failed`,
          status: res.status,
          statusText: res.statusText,
          hint:
            "Site may block scraping (403/401) or requires cookies/JS rendering. Try another site.",
        },
        { status: 502 }
      );
    }

    const $ = cheerio.load(html);

    // --- Helpers ---
    const pick = (...candidates: (string | undefined | null)[]) =>
      candidates.find((v) => typeof v === "string" && v.trim().length > 0)?.trim() ?? "";

    const absUrl = (maybeUrl: string) => {
      try {
        return new URL(maybeUrl, url).toString();
      } catch {
        return "";
      }
    };

    // --- Title ---
    const title = pick(
      $('meta[property="og:title"]').attr("content"),
      $('meta[name="twitter:title"]').attr("content"),
      $("title").text()
    );

    // --- Image ---
    const image = pick(
      $('meta[property="og:image"]').attr("content"),
      $('meta[name="twitter:image"]').attr("content")
    );
    const imageUrl = image ? absUrl(image) : "";

    // --- Price (best effort) ---
    // Common places (not perfect; later we improve per shop)
    const price = pick(
      $('meta[property="product:price:amount"]').attr("content"),
      $('meta[name="product:price:amount"]').attr("content"),
      $('[itemprop="price"]').attr("content"),
      $('[itemprop="price"]').first().text()
    );

    // --- Currency ---
    const currency = pick(
      $('meta[property="product:price:currency"]').attr("content"),
      $('meta[name="product:price:currency"]').attr("content"),
      $('[itemprop="priceCurrency"]').attr("content"),
      $('[itemprop="priceCurrency"]').first().text()
    );

    return NextResponse.json({
      ok: true,
      url,
      title,
      imageUrl,
      price,
      currency,
      // debug snippet (handig voor nu; later weg)
      fetchedStatus: res.status,
      fetchedBytes: html.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown parse error" },
      { status: 500 }
    );
  }
}
