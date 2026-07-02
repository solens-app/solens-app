/**
 * Points / quests domain logic — Postgres (Neon) backed.
 *
 * EP is never fabricated: a quest only becomes claimable once the user has
 * genuinely satisfied it through real, recorded activity:
 *   - on-chain actions (verified on-chain before being recorded — see
 *     /api/points/event), stored in `activity_events`.
 *   - real interactions (wallet connect, first AI message).
 *   - referrals (a referred user is attributed to a referrer in `users`).
 *
 * Claiming a quest writes a row to `quest_claims`; a user's EP is the sum of
 * their claimed quests. The leaderboard reflects real users only.
 */

import { getSql } from "@/app/lib/db";

// ---------------------------------------------------------------------------
// Tiers & levels
// ---------------------------------------------------------------------------

export type Tier = { name: string; emoji: string; min: number };

export const TIERS: Tier[] = [
  { name: "Seeker", emoji: "🧭", min: 0 },
  { name: "Pathfinder", emoji: "✦", min: 16_000 },
  { name: "Alchemist", emoji: "⚗️", min: 40_000 },
  { name: "Sentinel", emoji: "🛡️", min: 80_000 },
  { name: "Arcanist", emoji: "🔮", min: 150_000 },
  { name: "Luminary", emoji: "🔱", min: 300_000 },
  { name: "Sovereign", emoji: "👑", min: 600_000 },
];

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical event types stored in `activity_events.type`.
 *
 * Prediction is split three ways on purpose: `prediction` means *placing* an
 * order (a bet), while closing a position (`prediction_sell`) and claiming a
 * payout (`prediction_claim`) are separate actions. Keeping them distinct stops
 * a single bet-then-sell from being counted as two prediction orders by the
 * PREDICT quests, while all three still count as generic on-chain activity.
 */
export type CanonicalEvent =
  | "swap"
  | "transfer"
  | "liquidity"
  | "token_launch"
  | "claim_fees"
  | "prediction"
  | "prediction_sell"
  | "prediction_claim"
  | "nft_buy"
  | "nft_list"
  | "ai_message"
  | "wallet_connect";

/** Action types as emitted by /api/chat → canonical event types. */
export const ACTION_EVENT_MAP: Record<string, CanonicalEvent> = {
  swap: "swap",
  transfer: "transfer",
  addLiquidity: "liquidity",
  removeLiquidity: "liquidity",
  launchToken: "token_launch",
  claimFees: "claim_fees",
  predictionOrder: "prediction",
  sellPrediction: "prediction_sell",
  claimPrediction: "prediction_claim",
  buyNFT: "nft_buy",
  listNFT: "nft_list",
};

/** Events that correspond to an on-chain transaction and MUST be verified. */
export const ONCHAIN_EVENTS = new Set<CanonicalEvent>([
  "swap",
  "transfer",
  "liquidity",
  "token_launch",
  "claim_fees",
  "prediction",
  "prediction_sell",
  "prediction_claim",
  "nft_buy",
  "nft_list",
]);

/** Interaction events with no signature (gated by auth, low value). */
export const INTERACTION_EVENTS = new Set<CanonicalEvent>(["ai_message", "wallet_connect"]);

export function canonicalEventType(actionOrEvent: string): CanonicalEvent | null {
  if (actionOrEvent in ACTION_EVENT_MAP) return ACTION_EVENT_MAP[actionOrEvent];
  if (
    actionOrEvent === "ai_message" ||
    actionOrEvent === "wallet_connect" ||
    (ONCHAIN_EVENTS as Set<string>).has(actionOrEvent)
  ) {
    return actionOrEvent as CanonicalEvent;
  }
  return null;
}

/** Human-readable labels for activity event types (used by the History page). */
export const EVENT_LABEL: Record<CanonicalEvent, string> = {
  swap: "Swap",
  transfer: "Transfer",
  liquidity: "Liquidity",
  token_launch: "Token Launch",
  claim_fees: "Claim Fees",
  prediction: "Prediction Order",
  prediction_sell: "Prediction Sell",
  prediction_claim: "Prediction Claim",
  nft_buy: "NFT Purchase",
  nft_list: "NFT Listing",
  ai_message: "AI Message",
  wallet_connect: "Wallet Connect",
};

