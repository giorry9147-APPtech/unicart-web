// unicart-web/app/api/items/create/route.ts
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
    // 1) Auth
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ ok: false, error: "Missing token" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const uid = decoded.uid;

    // 2) Input
    const body = await req.json();
    const url = String(body?.url || "").trim();
    const source = String(body?.source || "app_manual").trim(); // app_manual | mobile_share | extension

    if (!url) {
      return NextResponse.json({ ok: false, error: "Missing url" }, { status: 400 });
    }

    const domain = getDomain(url);
    if (!domain) {
      return NextResponse.json({ ok: false, error: "Invalid url" }, { status: 400 });
    }

    const itemId = crypto.randomUUID();

    // Optional fields (from app/share/extension)
    const titleIn = String(body?.title || "").trim();
    const shopIn = String(body?.shop || "").trim();
    const imageIn = String(body?.image_url || "").trim();
    const categoryIn = String(body?.category || "").trim();
    const priceIn = toNumberOrNull(body?.price);

    // 3) Minimal item that matches wishlist.tsx fields
    const item: any = {
      id: itemId,
      title: titleIn || domain,
      price: priceIn,
      shop: shopIn || domain,
      product_url: url,
      image_url: imageIn || "",
      status: "todo",
      targetPrice: null,
      virtualSaved: 0,

      domain,
      category: categoryIn || "other",
      source,

      enrichStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId)
      .set(item, { merge: true });

    // 4) Fire-and-forget enrichment (do not await)
    const baseUrl = process.env.BASE_URL || "https://unicart-web.vercel.app";
    const enrichSecret = process.env.ENRICH_SECRET || "";

    fetch(`${baseUrl}/api/items/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-enrich-secret": enrichSecret,
      },
      body: JSON.stringify({ uid, itemId, url }),
    }).catch(() => {
      // silent fail (best-effort)
    });

    return NextResponse.json({ ok: true, itemId });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}
