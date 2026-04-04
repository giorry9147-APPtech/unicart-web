// unicart-web/app/api/items/refresh/route.ts
import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import { parseProductUrl } from "@/lib/scraper/parseProduct";

type IntakeStatus = "processing" | "ready" | "needs_user_input" | "blocked";

const REQUIRED_KEYS = ["title", "image", "price.amount", "price.currency"];

function deriveIntakeStatus(params: {
  blockedReason?: string | null;
  parseMissing?: string[];
}): { intakeStatus: IntakeStatus; needsUserInput: boolean } {
  if (params.blockedReason) {
    return { intakeStatus: "blocked", needsUserInput: true };
  }

  const missingRequired = (params.parseMissing ?? []).filter((k) =>
    REQUIRED_KEYS.includes(k)
  );

  if (missingRequired.length > 0) {
    return { intakeStatus: "needs_user_input", needsUserInput: true };
  }

  return { intakeStatus: "ready", needsUserInput: false };
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

    const urlRaw = String(data?.product_url || data?.url || "").trim();
    if (!urlRaw) {
      return NextResponse.json({ ok: false, error: "Item has no product_url" }, { status: 400 });
    }

    const url = normalizeUrl(urlRaw);

    // 4) Mark pending (UX)
    await ref.set(
      {
        enrichStatus: "pending",
        enrichError: admin.firestore.FieldValue.delete(),
        intakeStatus: "processing",
        needsUserInput: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 5) Parse now (tiered)
    const debug = process.env.SCRAPE_DEBUG === "1";
    const scraperServiceUrl = process.env.SCRAPER_SERVICE_URL || undefined;
    const scraperToken = process.env.SCRAPER_TOKEN || undefined;

    const parsed = await parseProductUrl(url, {
      debug,
      scraperServiceUrl,
      scraperToken,
    });

    if (!parsed.ok) {
      const blockedReason = parsed.blockedReason ?? null;
      const intake = deriveIntakeStatus({
        blockedReason,
        parseMissing: REQUIRED_KEYS,
      });

      await ref.set(
        {
          enrichStatus: "failed",
          enrichError: parsed.error,
          parseStatus: blockedReason ? "blocked" : "needs_user_input",
          parseMissing: REQUIRED_KEYS,
          intakeStatus: intake.intakeStatus,
          needsUserInput: intake.needsUserInput,
          blockedReason,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return NextResponse.json(
        {
          ...parsed,
          intakeStatus: intake.intakeStatus,
          needsUserInput: intake.needsUserInput,
          blockedReason,
        },
        { status: 502 }
      );
    }

    // 6) Write back to Firestore (underscore schema)
    const parseMissing = parsed.missing ?? [];
    const blockedReason = parsed.draftStatus === "blocked" ? "blocked_unknown" : null;
    const intake = deriveIntakeStatus({ blockedReason, parseMissing });

    await ref.set(
      {
        product_url: parsed.canonicalUrl || parsed.url || url,
        domain: parsed.domain || data?.domain || null,
        title: parsed.title || data?.title || "",
        image_url: parsed.imageUrl || data?.image_url || "",
        price: parsed.price ?? data?.price ?? null,
        currency: parsed.currency ?? data?.currency ?? null,

        enrichStatus: "ok",
        enrichError: admin.firestore.FieldValue.delete(),
        parseSource: parsed.source,
        parseConfidence: parsed.confidence,
        parseWarnings: parsed.warnings ?? [],
        parseMissing: parsed.missing ?? [],
        parseAttempts: parsed.attempts ?? [],
        parseStatus: parsed.draftStatus ?? "partial",
        intakeStatus: intake.intakeStatus,
        needsUserInput: intake.needsUserInput,
        ...(blockedReason
          ? { blockedReason }
          : { blockedReason: admin.firestore.FieldValue.delete() }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRefreshedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return NextResponse.json({
      ok: true,
      itemId,
      intakeStatus: intake.intakeStatus,
      needsUserInput: intake.needsUserInput,
      blockedReason,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}