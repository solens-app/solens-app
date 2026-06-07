import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_RPC_BODY_BYTES = 256 * 1024;
const ALLOWED_RPC_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentBlockhash",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "simulateTransaction",
]);

function getRpcUrl(): string | null {
  return (
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    null
  );
}

function getRpcMethods(payload: unknown): string[] {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => {
    if (!item || typeof item !== "object") return "";
    const method = (item as { method?: unknown }).method;
    return typeof method === "string" ? method : "";
  });
}

export async function POST(request: Request) {
  const rpcUrl = getRpcUrl();
  if (!rpcUrl) {
    return NextResponse.json(
      { error: "SOLANA_RPC_URL is not configured." },
      { status: 500 }
    );
  }

  const body = await request.text();
  if (body.length > MAX_RPC_BODY_BYTES) {
    return NextResponse.json({ error: "RPC request too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON-RPC payload." }, { status: 400 });
  }

  const methods = getRpcMethods(payload);
  if (methods.length === 0 || methods.some((method) => !ALLOWED_RPC_METHODS.has(method))) {
    return NextResponse.json(
      { error: "RPC method is not allowed from the browser.", methods },
      { status: 403 }
    );
  }

  const upstream = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body,
    cache: "no-store",
  });

  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") || "application/json",
    },
  });
}
