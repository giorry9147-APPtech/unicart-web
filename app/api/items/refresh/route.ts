import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";

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
    const url = String(data?.product_url || "").trim();
    if (!url) {
      return NextResponse.json({ ok: false, error: "Item has no product_url" }, { status: 400 });
    }

    // 4) Set pending immediately (UX)
    await ref.set(
      {
        enrichStatus: "pending",
        enrichError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 5) Fire-and-forget internal enrich
    const baseUrl = process.env.BASE_URL || "https://unicart-web.vercel.app";
    const enrichSecret = process.env.ENRICH_SECRET || "";

    fetch(`${baseUrl}/api/items/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-enrich-secret": enrichSecret,
      },
      body: JSON.stringify({ uid, itemId, url }),
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}
