import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // Support BOTH formats:
    // 1) { url, title }
    // 2) { idToken, item: { url, title, ... } }
    const item = body?.item ?? body;
    const url = item?.url;
    const title = item?.title ?? "";

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "Missing url", receivedKeys: Object.keys(body ?? {}) },
        { status: 400 }
      );
    }

    // For now: just confirm receipt
    return NextResponse.json({
      ok: true,
      saved: { url, title },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
