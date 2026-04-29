// Send push notifications via Expo's Push API.
// Docs: https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type ExpoPushMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
};

export type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<{
  ok: boolean;
  tickets: ExpoPushTicket[];
  error?: string;
}> {
  if (messages.length === 0) {
    return { ok: true, tickets: [] };
  }

  // Expo recommends batches of <=100. Our batches are tiny so a single call is fine.
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        tickets: [],
        error: `Expo push HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as { data?: ExpoPushTicket[] };
    return { ok: true, tickets: json.data ?? [] };
  } catch (e: any) {
    return { ok: false, tickets: [], error: e?.message || "Push send failed" };
  }
}

export function isValidExpoPushToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["))
  );
}
