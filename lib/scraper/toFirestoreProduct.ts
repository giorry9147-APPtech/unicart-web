export function toFirestoreProduct(
  parsed: { title?: string; imageUrl?: string; price?: any; currency?: any },
  url: string
) {
  return {
    product_url: url,
    title: (parsed.title || "").toString(),
    image_url: (parsed.imageUrl || "").toString(),
    price: parsed.price ?? null,
    currency: parsed.currency ? String(parsed.currency) : null,
  };
}