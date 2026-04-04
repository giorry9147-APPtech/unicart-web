import { NextResponse } from "next/server";
import crypto from "crypto";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";

function getDomain(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const num = Number(s.replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // Extension sends { idToken, item: { url, title, shop, price, image, domain, category } }
    const idToken = body?.idToken;
    const item = body?.item ?? body;
    const url = String(item?.url || "").trim();

    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json({ ok: false, error: "Missing idToken" }, { status: 401 });
    }

    if (!url) {
      return NextResponse.json({ ok: false, error: "Missing url" }, { status: 400 });
    }

    // Verify Firebase token
    const decoded = await adminAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const domain = getDomain(url);
    if (!domain) {
      return NextResponse.json({ ok: false, error: "Invalid url" }, { status: 400 });
    }

    const itemId = crypto.randomUUID();

    const titleIn = String(item?.title || "").trim();
    const shopIn = String(item?.shop || "").trim();
    const imageIn = String(item?.image || item?.image_url || "").trim();
    const categoryIn = String(item?.category || "").trim();
    const priceIn = toNumberOrNull(item?.price);

    const doc: any = {
      id: itemId,
      title: titleIn || domain,
      price: priceIn,
      shop: shopIn || domain,
      product_url: url,
      image_url: imageIn,
      status: "todo",
      targetPrice: null,
      virtualSaved: 0,

      domain,
      category: categoryIn || "other",
      source: "extension",

      enrichStatus: "pending",
      intakeStatus: "processing",
      needsUserInput: false,
      blockedReason: null,
      parseStatus: "pending",
      parseMissing: ["title", "image", "price.amount", "price.currency"],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId)
      .set(doc, { merge: true });

    // Fire-and-forget enrichment
    const baseUrl = new URL(req.url).origin;
    const enrichSecret = process.env.ENRICH_SECRET || "";

    fetch(`${baseUrl}/api/items/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-enrich-secret": enrichSecret,
      },
      body: JSON.stringify({ uid, itemId, url }),
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      itemId,
      intakeStatus: "processing",
      needsUserInput: false,
      blockedReason: null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
