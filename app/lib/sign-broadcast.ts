import { signWithAppWallet } from "@/app/lib/privy-app-wallet";
import { decodeBase58Tx } from "@/app/lib/base58-tx";

type BroadcastResult = { ok: boolean; signature?: string; signatures?: string[]; error?: string };

type ActionLike = {
  type: string;
  transaction?: string;
  transactions?: string[];
  requestId?: string;
};

function isBase58Encoded(actionType: string): boolean {
  return actionType === "launchToken" || actionType === "claimFees";
}

function toBase64(tx: string, actionType: string): string {
  if (!isBase58Encoded(actionType)) return tx;
  return Buffer.from(decodeBase58Tx(tx)).toString("base64");
}

async function signAll(
  walletId: string,
  txs: string[],
  actionType: string
): Promise<string[]> {
  const signed: string[] = [];
  for (const tx of txs) {
    const base64 = toBase64(tx, actionType);
    signed.push(await signWithAppWallet({ walletId, transactionBase64: base64 }));
  }
  return signed;
}

async function postJson(internalBaseUrl: string, path: string, body: unknown) {
  const res = await fetch(new URL(path, internalBaseUrl.replace(/\/$/, "")), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Sign + broadcast any pending action using the app-owned Privy wallet. */
export async function signAndBroadcastAction(params: {
  walletId: string;
  action: ActionLike;
  internalBaseUrl: string;
}): Promise<BroadcastResult> {
  const { walletId, action, internalBaseUrl } = params;
  const type = action.type;

  const txs: string[] = action.transactions
    ? action.transactions
    : action.transaction
      ? [action.transaction]
      : [];
  if (txs.length === 0) {
    return { ok: false, error: "Action has no transaction(s) to sign" };
  }

  let signed: string[];
  try {
    signed = await signAll(walletId, txs, type);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Signing failed";
    return { ok: false, error: msg };
  }

  try {
    if (type === "swap") {
      if (!action.requestId) return { ok: false, error: "swap action missing requestId" };
      const r = await postJson(internalBaseUrl, "/api/swap/execute", {
        signedTransaction: signed[0],
        requestId: action.requestId,
      });
      const status = (r as { status?: string }).status;
      const sig = (r as { signature?: string }).signature;
      if (status === "Success" && sig) return { ok: true, signature: sig };
      return { ok: false, error: (r as { error?: string }).error || status || "Broadcast failed" };
    }

    if (type === "predictionOrder" || type === "sellPrediction" || type === "claimPrediction") {
      const r = await postJson(internalBaseUrl, "/api/prediction/execute", {
        signedTransaction: signed[0],
      });
      const status = (r as { status?: string }).status;
      const sig = (r as { signature?: string }).signature;
      if (status === "Success" && sig) return { ok: true, signature: sig };
      return { ok: false, error: (r as { error?: string }).error || status || "Broadcast failed" };
    }

    // Default: meteora/execute path (transfer, addLiquidity, removeLiquidity, launchToken, claimFees, buyNFT, listNFT)
    const r = await postJson(internalBaseUrl, "/api/meteora/execute", {
      signedTransactions: signed,
    });
    const status = (r as { status?: string }).status;
    const sigs = (r as { signatures?: string[] }).signatures;
    if (status === "Success" && sigs && sigs.length > 0) {
      return { ok: true, signature: sigs[0], signatures: sigs };
    }
    return { ok: false, error: (r as { error?: string }).error || status || "Broadcast failed" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Broadcast failed";
    return { ok: false, error: msg };
  }
}
