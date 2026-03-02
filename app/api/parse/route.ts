// unicart-web/app/api/parse/route.ts
import { NextResponse } from "next/server";
import { parseProductUrl } from "@/lib/scraper/parseProduct";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url;

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing 'url' in body" },
        { status: 400 }
      );
    }

    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { ok: false, error: "Invalid url (must start with http/https)" },
        { status: 400 }
      );
    }

    const debug = process.env.SCRAPE_DEBUG === "1";
    const scraperServiceUrl = process.env.SCRAPER_SERVICE_URL || undefined;
    const scraperToken = process.env.SCRAPER_TOKEN || undefined;

    const result = await parseProductUrl(url, {
      debug,
      scraperServiceUrl,
      scraperToken,
    });

    // ParseFail -> geef 502 zodat client weet “retry/blocked”
    if (!result.ok) {
      return NextResponse.json(result, { status: 502 });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown parse error" },
      { status: 500 }
    );
  }
}