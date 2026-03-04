// unicart-web/app/api/items/enrich/route.ts
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import { parseProductUrl } from "@/lib/scraper/parseProduct";

type EnrichStatus = "pending" | "ok" | "failed";

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

function isEmpty(v: any) {
  return (
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.trim().length === 0)
  );
}

export async function POST(req: Request) {
  try {
    const secret = req.headers.get("x-enrich-secret");
    if (!process.env.ENRICH_SECRET || secret !== process.env.ENRICH_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const uid = String(body?.uid || "").trim();
    const itemId = String(body?.itemId || "").trim();
    const urlRaw = String(body?.url || "").trim();

    if (!uid || !itemId || !urlRaw) {
      return NextResponse.json(
        { ok: false, error: "Missing uid/itemId/url" },
        { status: 400 }
      );
    }

    const url = normalizeUrl(urlRaw);

    const ref = adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId);

    // Load existing item to respect user edits
    const snap = await ref.get();
    const current = (snap.exists ? (snap.data() as any) : {}) || {};
    const userEdited = current.userEdited === true;

    // Tiered parse (html -> playwright fallback)
    const debug = process.env.SCRAPE_DEBUG === "1";
    const scraperServiceUrl = process.env.SCRAPER_SERVICE_URL || undefined;
    const scraperToken = process.env.SCRAPER_TOKEN || undefined;

    const parsed = await parseProductUrl(url, {
      debug,
      scraperServiceUrl,
      scraperToken,
    });

    const updates: any = {
      enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // keep canonical url stable in db (A1)
      product_url: url,
    };

    if (!parsed.ok) {
      updates.enrichStatus = "failed" as EnrichStatus;
      updates.enrichError = parsed.error;

      await ref.set(updates, { merge: true });

      // return 200 so create caller doesn’t retry forever
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 200 });
    }

    // fields from parser
    const nextTitle = parsed.title || "";
    const nextImage = parsed.imageUrl || "";
    const nextPrice = parsed.price ?? null;
    const nextCurrency = parsed.currency ?? null;

    // Always safe meta (don’t fight user)
    if (!isEmpty(nextCurrency) && isEmpty(current.currency)) updates.currency = nextCurrency;

    if (userEdited) {
      // ONLY fill missing fields
      if (!isEmpty(nextTitle) && isEmpty(current.title)) updates.title = nextTitle;
      if (!isEmpty(nextImage) && isEmpty(current.image_url)) updates.image_url = nextImage; // ✅ underscore

      if (typeof nextPrice === "number" && (current.price === null || current.price === undefined)) {
        updates.price = nextPrice;
      }
    } else {
      // normal mode: update when parser has values
      if (!isEmpty(nextTitle)) updates.title = nextTitle;
      if (!isEmpty(nextImage)) updates.image_url = nextImage; // ✅ underscore
      if (typeof nextPrice === "number") updates.price = nextPrice;
      if (!isEmpty(nextCurrency)) updates.currency = nextCurrency;
    }

    // Status
    const parsedHasUseful = !!nextTitle || !!nextImage || typeof nextPrice === "number";
    if (!parsedHasUseful) {
      updates.enrichStatus = "failed" as EnrichStatus;
      updates.enrichError = "No product data found";
    } else {
      updates.enrichStatus = "ok" as EnrichStatus;
      updates.enrichError = admin.firestore.FieldValue.delete();
    }

    // Debug/meta
    updates.parseSource = parsed.source;
    updates.parseConfidence = parsed.confidence;
    updates.parseWarnings = parsed.warnings ?? [];

    await ref.set(updates, { merge: true });

    return NextResponse.json({ ok: true, userEdited, updates });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}