import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const { url } = await req.json();

  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;

    // Return MOCK data for now
    return NextResponse.json({
      url,
      title: 'Sample Product',
      price: 49.99,
      currency: 'EUR',
      image: 'https://via.placeholder.com/600x600',
      store: host
    });
  } catch {
    return NextResponse.json(
      { error: 'Invalid URL' },
      { status: 400 }
    );
  }
}