// ---------------------------------------------------------------------------
// Quest catalog — every quest is backed by a real, measurable signal
// ---------------------------------------------------------------------------

export type QuestGroup =
  | "Daily Quests"
  | "Weekly Quests"
  | "Starter Quests"
  | "Referrer Quests"
  | "Protocol Explorer Quests";

export const QUEST_GROUPS: QuestGroup[] = [
  "Daily Quests",
  "Weekly Quests",
  "Starter Quests",
  "Referrer Quests",
  "Protocol Explorer Quests",
];

export type QuestReset = "once" | "daily" | "weekly";
export type QuestHighlight = "purple" | "green" | "plain";

/**
 * Requirement kinds:
 * - "event":       count of events matching `metric` within the reset window.
 * - "active_days": distinct UTC days with on-chain activity within the window.
 * - "referrals":   number of users this wallet has referred (all-time).
 * - "meta":        number of *other* quests in the same group claimed this period.
 */
export type QuestMetric = CanonicalEvent | "any_action";

export type QuestDef = {
  id: string;
  group: QuestGroup;
  reset: QuestReset;
  category: string;
  ep: number;
  title: string;
  desc: string;
  target: number;
  requirement:
    | { kind: "event"; metric: QuestMetric }
    | { kind: "active_days" }
    | { kind: "referrals" }
    | { kind: "meta" };
  highlight?: QuestHighlight;
};

export const QUEST_CATALOG: QuestDef[] = [
  // -- Daily ---------------------------------------------------------------
  { id: "daily-swap", group: "Daily Quests", reset: "daily", category: "SWAP", ep: 250, title: "Swap It Up", desc: "Complete a swap today", target: 1, requirement: { kind: "event", metric: "swap" }, highlight: "purple" },
  { id: "daily-active-3", group: "Daily Quests", reset: "daily", category: "ACTIVITY", ep: 500, title: "Triple Threat", desc: "Complete any 3 on-chain actions today", target: 3, requirement: { kind: "event", metric: "any_action" } },
  { id: "daily-transfer", group: "Daily Quests", reset: "daily", category: "TRANSFER", ep: 200, title: "Send It", desc: "Make a transfer today", target: 1, requirement: { kind: "event", metric: "transfer" }, highlight: "green" },
  { id: "daily-quickwin", group: "Daily Quests", reset: "daily", category: "BONUS", ep: 500, title: "Quick Win", desc: "Complete any 2 quests today", target: 2, requirement: { kind: "meta" }, highlight: "plain" },

  // -- Weekly --------------------------------------------------------------
  { id: "weekly-swaps-10", group: "Weekly Quests", reset: "weekly", category: "SWAP", ep: 2500, title: "Swap Streak", desc: "Complete 10 swaps this week", target: 10, requirement: { kind: "event", metric: "swap" } },
  { id: "weekly-active-5", group: "Weekly Quests", reset: "weekly", category: "STREAK", ep: 3000, title: "Daily Devotion", desc: "Be active on 5 different days this week", target: 5, requirement: { kind: "active_days" } },
  { id: "weekly-predictions-3", group: "Weekly Quests", reset: "weekly", category: "PREDICT", ep: 2000, title: "Crystal Ball", desc: "Place 3 prediction orders this week", target: 3, requirement: { kind: "event", metric: "prediction" } },

  // -- Starter -------------------------------------------------------------
  { id: "starter-connect", group: "Starter Quests", reset: "once", category: "SETUP", ep: 500, title: "First Steps", desc: "Connect your wallet to Solens", target: 1, requirement: { kind: "event", metric: "wallet_connect" }, highlight: "purple" },
  { id: "starter-swap", group: "Starter Quests", reset: "once", category: "SWAP", ep: 750, title: "Maiden Swap", desc: "Complete your very first swap", target: 1, requirement: { kind: "event", metric: "swap" }, highlight: "green" },
  { id: "starter-ai", group: "Starter Quests", reset: "once", category: "AI", ep: 400, title: "Say Hello", desc: "Send your first message to the Solens AI", target: 1, requirement: { kind: "event", metric: "ai_message" }, highlight: "plain" },

  // -- Referrer ------------------------------------------------------------
  { id: "ref-1", group: "Referrer Quests", reset: "once", category: "REFERRAL", ep: 500, title: "Spread the Word", desc: "Refer your first friend to Solens", target: 1, requirement: { kind: "referrals" } },
  { id: "ref-5", group: "Referrer Quests", reset: "once", category: "REFERRAL", ep: 1500, title: "Inner Circle", desc: "Refer 5 friends to Solens", target: 5, requirement: { kind: "referrals" } },
  { id: "ref-25", group: "Referrer Quests", reset: "once", category: "REFERRAL", ep: 7500, title: "Community Builder", desc: "Refer 25 friends to Solens", target: 25, requirement: { kind: "referrals" } },

  // -- Protocol Explorer ---------------------------------------------------
  { id: "explore-predict", group: "Protocol Explorer Quests", reset: "once", category: "PREDICT", ep: 1000, title: "Fortune Teller", desc: "Place your first prediction market order", target: 1, requirement: { kind: "event", metric: "prediction" }, highlight: "purple" },
  { id: "explore-lp", group: "Protocol Explorer Quests", reset: "once", category: "LIQUIDITY", ep: 1200, title: "Liquidity Pioneer", desc: "Add or remove liquidity on Meteora", target: 1, requirement: { kind: "event", metric: "liquidity" }, highlight: "green" },
  { id: "explore-nft", group: "Protocol Explorer Quests", reset: "once", category: "NFT", ep: 800, title: "Collector", desc: "Buy an NFT on Magic Eden via Solens", target: 1, requirement: { kind: "event", metric: "nft_buy" }, highlight: "plain" },
];

