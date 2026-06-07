import { NextRequest, NextResponse } from "next/server";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  PrivyClient,
  isEmbeddedWalletLinkedAccount,
  type LinkedAccount,
  type LinkedAccountEmbeddedWallet,
  type User,
} from "@privy-io/node";
import { verifyPrivyAccessTokenFromRequest } from "@/app/lib/privy-auth";
import { getOrCreateAppWalletForUser } from "@/app/lib/privy-app-wallet";
import { createSolTransferTx } from "@/app/lib/transfer";

type LinkedAccountSolanaEmbedded = Extract<
  LinkedAccountEmbeddedWallet,
  { chain_type: "solana" }
>;

function isSolanaEmbeddedLinkedAccount(acc: LinkedAccount): acc is LinkedAccountSolanaEmbedded {
  return isEmbeddedWalletLinkedAccount(acc) && acc.chain_type === "solana";
}

let privyClient: PrivyClient | null = null;
function getPrivyClient(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("Privy not configured");
  if (!privyClient) privyClient = new PrivyClient({ appId, appSecret });
  return privyClient;
}

export async function POST(request: NextRequest) {
  let privyUserId: string;
  try {
    privyUserId = await verifyPrivyAccessTokenFromRequest(request);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "Unauthorized", detail }, { status: 401 });
  }

  try {
    const privy = getPrivyClient();
    const user: User = await privy.users()._get(privyUserId);
    const legacyAddresses = user.linked_accounts
      .filter(isSolanaEmbeddedLinkedAccount)
      .map((a) => a.address?.trim())
      .filter((a): a is string => Boolean(a));

    if (legacyAddresses.length === 0) {
      return NextResponse.json(
        { error: "No legacy user-owned Solana wallets found on this Privy user." },
        { status: 404 }
      );
    }

    const appWallet = await getOrCreateAppWalletForUser(privyUserId);
    const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
    const FEE_BUFFER_LAMPORTS = 5_000;

    type WalletQuote = {
      fromAddress: string;
      lamports: number;
      sol: number;
      transaction: string | null;
      reason?: string;
    };
    const quotes: WalletQuote[] = [];

    for (const fromAddress of legacyAddresses) {
      const balance = await connection.getBalance(new PublicKey(fromAddress));
      const drainable = balance - rentExempt - FEE_BUFFER_LAMPORTS;
      if (drainable <= 0) {
        quotes.push({
          fromAddress,
          lamports: 0,
          sol: balance / LAMPORTS_PER_SOL,
          transaction: null,
          reason:
            balance === 0
              ? "Empty"
              : "Balance below rent + fee floor; nothing to move.",
        });
        continue;
      }
      const built = await createSolTransferTx({
        fromWallet: fromAddress,
        toWallet: appWallet.address,
        lamports: drainable,
      });
      quotes.push({
        fromAddress,
        lamports: drainable,
        sol: drainable / LAMPORTS_PER_SOL,
        transaction: built.transaction,
      });
    }

    return NextResponse.json({
      destinationAddress: appWallet.address,
      quotes,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[legacy/drain-quote] failed", { privyUserId, detail });
    return NextResponse.json({ error: "Drain quote failed", detail }, { status: 500 });
  }
}
