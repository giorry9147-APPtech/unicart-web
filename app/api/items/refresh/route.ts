import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import { parseProductUrl } from "@/lib/scraper/parseProduct";

export async function POST(req: Request) {
  try {
    // 1) Auth
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ ok: false, error: "Missing token" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const uid = decoded.uid;

    // 2) Input
    const body = await req.json().catch(() => ({}));
    const itemId = String(body?.itemId || "").trim();
    if (!itemId) {
      return NextResponse.json({ ok: false, error: "Missing itemId" }, { status: 400 });
    }

    // 3) Read item
    const ref = adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId);

    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ ok: false, error: "Item not found" }, { status: 404 });
    }

    const data = snap.data() as any;

    // support both fields just in case you have mixed data
    const url = String(data?.product_url || data?.url || "").trim();
    if (!url) {
      return NextResponse.json({ ok: false, error: "Item has no product_url" }, { status: 400 });
    }

    // 4) Mark pending (UX)
    await ref.set(
      {
        enrichStatus: "pending",
        enrichError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 5) Parse now (tiered: html -> playwright via env)
    const debug = process.env.SCRAPE_DEBUG === "1";
    const scraperServiceUrl = process.env.SCRAPER_SERVICE_URL || undefined;
    const scraperToken = process.env.SCRAPER_TOKEN || undefined;

    const parsed = await parseProductUrl(url, {
      debug,
      scraperServiceUrl,
      scraperToken,
    });
    
    if (!parsed.ok) {
      await ref.set(
        {
          enrichStatus: "failed",
          enrichError: parsed.error,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return NextResponse.json(parsed, { status: 502 });
    }

    // 6) Write back to Firestore (map to your schema)
    await ref.set(
      {
        // keep your url field stable
        product_url: url,

        // fields your UI likely reads
        title: parsed.title || data?.title || "",
        image_url: parsed.imageUrl || data?.image_url || "",
        price: parsed.price ?? data?.price ?? null,
        currency: parsed.currency ?? data?.currency ?? null,

        // status/meta
        enrichStatus: "success",
        enrichError: admin.firestore.FieldValue.delete(),
        parseSource: parsed.source,
        parseConfidence: parsed.confidence,
        parseWarnings: parsed.warnings ?? [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRefreshedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return NextResponse.json({ ok: true, itemId, parsed });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}