const QUEST_BY_ID = new Map(QUEST_CATALOG.map((q) => [q.id, q]));

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function utcWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${week}`;
}

function periodKeyFor(reset: QuestReset, now: Date): string {
  if (reset === "daily") return utcDayKey(now);
  if (reset === "weekly") return utcWeekKey(now);
  return "once";
}

function inWindow(ts: Date, reset: QuestReset, now: Date): boolean {
  if (reset === "once") return true;
  if (reset === "daily") return utcDayKey(ts) === utcDayKey(now);
  return utcWeekKey(ts) === utcWeekKey(now);
}

// ---------------------------------------------------------------------------
// Referral code
// ---------------------------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function deriveReferralCode(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let code = "";
  for (let i = 0; i < 7; i++) {
    code += BASE58[h % BASE58.length];
    h = Math.floor(h / BASE58.length) || ((h ^ ((i + 1) * 0x9e3779b1)) >>> 0);
  }
  return code.toUpperCase();
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "23505";
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

type UserRow = { wallet: string; referral_code: string; referred_by: string | null };
type EventRow = { type: CanonicalEvent; created_at: string };
type ClaimRow = { quest_id: string; period_key: string; ep: number; created_at: string };

/** Create the user row if missing (collision-safe referral code). Returns the row. */
export async function ensureUser(wallet: string, privyUserId?: string | null): Promise<UserRow> {
  const sql = getSql();
  const existing = (await sql`
    select wallet, referral_code, referred_by from users where wallet = ${wallet}
  `) as UserRow[];
  if (existing.length) {
    if (privyUserId) {
      await sql`update users set privy_user_id = ${privyUserId} where wallet = ${wallet} and privy_user_id is null`;
    }
    return existing[0];
  }

  for (let i = 0; i < 5; i++) {
    const code = deriveReferralCode(i === 0 ? wallet : `${wallet}:${i}`);
    try {
      const rows = (await sql`
        insert into users (wallet, privy_user_id, referral_code)
        values (${wallet}, ${privyUserId ?? null}, ${code})
        returning wallet, referral_code, referred_by
      `) as UserRow[];
      return rows[0];
    } catch (e) {
      // Concurrent insert of the same wallet, or a referral-code collision.
      const again = (await sql`
        select wallet, referral_code, referred_by from users where wallet = ${wallet}
      `) as UserRow[];
      if (again.length) return again[0];
      if (isUniqueViolation(e) && i < 4) continue;
      throw e;
    }
  }
  throw new Error("Could not create user");
}

async function loadUserData(wallet: string) {
  const sql = getSql();
  const [eventsR, claimsR, refR] = await Promise.all([
    sql`select type, created_at from activity_events where wallet = ${wallet}`,
    sql`select quest_id, period_key, ep, created_at from quest_claims where wallet = ${wallet}`,
    sql`select count(*)::int as n from users where referred_by = ${wallet}`,
  ]);
  const events = eventsR as unknown as EventRow[];
  const claims = claimsR as unknown as ClaimRow[];
  const refRows = refR as unknown as { n: number }[];
  return { events, claims, referrals: Number(refRows[0]?.n ?? 0) };
}

type LoadedData = Awaited<ReturnType<typeof loadUserData>>;

// ---------------------------------------------------------------------------
// Activity history (on-chain transactions only)
// ---------------------------------------------------------------------------

export type ActivityEntry = {
  id: string;
  type: CanonicalEvent;
  label: string;
  signature: string | null;
  ts: number;
};

/**
 * The wallet's on-chain transaction history, newest first. Only events that
 * correspond to a real, on-chain (and already-verified) transaction are
 * returned — interaction events like wallet_connect / ai_message are excluded.
 */
export async function getOnchainActivity(wallet: string): Promise<ActivityEntry[]> {
  if (!wallet) return [];
  const sql = getSql();
  const onchain = [...ONCHAIN_EVENTS];
  const rows = (await sql`
    select id, type, signature, created_at
    from activity_events
    where wallet = ${wallet} and type = any(${onchain})
    order by created_at desc
  `) as { id: number; type: CanonicalEvent; signature: string | null; created_at: string }[];

  return rows.map((r) => ({
    id: String(r.id),
    type: r.type,
    label: EVENT_LABEL[r.type] ?? r.type,
    signature: r.signature,
    ts: new Date(r.created_at).getTime(),
  }));
}

// ---------------------------------------------------------------------------
// Social feed — platform-wide recent on-chain activity
// ---------------------------------------------------------------------------

/** Trade summary stored in `activity_events.meta.trade` (see trade-meta.ts). */
export type FeedTrade = {
  token: { mint: string; symbol: string; logo: string | null };
  side: "buy" | "sell";
  amount: number;
  usd: number | null;
};

export type FeedEntry = {
  id: string;
  wallet: string;
  short: string;
  type: CanonicalEvent;
  label: string;
  signature: string | null;
  trade: FeedTrade | null;
  /** True once we've attempted to derive trade meta (so we don't retry forever). */
  tried: boolean;
  ts: number;
};

/** Narrow an unknown `meta.trade` blob into a FeedTrade, or null. */
function readTrade(meta: unknown): FeedTrade | null {
  if (!meta || typeof meta !== "object") return null;
  const trade = (meta as Record<string, unknown>).trade;
  if (!trade || typeof trade !== "object") return null;
  const t = trade as Record<string, unknown>;
  const token = t.token as Record<string, unknown> | undefined;
  if (!token || typeof token.mint !== "string" || typeof token.symbol !== "string") return null;
  if (t.side !== "buy" && t.side !== "sell") return null;
  return {
    token: {
      mint: token.mint,
      symbol: token.symbol,
      logo: typeof token.logo === "string" ? token.logo : null,
    },
    side: t.side,
    amount: typeof t.amount === "number" ? t.amount : 0,
    usd: typeof t.usd === "number" ? t.usd : null,
  };
}

/**
 * Recent on-chain activity across *all* wallets, newest first — the data behind
 * the social trade feed. Pass `before` (a millisecond timestamp) to page
 * backwards. Interaction events are excluded; only real, verified on-chain
 * actions surface. Returns an empty list rather than throwing if the DB is
 * unreachable is the caller's concern — this assumes a configured DB.
 */
export async function getRecentActivity(limit = 30, before?: number): Promise<FeedEntry[]> {
  const sql = getSql();
  const onchain = [...ONCHAIN_EVENTS];
  const cap = Math.min(Math.max(Math.floor(limit) || 30, 1), 100);

  const rows = (await (before && Number.isFinite(before)
    ? sql`
        select id, wallet, type, signature, meta, created_at
        from activity_events
        where type = any(${onchain}) and created_at < ${new Date(before).toISOString()}
        order by created_at desc
        limit ${cap}
      `
    : sql`
        select id, wallet, type, signature, meta, created_at
        from activity_events
        where type = any(${onchain})
        order by created_at desc
        limit ${cap}
      `)) as {
    id: number;
    wallet: string;
    type: CanonicalEvent;
    signature: string | null;
    meta: unknown;
    created_at: string;
  }[];

  return rows.map((r) => ({
    id: String(r.id),
    wallet: r.wallet,
    short: shortWallet(r.wallet),
    type: r.type,
    label: EVENT_LABEL[r.type] ?? r.type,
    signature: r.signature,
    trade: readTrade(r.meta),
    tried: Boolean(
      r.meta && typeof r.meta === "object" && (r.meta as Record<string, unknown>).tradeTried,
    ),
    ts: new Date(r.created_at).getTime(),
  }));
}

/**
 * Persist derived trade meta onto an existing event (feed back-fill). Always
 * marks the row as `tradeTried` so a tx that couldn't be parsed isn't retried
 * on every feed poll. Merges into the existing meta rather than replacing it.
 */
export async function setEventTrade(id: string, trade: FeedTrade | null): Promise<void> {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return;
  const sql = getSql();
  const patch = trade ? { trade, tradeTried: true } : { tradeTried: true };
  await sql`
    update activity_events
    set meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    where id = ${numId}
  `;
}

// ---------------------------------------------------------------------------
// Requirement evaluation
// ---------------------------------------------------------------------------

function metricMatches(metric: QuestMetric, type: CanonicalEvent): boolean {
  if (metric === "any_action") return ONCHAIN_EVENTS.has(type);
  return type === metric;
}

/** Current progress value for a quest against the loaded data. */
function questProgress(quest: QuestDef, data: LoadedData, now: Date): number {
  const req = quest.requirement;
  if (req.kind === "referrals") return data.referrals;

  if (req.kind === "active_days") {
    const days = new Set<string>();
    for (const e of data.events) {
      if (!ONCHAIN_EVENTS.has(e.type)) continue;
      const ts = new Date(e.created_at);
      if (inWindow(ts, quest.reset, now)) days.add(utcDayKey(ts));
    }
    return days.size;
  }

  if (req.kind === "meta") {
    const period = periodKeyFor(quest.reset, now);
    return data.claims.filter((c) => {
      const def = QUEST_BY_ID.get(c.quest_id);
      return (
        def &&
        def.group === quest.group &&
        def.requirement.kind !== "meta" &&
        c.period_key === period
      );
    }).length;
  }

  // event
  return data.events.filter(
    (e) => metricMatches(req.metric, e.type) && inWindow(new Date(e.created_at), quest.reset, now),
  ).length;
}

function isClaimed(quest: QuestDef, data: LoadedData, now: Date): boolean {
  const period = periodKeyFor(quest.reset, now);
  return data.claims.some((c) => c.quest_id === quest.id && c.period_key === period);
}

// ---------------------------------------------------------------------------
// Public serializable state (shared with the client via `import type`)
// ---------------------------------------------------------------------------

export type QuestView = {
  id: string;
  group: QuestGroup;
  category: string;
  ep: number;
  title: string;
  desc: string;
  target: number;
  progress: number;
  completed: boolean;
  claimable: boolean;
  showBar: boolean;
  progressLabel: string;
  highlight?: QuestHighlight;
};

export type LevelView = {
  number: number;
  name: string;
  emoji: string;
  ep: number;
  floor: number;
  nextAt: number | null;
  percent: number;
  toNext: number;
};

export type TierView = { name: string; emoji: string; active: boolean; unlocked: boolean };
export type LeaderRow = { rank: number; wallet: string; short: string; ep: number; isYou: boolean };
export type HistoryEntry = { id: string; ts: number; label: string; ep: number };

export type PointsState = {
  wallet: string | null;
  ep: number;
  referralCode: string;
  referrals: number;
  level: LevelView;
  tiers: TierView[];
  quests: QuestView[];
  leaderboard: LeaderRow[];
  history: HistoryEntry[];
};

function shortWallet(w: string): string {
  return w.length > 8 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

function tierForEp(ep: number): number {
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) if (ep >= TIERS[i].min) index = i;
  return index;
}

function buildLevel(ep: number): LevelView {
  const index = tierForEp(ep);
  const tier = TIERS[index];
  const next = TIERS[index + 1] ?? null;
  const floor = tier.min;
  const nextAt = next ? next.min : null;
  const band = nextAt ? nextAt - floor : 0;
  const into = ep - floor;
  return {
    number: index + 1,
    name: tier.name,
    emoji: tier.emoji,
    ep,
    floor,
    nextAt,
    percent: band > 0 ? Math.min(100, Math.round((into / band) * 100)) : 100,
    toNext: nextAt ? Math.max(0, nextAt - ep) : 0,
  };
}

function progressLabel(quest: QuestDef, progress: number): string {
  switch (quest.requirement.kind) {
    case "referrals":
      return `${progress} / ${quest.target} referrals`;
    case "active_days":
      return `${progress} / ${quest.target} days`;
    case "meta":
      return `${progress} / ${quest.target} quests`;
    default:
      return `${progress} / ${quest.target}`;
  }
}

function buildQuestViews(data: LoadedData, now: Date): QuestView[] {
  return QUEST_CATALOG.map((q) => {
    const progress = questProgress(q, data, now);
    const completed = isClaimed(q, data, now);
    const claimable = !completed && progress >= q.target;
    return {
      id: q.id,
      group: q.group,
      category: q.category,
      ep: q.ep,
      title: q.title,
      desc: q.desc,
      target: q.target,
      progress: Math.min(progress, q.target),
      completed,
      claimable,
      showBar: q.target > 1,
      progressLabel: progressLabel(q, Math.min(progress, q.target)),
      highlight: q.highlight,
    };
  });
}

async function buildLeaderboard(wallet: string, myEp: number): Promise<LeaderRow[]> {
  const sql = getSql();
  const rows = (await sql`
    select u.wallet as wallet, coalesce(sum(qc.ep), 0)::int as ep
    from users u
    left join quest_claims qc on qc.wallet = u.wallet
    group by u.wallet
    having coalesce(sum(qc.ep), 0) > 0
    order by ep desc, min(u.created_at) asc
    limit 100
  `) as { wallet: string; ep: number }[];

  const list = rows.map((r) => ({ wallet: r.wallet, ep: Number(r.ep) }));
  // Guarantee the current wallet is present even with 0 EP, so users always see themselves.
  if (!list.some((r) => r.wallet === wallet)) list.push({ wallet, ep: myEp });
  list.sort((a, b) => b.ep - a.ep);

  return list.map((r, i) => ({
    rank: i + 1,
    wallet: r.wallet,
    short: shortWallet(r.wallet),
    ep: r.ep,
    isYou: r.wallet === wallet,
  }));
}

/**
 * Full points state for a wallet. `wallet` null → anonymous/zero state (the
 * catalog still renders so the page is usable before connecting).
 */
export async function getPointsState(wallet: string | null): Promise<PointsState> {
  const now = new Date();

  if (!wallet) {
    const data: LoadedData = { events: [], claims: [], referrals: 0 };
    return {
      wallet: null,
      ep: 0,
      referralCode: "",
      referrals: 0,
      level: buildLevel(0),
      tiers: TIERS.map((t, i) => ({ name: t.name, emoji: t.emoji, active: i === 0, unlocked: i === 0 })),
      quests: buildQuestViews(data, now),
      leaderboard: [],
      history: [],
    };
  }

  const user = await ensureUser(wallet);
  const data = await loadUserData(wallet);
  const ep = data.claims.reduce((sum, c) => sum + Number(c.ep), 0);
  const activeIndex = tierForEp(ep);

  return {
    wallet: user.wallet,
    ep,
    referralCode: user.referral_code,
    referrals: data.referrals,
    level: buildLevel(ep),
    tiers: TIERS.map((t, i) => ({
      name: t.name,
      emoji: t.emoji,
      active: i === activeIndex,
      unlocked: i <= activeIndex,
    })),
    quests: buildQuestViews(data, now),
    leaderboard: await buildLeaderboard(wallet, ep),
    history: data.claims
      .map((c) => ({
        id: `${c.quest_id}-${c.period_key}`,
        ts: new Date(c.created_at).getTime(),
        label: QUEST_BY_ID.get(c.quest_id)?.title ?? c.quest_id,
        ep: Number(c.ep),
      }))
      .sort((a, b) => b.ts - a.ts),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type RecordEventResult = { recorded: boolean; duplicate: boolean };

/**
 * Record a verified activity event. `dedupeKey` makes inserts idempotent
 * (on-chain events key on the tx signature; once-only interactions key on the
 * wallet). Callers MUST verify on-chain events before calling this.
 */
export async function recordEvent(params: {
  wallet: string;
  type: CanonicalEvent;
  dedupeKey: string;
  signature?: string | null;
  meta?: Record<string, unknown>;
}): Promise<RecordEventResult> {
  await ensureUser(params.wallet);
  const sql = getSql();
  const rows = (await sql`
    insert into activity_events (wallet, type, signature, dedupe_key, meta)
    values (${params.wallet}, ${params.type}, ${params.signature ?? null}, ${params.dedupeKey}, ${JSON.stringify(params.meta ?? {})}::jsonb)
    on conflict (dedupe_key) do nothing
    returning id
  `) as { id: number }[];
  return { recorded: rows.length > 0, duplicate: rows.length === 0 };
}

export type ClaimResult =
  | { ok: true; awarded: number; state: PointsState }
  | { ok: false; reason: "unknown_quest" | "not_ready" | "already_claimed"; state: PointsState };

/** Claim a quest's EP. Awards only if the real requirement is met; idempotent per period. */
export async function claimQuest(wallet: string, questId: string): Promise<ClaimResult> {
  const quest = QUEST_BY_ID.get(questId);
  if (!quest) return { ok: false, reason: "unknown_quest", state: await getPointsState(wallet) };

  const now = new Date();
  await ensureUser(wallet);
  const data = await loadUserData(wallet);

  if (isClaimed(quest, data, now)) {
    return { ok: false, reason: "already_claimed", state: await getPointsState(wallet) };
  }
  if (questProgress(quest, data, now) < quest.target) {
    return { ok: false, reason: "not_ready", state: await getPointsState(wallet) };
  }

  const sql = getSql();
  const period = periodKeyFor(quest.reset, now);
  const inserted = (await sql`
    insert into quest_claims (wallet, quest_id, period_key, ep)
    values (${wallet}, ${quest.id}, ${period}, ${quest.ep})
    on conflict (wallet, quest_id, period_key) do nothing
    returning id
  `) as { id: number }[];

  if (inserted.length === 0) {
    return { ok: false, reason: "already_claimed", state: await getPointsState(wallet) };
  }
  return { ok: true, awarded: quest.ep, state: await getPointsState(wallet) };
}

export type ReferralResult =
  | { ok: true }
  | { ok: false; reason: "no_such_code" | "self" | "already_referred" | "no_wallet" };

/** Attribute `wallet` to the referrer that owns `code`. One-time, never self. */
export async function attributeReferral(wallet: string, code: string): Promise<ReferralResult> {
  if (!wallet) return { ok: false, reason: "no_wallet" };
  const sql = getSql();
  await ensureUser(wallet);

  const normalized = code.trim().toUpperCase();
  const refRows = (await sql`select wallet from users where referral_code = ${normalized}`) as {
    wallet: string;
  }[];
  if (!refRows.length) return { ok: false, reason: "no_such_code" };

  const referrer = refRows[0].wallet;
  if (referrer === wallet) return { ok: false, reason: "self" };

  const updated = (await sql`
    update users set referred_by = ${referrer}
    where wallet = ${wallet} and referred_by is null
    returning wallet
  `) as { wallet: string }[];

  return updated.length ? { ok: true } : { ok: false, reason: "already_referred" };
}
