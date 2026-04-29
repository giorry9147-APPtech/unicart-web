// unicart-web/app/api/cron/refresh-prices/route.ts
//
// Daily Vercel cron that picks a batch of stale wishlist items, re-scrapes
// the product, updates currentPrice + priceHistory, and pushes a notification
// to the owning user when a meaningful price drop is detected.
//
// Auth: Vercel cron auto-sends `Authorization: Bearer ${CRON_SECRET}` when the
// CRON_SECRET env var is set (https://vercel.com/docs/cron-jobs/manage-cron-jobs).
// We accept either that header OR a `?secret=` query param so manual triggers work.

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebaseAdmin";
import * as admin from "firebase-admin";
import { parseProductUrl } from "@/lib/scraper/parseProduct";
import { sendExpoPush, isValidExpoPushToken } from "@/lib/notifications/expoPush";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Tunables
const BATCH_LIMIT = 25; // hard cap per cron run (60s budget; ~2s per item)
const STALE_AFTER_MS = 23 * 60 * 60 * 1000; // re-check at most once per ~day
const DROP_THRESHOLD = 0.02; // notify when new price is >=2% lower
const HISTORY_MAX = 30; // keep last N price points per item

type ItemDoc = {
  product_url?: string;
  url?: string;
  price?: number | null;
  currency?: string | null;
  enrichStatus?: string;
  lastPriceCheckAt?: admin.firestore.Timestamp;
  lastNotifiedPrice?: number | null;
  priceHistory?: Array<{ ts: admin.firestore.Timestamp; price: number }>;
  title?: string;
};

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = req.headers.get("authorization") || "";
  if (header === `Bearer ${expected}`) return true;

  const url = new URL(req.url);
  if (url.searchParams.get("secret") === expected) return true;

  return false;
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

async function pickStaleItems(limit: number) {
  const db = adminDb();
  const cutoff = admin.firestore.Timestamp.fromMillis(
    Date.now() - STALE_AFTER_MS
  );

  // Items that have at least one good parse and are due for a re-check.
  // We split into two queries (no lastPriceCheckAt + old lastPriceCheckAt)
  // because Firestore can't OR across "missing field" and "<= cutoff".
  const cgWithCheck = db
    .collectionGroup("wishlist_items")
    .where("enrichStatus", "==", "ok")
    .where("lastPriceCheckAt", "<=", cutoff)
    .orderBy("lastPriceCheckAt", "asc")
    .limit(limit);

  const cgWithoutCheck = db
    .collectionGroup("wishlist_items")
    .where("enrichStatus", "==", "ok")
    .where("lastPriceCheckAt", "==", null as any)
    .limit(limit);

  const [withSnap, withoutSnap] = await Promise.allSettled([
    cgWithCheck.get(),
    cgWithoutCheck.get(),
  ]);

  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (withSnap.status === "fulfilled") docs.push(...withSnap.value.docs);
  if (withoutSnap.status === "fulfilled") docs.push(...withoutSnap.value.docs);

  // De-dup by ref path, then trim to limit.
  const seen = new Set<string>();
  const unique: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const d of docs) {
    if (seen.has(d.ref.path)) continue;
    seen.add(d.ref.path);
    unique.push(d);
    if (unique.length >= limit) break;
  }
  return unique;
}

async function getUserPushToken(uid: string): Promise<string | null> {
  const userSnap = await adminDb().collection("users").doc(uid).get();
  const tok = (userSnap.exists ? (userSnap.data() as any) : {})?.expoPushToken;
  return isValidExpoPushToken(tok) ? tok : null;
}

