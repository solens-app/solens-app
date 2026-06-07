import { PrivyClient } from "@privy-io/node";

let privyClient: PrivyClient | null = null;

function getPrivyServerClient(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("Privy server is not configured (NEXT_PUBLIC_PRIVY_APP_ID / PRIVY_APP_SECRET).");
  }
  if (!privyClient) {
    privyClient = new PrivyClient({ appId, appSecret });
  }
  return privyClient;
}

/** Verify a Privy access token from Authorization header or cookie. Returns the Privy user id. */
export async function verifyPrivyAccessTokenFromRequest(
  request: Request
): Promise<string> {
  const auth = request.headers.get("authorization");
  let token: string | null = null;
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) token = m[1].trim();
  }
  if (!token) {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const m = cookieHeader.match(/(?:^|;\s*)privy-token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) {
    throw new Error("Missing Privy access token");
  }

  const privy = getPrivyServerClient();
  const payload = await privy.utils().auth().verifyAccessToken(token);
  return payload.user_id;
}
