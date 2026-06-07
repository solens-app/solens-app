import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL!;

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

export async function getSystemAccountRentReserveLamports(): Promise<number> {
  const connection = getConnection();
  return connection.getMinimumBalanceForRentExemption(0);
}

function decimalStringToRawUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Amount must be a positive decimal number.");
  }
  const [intPartRaw, fracRaw = ""] = trimmed.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "") || "0";
  if (fracRaw.length > decimals && /[1-9]/.test(fracRaw.slice(decimals))) {
    throw new Error(`Amount has more than ${decimals} decimal places.`);
  }
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart + frac);
}

/** Convert a UI amount to exact base units. Prefer string input when preserving "send all" precision. */
export function uiAmountToRawUnits(amount: number | string, decimals: number): bigint {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Amount must be a positive finite number.");
    }
    return decimalStringToRawUnits(amount.toFixed(decimals), decimals);
  }
  return decimalStringToRawUnits(amount, decimals);
}

export async function createSolTransferTx(params: {
  fromWallet: string;
  toWallet: string;
  /** Exact lamports to transfer (recommended; avoids float rounding). */
  lamports: number;
}): Promise<{ transaction: string; lamports: number }> {
  const { fromWallet, toWallet, lamports } = params;
  if (!Number.isInteger(lamports) || lamports <= 0) {
    throw new Error("lamports must be a positive integer.");
  }

  const fromPubkey = new PublicKey(fromWallet);
  const toPubkey = new PublicKey(toWallet);

  const connection = getConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const tx = new Transaction({
    feePayer: fromPubkey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports,
    })
  );

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return { transaction: serialized.toString("base64"), lamports };
}

export async function createSplTransferTx(params: {
  ownerWallet: string;
  toWallet: string;
  mintAddress: string;
  amount?: number;
  amountBaseUnits?: bigint | string;
  sourceTokenAccount?: string;
}): Promise<{ transaction: string; amountBaseUnits: string; decimals: number }> {
  const { ownerWallet, toWallet, mintAddress, amount, sourceTokenAccount } = params;

  const owner = new PublicKey(ownerWallet);
  const recipient = new PublicKey(toWallet);
  const mint = new PublicKey(mintAddress);
  const connection = getConnection();

  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) throw new Error("Mint account not found.");
  const resolvedProgram = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mint, undefined, resolvedProgram);
  const decimals = mintInfo.decimals;

  const amountBaseUnits =
    params.amountBaseUnits !== undefined
      ? BigInt(params.amountBaseUnits)
      : amount !== undefined
        ? uiAmountToRawUnits(amount, decimals)
        : (() => {
            throw new Error("Amount is required.");
          })();

  if (amountBaseUnits <= BigInt(0)) {
    throw new Error("Amount is too small.");
  }

  const sourceAta = sourceTokenAccount
    ? new PublicKey(sourceTokenAccount)
    : getAssociatedTokenAddressSync(mint, owner, false, resolvedProgram);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false, resolvedProgram);
  const destinationAtaInfo = await connection.getAccountInfo(destinationAta);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  });

  if (!destinationAtaInfo) {
    const ownerLamports = await connection.getBalance(owner);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(165);
    const minForCreate = rentExempt + 15_000;
    if (ownerLamports < minForCreate) {
      throw new Error(
        `Recipient has no token account for this mint; creating it needs ~${(minForCreate / LAMPORTS_PER_SOL).toFixed(6)} SOL for rent + fees. Your wallet has ${(ownerLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL — deposit SOL first.`
      );
    }
    tx.add(
      createAssociatedTokenAccountInstruction(
        owner,
        destinationAta,
        recipient,
        mint,
        resolvedProgram
      )
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      owner,
      amountBaseUnits,
      decimals,
      [],
      resolvedProgram
    )
  );

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString("base64"),
    amountBaseUnits: amountBaseUnits.toString(),
    decimals,
  };
}
