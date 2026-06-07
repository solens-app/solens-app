import { PrivyClient } from "@privy-io/node";

let privyClient: PrivyClient | null = null;

function getPrivyServerClient(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET are required for Privy app wallets");
  }
  if (!privyClient) {
    privyClient = new PrivyClient({ appId, appSecret });
  }
  return privyClient;
}

function getAuthorizationPrivateKey(): string {
  const raw = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error("PRIVY_AUTHORIZATION_PRIVATE_KEY is required to sign app-owned wallets");
  }
  return raw
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

function getAuthorizationKeyQuorumId(): string {
  const raw = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID?.trim();
  if (!raw) {
    throw new Error(
      "PRIVY_AUTHORIZATION_KEY_QUORUM_ID is required (set to the authorization key id from Privy Dashboard, e.g. lsubnr77pcxe48fhng19slt5)"
    );
  }
  return raw;
}

/** Privy `external_id` is URL-safe ([a-zA-Z0-9_-], max 64). Strip the did:privy: prefix. */
function userIdToExternalId(privyUserId: string): string {
  return privyUserId.replace(/^did:privy:/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

const cache = new Map<string, { walletId: string; address: string }>();

export async function getOrCreateAppWalletForUser(
  privyUserId: string
): Promise<{ walletId: string; address: string }> {
  const cached = cache.get(privyUserId);
  if (cached) return cached;

  const privy = getPrivyServerClient();
  const externalId = userIdToExternalId(privyUserId);

  for await (const w of privy.wallets().list({ external_id: externalId, chain_type: "solana" })) {
    if (w.chain_type === "solana" && w.address) {
      const found = { walletId: w.id, address: w.address };
      cache.set(privyUserId, found);
      return found;
    }
  }

  const created = await privy.wallets().create({
    chain_type: "solana",
    owner_id: getAuthorizationKeyQuorumId(),
    external_id: externalId,
  });

  if (!created.address) {
    throw new Error("Privy wallet create returned no address");
  }
  const result = { walletId: created.id, address: created.address };
  cache.set(privyUserId, result);
  console.info("[privy-app-wallet] created", {
    privyUserId,
    walletId: result.walletId,
    address: result.address,
  });
  return result;
}

export async function signWithAppWallet(params: {
  walletId: string;
  transactionBase64: string;
}): Promise<string> {
  const privy = getPrivyServerClient();
  const authKey = getAuthorizationPrivateKey();
  const data = await privy.wallets().solana().signTransaction(params.walletId, {
    transaction: params.transactionBase64,
    authorization_context: { authorization_private_keys: [authKey] },
  });
  return data.signed_transaction;
}

export function isAppWalletConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() &&
      process.env.PRIVY_APP_SECRET?.trim() &&
      process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim() &&
      process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID?.trim()
  );
}
