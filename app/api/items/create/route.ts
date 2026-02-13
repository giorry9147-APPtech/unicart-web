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

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ ok: false, error: "Missing token" }, { status: 401 });
    }

    const decoded = await adminAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const body = await req.json();
    const url = String(body?.url || "").trim();
    const source = String(body?.source || "app_manual").trim();

    if (!url) return NextResponse.json({ ok: false, error: "Missing url" }, { status: 400 });

    const domain = getDomain(url);
    if (!domain) return NextResponse.json({ ok: false, error: "Invalid url" }, { status: 400 });

    const itemId = crypto.randomUUID();

    // ✅ schrijf velden die jouw wishlist.tsx verwacht
    const item = {
      id: itemId,
      title: body?.title ?? domain,       // voorlopig domain als fallback
      price: typeof body?.price === "number" ? body.price : null,
      shop: body?.shop ?? domain,
      product_url: url,
      image_url: body?.image_url ?? "",
      status: "todo",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      domain,
      category: body?.category ?? "other",
      source, // app_manual | mobile_share | extension
    };

    await adminDb()
      .collection("users")
      .doc(uid)
      .collection("wishlist_items")
      .doc(itemId)
      .set(item, { merge: true });

    return NextResponse.json({ ok: true, itemId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
