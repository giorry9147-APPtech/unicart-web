import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    // Body als tekst lezen
    const text = await req.text();

    if (!text) {
      return NextResponse.json(
        { error: "Missing request body" },
        { status: 400 }
      );
    }

    let body: { url?: string };
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in body" },
        { status: 400 }
      );
    }

    const url = body.url;
    if (!url) {
      return NextResponse.json(
        { error: "Missing 'url' field in body" },
        { status: 400 }
      );
    }

    // URL parsen
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      return NextResponse.json(
        { error: "Invalid URL format" },
        { status: 400 }
      );
    }

    // MOCK data terugsturen
    return NextResponse.json({
      url,
      title: "Mocked Product",
      price: 29.99,
      shop: hostname,
      image: "https://via.placeholder.com/600",
    });
  } catch (err) {
    console.error("Parse API error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

