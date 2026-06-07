import crypto from "crypto";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

type PendingChallenge = {
  chatId: number;
  expiresAt: number;
  used: boolean;
  username?: string;
  firstName?: string;
};

export type TelegramLinkIdentity = {
  chatId: number;
  username?: string;
  firstName?: string;
};

const pendingChallenges = new Map<string, PendingChallenge>();
const latestChallengeNonceByChat = new Map<number, string>();
const verifiedWalletByChat = new Map<number, string>();
const privyUserByChat = new Map<number, string>();
let generatedLinkSecret: string | null = null;
let didWarnGeneratedLinkSecret = false;

function getGeneratedFallbackSecret(): string {
  if (!generatedLinkSecret) {
    generatedLinkSecret = crypto.randomBytes(32).toString("hex");
  }

  if (!didWarnGeneratedLinkSecret) {
    didWarnGeneratedLinkSecret = true;
    console.warn(
      "[telegram] No TELEGRAM_LINK_SECRET / TELEGRAM_LINK_SECRETS. Using an auto-generated in-memory secret for this process. Set one of them to keep links valid across restarts."
    );
  }

  return generatedLinkSecret!;
}

/** Secrets used to verify link tokens (any match). First entry signs newly issued tokens. */
function getLinkSecretsForVerify(): string[] {
  const multi = process.env.TELEGRAM_LINK_SECRETS?.trim();
  if (multi) {
    const parts = multi
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }
  const single = process.env.TELEGRAM_LINK_SECRET?.trim();
  if (single) return [single];
  return [getGeneratedFallbackSecret()];
}

function signPayload(payload: string): string {
  const secrets = getLinkSecretsForVerify();
  return crypto.createHmac("sha256", secrets[0]!).update(payload).digest("hex");
}

function verifyPayloadSignature(payload: string, sig: string): boolean {
  for (const secret of getLinkSecretsForVerify()) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    if (secureEqual(sig, expected)) return true;
  }
  return false;
}

function secureEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function createTelegramLinkToken(
  chatId: number,
  identity?: { username?: string; firstName?: string }
): {
  token: string;
  expiresAt: number;
  reused: boolean;
} {
  const username = identity?.username?.trim() || undefined;
  const firstName = identity?.firstName?.trim() || undefined;

  const existingNonce = latestChallengeNonceByChat.get(chatId);
  if (existingNonce) {
    const existing = pendingChallenges.get(existingNonce);
    if (existing && !existing.used && Date.now() < existing.expiresAt) {
      if (username) existing.username = username;
      if (firstName) existing.firstName = firstName;
      pendingChallenges.set(existingNonce, existing);
      const existingPayload = `${existingNonce}:${chatId}:${existing.expiresAt}`;
      const existingSig = signPayload(existingPayload);
      return {
        token: `${existingNonce}.${existing.expiresAt}.${existingSig}`,
        expiresAt: existing.expiresAt,
        reused: true,
      };
    }
  }

  const nonce = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const payload = `${nonce}:${chatId}:${expiresAt}`;
  const sig = signPayload(payload);
  pendingChallenges.set(nonce, { chatId, expiresAt, used: false, username, firstName });
  latestChallengeNonceByChat.set(chatId, nonce);
  return { token: `${nonce}.${expiresAt}.${sig}`, expiresAt, reused: false };
}

/**
 * Verify a link token's signature/expiry/nonce-state and return the bound
 * Telegram identity *without* consuming the token. The link confirmation UI
 * uses this to display which Telegram chat will be bound before the user
 * approves, so that a phished token cannot silently bind a victim's wallet
 * to an attacker's chat.
 */
export function peekTelegramLinkToken(token: string): TelegramLinkIdentity {
  const [nonce, expiresAtRaw, sig] = token.split(".");
  if (!nonce || !expiresAtRaw || !sig) {
    throw new Error("Invalid link token format");
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    throw new Error("Link token expired");
  }

  const challenge = pendingChallenges.get(nonce);
  if (!challenge) {
    throw new Error("Unknown link token");
  }

  if (challenge.used) {
    throw new Error("Link token already used");
  }

  if (Date.now() > challenge.expiresAt) {
    throw new Error("Link token expired");
  }

  const payload = `${nonce}:${challenge.chatId}:${expiresAt}`;
  if (!verifyPayloadSignature(payload, sig)) {
    throw new Error("Invalid token signature");
  }

  return {
    chatId: challenge.chatId,
    username: challenge.username,
    firstName: challenge.firstName,
  };
}

export function consumeTelegramLinkToken(token: string): { chatId: number } {
  const [nonce, expiresAtRaw, sig] = token.split(".");
  if (!nonce || !expiresAtRaw || !sig) {
    throw new Error("Invalid link token format");
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    throw new Error("Link token expired");
  }

  const challenge = pendingChallenges.get(nonce);
  if (!challenge) {
    throw new Error("Unknown link token");
  }

  if (challenge.used) {
    throw new Error("Link token already used");
  }

  if (Date.now() > challenge.expiresAt) {
    pendingChallenges.delete(nonce);
    throw new Error("Link token expired");
  }

  const payload = `${nonce}:${challenge.chatId}:${expiresAt}`;
  if (!verifyPayloadSignature(payload, sig)) {
    throw new Error("Invalid token signature");
  }

  challenge.used = true;
  pendingChallenges.set(nonce, challenge);

  return { chatId: challenge.chatId };
}

export function bindWalletToChat(
  chatId: number,
  walletAddress: string,
  privyUserId?: string | null
) {
  verifiedWalletByChat.set(chatId, walletAddress);
  if (privyUserId && privyUserId.trim().length > 0) {
    privyUserByChat.set(chatId, privyUserId.trim());
  }
  const nonce = latestChallengeNonceByChat.get(chatId);
  if (nonce) {
    pendingChallenges.delete(nonce);
    latestChallengeNonceByChat.delete(chatId);
  }
}

export function getLinkedWallet(chatId: number): string | null {
  return verifiedWalletByChat.get(chatId) ?? null;
}

export function getLinkedPrivyUser(chatId: number): string | null {
  return privyUserByChat.get(chatId) ?? null;
}

export function unlinkWallet(chatId: number) {
  verifiedWalletByChat.delete(chatId);
  privyUserByChat.delete(chatId);
}
