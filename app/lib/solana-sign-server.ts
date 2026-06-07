import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";

/** Sign an unsigned Solana transaction (legacy or versioned) as base64 wire bytes. */
export function signUnsignedTxBase64(txBase64: string, signer: Keypair): string {
  const buf = Buffer.from(txBase64, "base64");
  try {
    const vtx = VersionedTransaction.deserialize(buf);
    vtx.sign([signer]);
    return Buffer.from(vtx.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(buf);
    legacy.partialSign(signer);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}
