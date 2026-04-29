// unicart-web/app/api/items/enrich/route.ts
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import { parseProductUrl } from "@/lib/scraper/parseProduct";

// Same reasoning as /api/parse — playwright fallback can take 30s+
export const maxDuration = 60;

type EnrichStatus = "pending" | "ok" | "failed";
type IntakeStatus = "processing" | "ready" | "needs_user_input" | "blocked";

const REQUIRED_KEYS = ["title", "image", "price.amount", "price.currency"];

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

function pickNext(current: any, next: any) {
  return next !== undefined ? next : current;
}

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

    const snap = await ref.get();
    const current = (snap.exists ? (snap.data() as any) : {}) || {};
    const userEdited = current.userEdited === true;

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
      product_url: url,
    };

    if (!parsed.ok) {
      const blockedReason = parsed.blockedReason ?? null;
      const intake = deriveIntakeStatus({
        blockedReason,
        parseMissing: REQUIRED_KEYS,
      });

      updates.enrichStatus = "failed" as EnrichStatus;
      updates.enrichError = parsed.error;
      updates.parseStatus = blockedReason ? "blocked" : "needs_user_input";
      updates.parseMissing = REQUIRED_KEYS;
      updates.intakeStatus = intake.intakeStatus;
      updates.needsUserInput = intake.needsUserInput;
      updates.blockedReason = blockedReason;

      await ref.set(updates, { merge: true });

      return NextResponse.json(
        {
          ok: false,
          error: parsed.error,
          blockedReason,
          intakeStatus: intake.intakeStatus,
          needsUserInput: intake.needsUserInput,
        },
        { status: 200 }
      );
    }

    const nextCanonical = parsed.canonicalUrl || parsed.url || url;
    const nextDomain = parsed.domain || null;
    const nextTitle = parsed.title || "";
    const nextImage = parsed.imageUrl || "";
    const nextPrice = parsed.price ?? null;
    const nextCurrency = parsed.currency ?? null;

    if (!isEmpty(nextCanonical)) updates.product_url = nextCanonical;
    if (!isEmpty(nextDomain) && isEmpty(current.domain)) updates.domain = nextDomain;

    if (!isEmpty(nextCurrency) && isEmpty(current.currency)) updates.currency = nextCurrency;

    if (userEdited) {
      if (!isEmpty(nextTitle) && isEmpty(current.title)) updates.title = nextTitle;
      if (!isEmpty(nextImage) && isEmpty(current.image_url)) updates.image_url = nextImage;

      if (
        typeof nextPrice === "number" &&
        (current.price === null || current.price === undefined)
      ) {
        updates.price = nextPrice;
      }
    } else {
      if (!isEmpty(nextTitle)) updates.title = nextTitle;
      if (!isEmpty(nextImage)) updates.image_url = nextImage;
      if (typeof nextPrice === "number") updates.price = nextPrice;
      if (!isEmpty(nextCurrency)) updates.currency = nextCurrency;
    }

    const parsedHasUseful = !!nextTitle || !!nextImage || typeof nextPrice === "number";
    if (!parsedHasUseful) {
      updates.enrichStatus = "failed" as EnrichStatus;
      updates.enrichError = "No product data found";
    } else {
      updates.enrichStatus = "ok" as EnrichStatus;
      updates.enrichError = admin.firestore.FieldValue.delete();
    }

    updates.parseSource = parsed.source;
    updates.parseConfidence = parsed.confidence;
    updates.parseWarnings = parsed.warnings ?? [];
    updates.parseAttempts = parsed.attempts ?? [];
    updates.parseStatus = parsed.draftStatus ?? "partial";

    const finalTitle = pickNext(current.title, updates.title);
    const finalImage = pickNext(current.image_url, updates.image_url);
    const finalPrice = pickNext(current.price, updates.price);
    const finalCurrency = pickNext(current.currency, updates.currency);

    const parseMissing = [...(parsed.missing ?? [])];
    if (!finalTitle && !parseMissing.includes("title")) parseMissing.push("title");
    if (!finalImage && !parseMissing.includes("image")) parseMissing.push("image");
    if (
      (finalPrice === null || finalPrice === undefined) &&
      !parseMissing.includes("price.amount")
    ) {
      parseMissing.push("price.amount");
    }
    if (!finalCurrency && !parseMissing.includes("price.currency")) {
      parseMissing.push("price.currency");
    }

    updates.parseMissing = parseMissing;

    const blockedReason = parsed.draftStatus === "blocked" ? "blocked_unknown" : null;
    const intake = deriveIntakeStatus({ blockedReason, parseMissing });

    updates.intakeStatus = intake.intakeStatus;
    updates.needsUserInput = intake.needsUserInput;
    if (blockedReason) updates.blockedReason = blockedReason;
    else updates.blockedReason = admin.firestore.FieldValue.delete();

    await ref.set(updates, { merge: true });

    return NextResponse.json({
      ok: true,
      userEdited,
      intakeStatus: intake.intakeStatus,
      needsUserInput: intake.needsUserInput,
      updates,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}
