import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import * as cheerio from "cheerio";

function getDomain(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function pickFirst(...vals: Array<string | undefined | null>) {
  for (const v of vals) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function parsePriceLoose(s: string): number | null {
  const cleaned = String(s).replace(/\s/g, "");
  const m = cleaned.match(/(\d{1,6})([.,]\d{2})?/);
  if (!m) return null;
  const num = Number((m[0] || "").replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

export async function POST(req: Request) {
  try {
    // ✅ internal protection
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

    const domain = getDomain(url) || "unknown";

    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; UniCartBot/1.0; +https://unicart-web.vercel.app)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      await adminDb()
        .collection("users")
        .doc(uid)
        .collection("wishlist_items")
        .doc(itemId)
        .set(
          {
            enrichStatus: "failed",
            enrichError: `HTTP ${res.status}`,
            enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      return NextResponse.json({ ok: false, error: "Fetch failed" }, { status: 200 });
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content");
    const ogImage = $('meta[property="og:image"]').attr("content");

    // JSON-LD Product attempt
    let ldTitle: string | null = null;
    let ldImage: string | null = null;
    let ldPrice: number | null = null;

    const scripts = $('script[type="application/ld+json"]')
      .map((_, el) => $(el).text())
      .get();

    for (const raw of scripts) {
      try {
        const json = JSON.parse(raw);
        const nodes = Array.isArray(json) ? json : [json];

        for (const n of nodes) {
          const type = (n?.["@type"] || "").toString().toLowerCase();
          if (type === "product") {
            ldTitle = ldTitle ?? (n?.name ? String(n.name) : null);

            const img = n?.image;
            if (typeof img === "string") ldImage = ldImage ?? img;
            if (Array.isArray(img) && typeof img[0] === "string") ldImage = ldImage ?? img[0];

            const offers = n?.offers;
            const offer = Array.isArray(offers) ? offers[0] : offers;
            const price = offer?.price ?? offer?.lowPrice;
            if (price != null) {
              const p = Number(String(price).replace(",", "."));
              ldPrice = Number.isFinite(p) ? p : ldPrice;
            }
          }
        }
      } catch {
        // ignore bad JSON-LD
      }
    }

    const metaPrice =
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[name="twitter:data1"]').attr("content") ||
      "";

    const title = pickFirst(ldTitle, ogTitle, $("title").first().text(), domain);
    const image_url = pickFirst(ldImage, ogImage, "");
    const price = ldPrice ?? (metaPrice ? parsePriceLoose(metaPrice) : null);

    await adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId)
      .set(
        {
          title,
          image_url,
          ...(price != null ? { price } : {}),
          shop: domain,
          domain,
          enrichStatus: "ok",
          enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return NextResponse.json({ ok: true, title, image_url, price });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