function shortTitle(t: string | undefined, max = 40) {
  if (!t) return "Je product";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatPrice(amount: number, currency?: string | null) {
  const cur = (currency || "EUR").toUpperCase();
  const symbol = cur === "EUR" ? "€" : cur === "USD" ? "$" : `${cur} `;
  return `${symbol}${amount.toFixed(2).replace(".", ",")}`;
}

async function refreshOne(
  doc: FirebaseFirestore.QueryDocumentSnapshot
): Promise<{
  ok: boolean;
  drop?: { from: number; to: number; uid: string; itemId: string };
  error?: string;
}> {
  const data = doc.data() as ItemDoc;
  const urlRaw = String(data.product_url || data.url || "").trim();
  if (!urlRaw) return { ok: false, error: "no url" };

  const url = normalizeUrl(urlRaw);
  const oldPrice = typeof data.price === "number" ? data.price : null;

  const parsed = await parseProductUrl(url, {
    debug: process.env.SCRAPE_DEBUG === "1",
    scraperServiceUrl: process.env.SCRAPER_SERVICE_URL || undefined,
    scraperToken: process.env.SCRAPER_TOKEN || undefined,
  });

  const updates: Record<string, any> = {
    lastPriceCheckAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!parsed.ok || typeof parsed.price !== "number") {
    updates.lastPriceCheckError = parsed.ok
      ? "no price parsed"
      : parsed.error || "parse failed";
    await doc.ref.set(updates, { merge: true });
    return { ok: false, error: updates.lastPriceCheckError };
  }

  const newPrice = parsed.price;
  updates.price = newPrice;
  if (parsed.currency) updates.currency = parsed.currency;
  updates.lastPriceCheckError = admin.firestore.FieldValue.delete();

  // Append to priceHistory, trimmed.
  const history = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  const trimmed = [...history, { ts: admin.firestore.Timestamp.now(), price: newPrice }];
  if (trimmed.length > HISTORY_MAX) trimmed.splice(0, trimmed.length - HISTORY_MAX);
  updates.priceHistory = trimmed;

  // Drop detection: only when we had a previous numeric price AND drop is meaningful
  // AND we haven't already notified about this same low price.
  const isDrop =
    oldPrice !== null &&
    newPrice < oldPrice * (1 - DROP_THRESHOLD) &&
    (data.lastNotifiedPrice == null || newPrice < data.lastNotifiedPrice);

  if (isDrop) {
    updates.lastDropFrom = oldPrice;
    updates.lastDropAt = admin.firestore.FieldValue.serverTimestamp();
    updates.lastNotifiedPrice = newPrice;
  }

  await doc.ref.set(updates, { merge: true });

  if (isDrop) {
    // Path is users/{uid}/wishlist_items/{itemId}
    const segments = doc.ref.path.split("/");
    const uid = segments[1];
    const itemId = segments[3];
    return { ok: true, drop: { from: oldPrice!, to: newPrice, uid, itemId } };
  }

  return { ok: true };
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const startedAt = Date.now();

  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    docs = await pickStaleItems(BATCH_LIMIT);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Failed to pick items" },
      { status: 500 }
    );
  }

  let processed = 0;
  let succeeded = 0;
  let drops = 0;
  let pushed = 0;
  const errors: string[] = [];

  // Process sequentially — playwright can be heavy; parallel would risk OOM on the scraper.
  for (const doc of docs) {
    if (Date.now() - startedAt > 50_000) break; // leave headroom under 60s
    processed++;
    try {
      const r = await refreshOne(doc);
      if (r.ok) succeeded++;
      if (r.ok && r.drop) {
        drops++;
        const data = doc.data() as ItemDoc;
        const token = await getUserPushToken(r.drop.uid);
        if (token) {
          const result = await sendExpoPush([
            {
              to: token,
              title: "Goedkoper geworden! 🎉",
              body: `${shortTitle(data.title)} is nu ${formatPrice(
                r.drop.to,
                data.currency
              )} (was ${formatPrice(r.drop.from, data.currency)})`,
              sound: "default",
              data: {
                type: "price_drop",
                itemId: r.drop.itemId,
                from: r.drop.from,
                to: r.drop.to,
              },
            },
          ]);
          if (result.ok) pushed++;
          else errors.push(`push ${r.drop.uid}: ${result.error || "unknown"}`);
        }
      } else if (!r.ok) {
        errors.push(`${doc.ref.path}: ${r.error}`);
      }
    } catch (e: any) {
      errors.push(`${doc.ref.path}: ${e?.message || "throw"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    candidates: docs.length,
    processed,
    succeeded,
    drops,
    pushed,
    errors: errors.slice(0, 10),
  });
}
