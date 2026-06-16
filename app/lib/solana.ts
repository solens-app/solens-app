import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

const RPC_URL = process.env.SOLANA_RPC_URL!;

function getConnection() {
    return new Connection(RPC_URL, "confirmed");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a flaky RPC read a couple of times before giving up (public RPC is rate-limited). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            await sleep(300 * 2 ** i);
        }
    }
    throw lastErr;
}

export async function getSOLBalance(walletAddress: string) {
    const connection = getConnection();
    const pubkey = new PublicKey(walletAddress);
    const lamports = await withRetry(() => connection.getBalance(pubkey));
    const sol = lamports / LAMPORTS_PER_SOL;
    return { sol, lamports };
}

// On-chain decimals, cached for the process lifetime (decimals never change).
const decimalsCache = new Map<string, number>();

export async function getMintDecimals(mint: string): Promise<number> {
    const cached = decimalsCache.get(mint);
    if (cached !== undefined) return cached;

    const connection = getConnection();
    const mintPubkey = new PublicKey(mint);
    const accountInfo = await withRetry(() =>
        connection.getAccountInfo(mintPubkey),
    );
    if (!accountInfo) throw new Error(`Mint account not found: ${mint}`);
    const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
    const info = await withRetry(() =>
        getMint(connection, mintPubkey, undefined, programId),
    );
    decimalsCache.set(mint, info.decimals);
    return info.decimals;
}

// Reverse lookup: mint address → symbol
const KNOWN_SYMBOLS: Record<string, string> = {
    So11111111111111111111111111111111111111112: "SOL",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
    HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
    EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
    jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
    rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RNDR",
    JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: "JupUSD",
};

async function resolveSymbol(mint: string): Promise<string | null> {
    if (KNOWN_SYMBOLS[mint]) return KNOWN_SYMBOLS[mint];

    // Fallback: look up via Jupiter token search API
    try {
        const res = await fetch(`https://api.jup.ag/tokens/v2/token/${mint}`);
        if (res.ok) {
            const data = await res.json();
            if (data.symbol) return data.symbol;
        }
    } catch {
        // ignore
    }
    return null;
}

interface TokenInfo {
    mint: string;
    symbol: string | null;
    amount: number;
    amountString: string;
    decimals: number;
    address: string;
    /** Base units as string from RPC (exact balance). */
    rawAmount: string;
    /** Token program owning this mint (legacy SPL vs Token-2022). */
    programId: string;
}

async function fetchTokensForProgram(
    connection: Connection,
    owner: PublicKey,
    programId: PublicKey,
): Promise<TokenInfo[]> {
    try {
        const result = await withRetry(() =>
            connection.getParsedTokenAccountsByOwner(owner, {
                programId,
            }),
        );
        const nonZero = result.value
            .map((account) => {
                const info = account.account.data.parsed.info;
                const rawAmount = String(info.tokenAmount.amount);
                const amountString = String(
                    info.tokenAmount.uiAmountString ??
                        info.tokenAmount.uiAmount ??
                        "0",
                );
                return {
                    mint: info.mint as string,
                    amount: Number(amountString),
                    amountString,
                    decimals: info.tokenAmount.decimals as number,
                    address: account.pubkey.toBase58(),
                    rawAmount,
                    programId: programId.toBase58(),
                };
            })
            .filter((t) => BigInt(t.rawAmount) > BigInt(0));

        // Resolve symbols for all tokens
        const tokens: TokenInfo[] = await Promise.all(
            nonZero.map(async (t) => ({
                ...t,
                symbol: await resolveSymbol(t.mint),
            })),
        );

        return tokens;
    } catch (e) {
        console.error(
            `[solana] Token fetch failed for program ${programId.toBase58()}:`,
            e,
        );
        return [];
    }
}

export async function getTokenAccounts(walletAddress: string) {
    const connection = getConnection();
    const pubkey = new PublicKey(walletAddress);

    const [splTokens, token2022Tokens] = await Promise.all([
        fetchTokensForProgram(connection, pubkey, TOKEN_PROGRAM_ID),
        fetchTokensForProgram(connection, pubkey, TOKEN_2022_PROGRAM_ID),
    ]);

    return [...splTokens, ...token2022Tokens];
}

export async function getWalletOverview(walletAddress: string) {
    const [balance, tokens] = await Promise.all([
        getSOLBalance(walletAddress),
        getTokenAccounts(walletAddress),
    ]);

    return {
        address: walletAddress,
        solBalance: balance.sol,
        tokenCount: tokens.length,
        tokens,
    };
}
