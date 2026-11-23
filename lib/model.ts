// The token radar's value model: one sealed snapshot in, one ranked board out.
//
// The board ranks the protocols that record no token, strongest implied value
// first. It always covers the snapshot's whole watchlist — the floor, never a
// ceiling — and adds the early radar: pre-token protocols below the watchlist
// floor, strongest TVL first, up to EARLY_ROWS. Protocols that already trade
// are kept apart in the live set and shown at the market's own value, never
// mixed into the ranking.
//
// A protocol is pre-token when its index entry records no token at all: no
// market cap, no CoinGecko id, no symbol. Saying it "records no token" is
// the honest wording; the snapshot cannot prove a token does not exist, only
// that none is recorded.
//
// Implied value is computed only from the snapshot's own figures, in three
// steps:
//
//   base       = tvl_usd x BASE_MULTIPLE
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// BASE_MULTIPLE is derived at runtime, never hardcoded: it is the median
// market-cap-to-TVL ratio of the snapshot's own tokenized protocols at or
// above the watchlist floor (TVL >= $50M, not a CEX). On this snapshot that
// median is 0.082 over 47 protocols. The median is used instead of the mean
// because a few tokens are priced on something other than TVL — a prediction
// market at 400x, a CEX at 69x — and they would drag any mean far from what
// the market pays for a typical protocol's TVL. The 0.25 in MODEL is only the
// fallback a snapshot with no tokenized protocols at all would use.
//
// Farm plans are derived the same way, from each protocol's own record
// (category, main chain, TVL, age): no protocol name is ever special-cased,
// and the same function scores every row. The constants are the house
// model's, stated in the dashboard and changeable in the model sandbox.
//
// The parser refuses a snapshot it cannot score (parseSnapshot, with the
// validateProtocol / validateSnapshot helpers), so a truncated or hand-edited
// input fails with a named problem instead of a board that silently ranks
// the wrong rows.

/** One protocol entry from the snapshot: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document: the header, the protocol index, and the watchlist. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  // base_multiple is derived at runtime (derivedBaseMultiple); this value is only the fallback for a
  // snapshot with no tokenized protocols at all.
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One farm step: the action to take, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: a ranked protocol with its model inputs and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in its compact form for data.js; the farm plan is generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline figures of a board: watchlist size, board size, early rows, live rows. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Dates and small numeric helpers.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function finiteOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The millisecond timestamp of a `YYYY-MM-DD` date at midnight UTC, or NaN when it is not a date. */
function dayStartMs(dateText: string): number {
  return Date.parse(`${dateText}T00:00:00Z`);
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when the listing date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = dayStartMs(asOf);
  const listedMs = dayStartMs(listedAt);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

// ---------------------------------------------------------------------------
// The implied value: growth and maturity multipliers, then the product.
// ---------------------------------------------------------------------------

/** The seven-day change, clamped to the model's growth window, in per cent. */
function clampedGrowthPercent(rawChange: number, model: ModelConstants): number {
  return Math.min(model.growth_cap, Math.max(model.growth_floor, rawChange));
}

/** The growth multiplier for a clamped growth per cent: 1 plus the weighted change. */
function growthMultiplier(growthPct: number, model: ModelConstants): number {
  return 1 + (growthPct / 100) * model.growth_weight;
}

/** The maturity multiplier for a resolved age in days: the floor, plus the capped age share of the range. */
function maturityMultiplier(resolvedAgeDays: number, model: ModelConstants): number {
  const cappedAge = Math.min(Math.max(resolvedAgeDays, 0), model.maturity_days);
  return model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
}

/** The implied value from a TVL base and the two multipliers: at least $1, rounded to the dollar. */
function impliedFromMultipliers(base: number, growthMult: number, maturityMult: number): number {
  return Math.max(1, Math.round(base * growthMult * maturityMult));
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finiteOrFallback(protocol.change_7d, 0);
  const growthPct = clampedGrowthPercent(rawGrowth, model);
  const growthMult = growthMultiplier(growthPct, model);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = maturityMultiplier(ageForModel, model);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = impliedFromMultipliers(base, growthMult, maturityMult);
  return { implied, growthPct, growthMult, maturityMult, age };
}

// ---------------------------------------------------------------------------
// The base multiple: derived from the snapshot's own tokenized protocols.
// ---------------------------------------------------------------------------

/** The median of a list: the middle value, or the mean of the middle two. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Whether a protocol belongs in the peer set the base multiple is priced from: it already has a token
 * with a positive market cap, it holds positive TVL at or above the watchlist floor, and it is not a
 * CEX. A custodial exchange's TVL is user deposits it holds, not protocol value, and its token is
 * priced on the exchange's business, so its mcap/TVL is not the market's price for a DeFi protocol's
 * TVL. A protocol with no positive market cap is left out too: a zero or negative cap is a data quirk,
 * not a price.
 */
function isBaseMultiplePeer(p: SnapshotProtocol, floorUsd: number): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.tvl_usd >= floorUsd && p.category !== 'CEX';
}

/** The peer set: tokenized protocols on the same size tier as the protocols the board values. */
export function baseMultiplePeers(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => isBaseMultiplePeer(p, snapshot.floor_usd));
}

/** The market-cap-to-TVL ratio of every tokenized protocol with positive TVL, for the fallback. */
function tokenizedRatios(snapshot: Snapshot): number[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => (p.mcap_usd as number) / p.tvl_usd);
}

/**
 * The base multiple, derived from the snapshot at runtime: the median market-cap-to-TVL ratio of the
 * peer set. The median is used because the mean is dragged far from the typical protocol by a few
 * tokens priced on something other than TVL (on this snapshot the mean over the same peers is about
 * 0.98 while the median is 0.082). When the peer set is empty, fall back to the median over every
 * tokenized protocol, and when there is none at all, to the starter's 0.25.
 */
export function derivedBaseMultiple(snapshot: Snapshot): number {
  const peers = baseMultiplePeers(snapshot);
  if (peers.length > 0) return medianOf(peers.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const all = tokenizedRatios(snapshot);
  if (all.length > 0) return medianOf(all);
  return MODEL.base_multiple;
}

/**
 * The model the board actually runs: the caller's constants, with the base multiple replaced by the
 * snapshot's own derived value, so the board's implied values always follow from the input data.
 */
export function effectiveModel(snapshot: Snapshot, model: ModelConstants = MODEL): ModelConstants {
  return { ...model, base_multiple: derivedBaseMultiple(snapshot) };
}

// ---------------------------------------------------------------------------
// Pre-token and rankable: which protocols the board may rank.
// ---------------------------------------------------------------------------

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX_PATTERN = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSION_SUFFIX_PATTERN.test(p.name);
}

// ---------------------------------------------------------------------------
// Building the board: watchlist floor, early radar, scoring, ranking.
// ---------------------------------------------------------------------------

/** The snapshot's protocols indexed by slug, for the watchlist lookup. */
function indexProtocolsBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The watchlist as a map of protocols: every slug the snapshot carries. The watchlist is the floor,
 * so a slug the snapshot no longer carries simply cannot join the board — but the board's coverage is
 * the gate's row, and it is never gambled on a missing record.
 */
function collectWatchlistProtocols(snapshot: Snapshot, index: Map<string, SnapshotProtocol>): Map<string, SnapshotProtocol> {
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  return chosen;
}

/**
 * The early radar: pre-token protocols below the watchlist floor, strongest TVL first, capped at
 * EARLY_ROWS. Never a replacement for a watchlist row: a protocol already chosen stays chosen.
 */
function collectEarlyProtocols(snapshot: Snapshot, chosen: Map<string, SnapshotProtocol>): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
}

/** One protocol with the value the model gives it, before ranking. */
interface ScoredProtocol {
  p: SnapshotProtocol;
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
}

/** Score each chosen protocol under the effective model, keeping its multipliers for the row. */
function scoreProtocols(protocols: SnapshotProtocol[], asOf: string, effective: ModelConstants): ScoredProtocol[] {
  return protocols.map((p) => {
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, asOf, effective);
    return { p, implied, growthPct, growthMult, maturityMult, age };
  });
}

/** Rank the scored protocols: strongest implied value first, slug order breaking ties. */
function sortScoredByImplied(scored: ScoredProtocol[]): ScoredProtocol[] {
  return scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
}

/** A number rounded to four decimals, for the multipliers the board row carries. */
const roundToFourDecimals = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One scored protocol as a board row, with its rank, its model inputs, and its farm plan. */
function toBoardRow(s: ScoredProtocol, rank: number, baseMultiple: number): BoardRow {
  return {
    rank,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: baseMultiple,
      growth_pct: s.growthPct,
      growth_multiplier: roundToFourDecimals(s.growthMult),
      maturity_multiplier: roundToFourDecimals(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const effective = effectiveModel(snapshot, model);
  const index = indexProtocolsBySlug(snapshot.protocols);
  const chosen = collectWatchlistProtocols(snapshot, index);
  const early = collectEarlyProtocols(snapshot, chosen);
  for (const p of early) chosen.set(p.slug, p);
  const scored = sortScoredByImplied(scoreProtocols([...chosen.values()], snapshot.as_of, effective));
  return scored.map((s, i) => toBoardRow(s, i + 1, effective.base_multiple));
}

// ---------------------------------------------------------------------------
// Farm plans: six concrete steps per protocol, from its own record.
// ---------------------------------------------------------------------------

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function primaryChainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function farmCapitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function qualifyingHoldDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The category's one action, in the words a farmer can follow. Every branch names the protocol's
 * main chain, so the same category reads differently on a different chain. The branches are checked
 * in this order: a category that names two things takes the first matching action.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const categoryText = (p.category ?? '').toLowerCase();
  const protocolName = p.name;
  if (categoryText.includes('lend') || categoryText.includes('cdp') || categoryText.includes('collateral')) return `Supply $${capital} of USDC to ${protocolName} on ${chain} and keep the position open.`;
  if (categoryText.includes('dex') || categoryText.includes('yield') || categoryText.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${protocolName}'s main pool on ${chain} and keep the position open.`;
  if (categoryText.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${protocolName} and use the bridged funds in its app.`;
  if (categoryText.includes('staking') || categoryText.includes('restak')) return `Stake $${capital} of ${chain}'s staking asset through ${protocolName} and keep the receipt.`;
  if (categoryText.includes('perpetual') || categoryText.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${protocolName} on ${chain} and open one small hedge.`;
  if (categoryText.includes('prediction')) return `Fund $${capital} and place one market position on ${protocolName} on ${chain}.`;
  if (categoryText.includes('curator') || categoryText.includes('allocator')) return `Deposit $${capital} into a ${protocolName} vault on ${chain} and keep the shares.`;
  if (categoryText.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${protocolName} on ${chain}.`;
  if (categoryText.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (categoryText.includes('insurance')) return `Buy $${capital} of cover from ${protocolName} on ${chain} and keep the policy.`;
  if (categoryText.includes('basis') || categoryText.includes('trading')) return `Deposit $${capital} of USDC into ${protocolName}'s basis strategy on ${chain} and keep the position open.`;
  if (categoryText === 'chain') return `Bridge $${capital} of USDC onto ${protocolName} and use it in one of its apps.`;
  if (categoryText.includes('payment')) return `Send $${capital} through ${protocolName} on ${chain} and keep the receipt.`;
  if (categoryText.includes('governance')) return `Deposit $${capital} into ${protocolName} on ${chain} and vote on one proposal.`;
  return `Deposit $${capital} of USDC into ${protocolName} on ${chain} and keep the position open.`;
}

/**
 * One protocol-specific detail for the core farm step, from its own record: its TVL size and, when
 * reported, the direction of its seven-day TVL trend.
 */
function protocolDetailSentence(p: SnapshotProtocol): string {
  const tvlMillions = p.tvl_usd / 1_000_000;
  const tvlText = tvlMillions >= 1000 ? `$${(tvlMillions / 1000).toFixed(1)}B` : `$${Math.round(tvlMillions)}M`;
  const trend = p.change_7d;
  if (trend !== null && Math.abs(trend) >= 0.1) {
    const direction = trend > 0 ? 'up' : 'down';
    return `It holds ${tvlText} of TVL, ${direction} ${Math.abs(trend).toFixed(1)}% over the last 7 days`;
  }
  return `It holds ${tvlText} of TVL`;
}

/** Step one: start from a wallet that holds only the funds the farm will use. */
function freshWalletStep(): FarmStep {
  return {
    text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  };
}

/** Step two: the core position — the category's action, plus the protocol's own detail. */
function coreFarmStep(p: SnapshotProtocol, capital: number, chain: string): FarmStep {
  const action = actionFor(p, capital, chain);
  return {
    text: `${action} ${protocolDetailSentence(p)}.`,
    cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
    time: '15 minutes to set up',
  };
}

/** Step three: keep the position active with one qualifying action a week. */
function weeklyActionStep(): FarmStep {
  return {
    text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
    cost: 'about $2 of gas a week',
    time: '10 minutes a week',
  };
}

/** Step four: hold long enough that the activity lands in more than one snapshot. */
function holdPositionStep(capital: number, hold: number): FarmStep {
  return {
    text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
    cost: `the $${capital} stays in the position`,
    time: `${hold} days`,
  };
}

/** Step five: claim only from the link the protocol itself publishes. */
function claimStep(): FarmStep {
  return {
    text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
  };
}

/** Step six: write the farm down, so the position can be repeated or unwound. */
function farmLogStep(): FarmStep {
  return {
    text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  };
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChainOf(p);
  const capital = farmCapitalFor(p);
  const hold = qualifyingHoldDaysFor(age);
  return [
    freshWalletStep(),
    coreFarmStep(p, capital, chain),
    weeklyActionStep(),
    holdPositionStep(capital, hold),
    claimStep(),
    farmLogStep(),
  ];
}

// ---------------------------------------------------------------------------
// The live set: protocols that already trade, by market cap.
// ---------------------------------------------------------------------------

/** Live protocols sort by market cap first, then by TVL; equal pairs keep snapshot order. */
function compareLiveByMarketCap(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort(compareLiveByMarketCap)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

// ---------------------------------------------------------------------------
// The radar: board plus live set, as the dashboard renders it.
// ---------------------------------------------------------------------------

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** How many board rows are early radar: every row whose slug is not on the watchlist. */
function countEarlyRows(board: BoardRow[], watchlist: string[]): number {
  return board.filter((r) => !watchlist.includes(r.slug)).length;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const effective = effectiveModel(snapshot, model);
  const board = buildBoard(snapshot, effective);
  const live = liveRows(snapshot);
  const early = countEarlyRows(board, snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: effective,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------------------
// Parsing and validation: the snapshot out of a file's text, refused unless
// it is the shape the model scores.
// ---------------------------------------------------------------------------

/** The file's text as JSON, refused unless it parses. */
function parseSnapshotJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
}

/** The parsed JSON as the object the model reads, refused unless it is one. */
function requireSnapshotObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  return raw as Record<string, unknown>;
}

/** The snapshot's header: a dated as_of, a source, and a positive whole floor. */
function parseSnapshotHeader(o: Record<string, unknown>): { as_of: string; source: string; floor_usd: number } {
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd };
}

/** One protocol record, normalized to the ten fields the model scores on. */
function normalizeProtocolRecord(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/**
 * Check one protocol record carries the fields the model scores on: a non-empty slug, a non-empty
 * name, and a finite TVL. A record missing any of these cannot be ranked or looked up, so it fails
 * here with its index and slug instead of breaking the board later.
 */
export function validateProtocol(p: SnapshotProtocol, index: number): void {
  if (typeof p.slug !== 'string' || p.slug.length === 0) {
    throw new SnapshotError(`snapshot protocol ${index} has no slug`);
  }
  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new SnapshotError(`snapshot protocol ${index} (${p.slug}) has no name`);
  }
  if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot protocol ${index} (${p.slug}) has no finite tvl_usd`);
  }
}

/**
 * Check a parsed snapshot can produce a board: the protocol list is non-empty, every record is
 * sound, and every watchlist slug is a protocol the snapshot actually carries. The sealed snapshot
 * passes all three checks; a truncated or hand-edited input fails here with a named problem.
 */
export function validateSnapshot(snapshot: Snapshot): void {
  if (!Array.isArray(snapshot.protocols) || snapshot.protocols.length === 0) {
    throw new SnapshotError('snapshot has no protocols: expected a non-empty protocols array');
  }
  snapshot.protocols.forEach((p, i) => validateProtocol(p, i));
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const slug of snapshot.watchlist) {
    if (!known.has(slug)) {
      throw new SnapshotError(`snapshot watchlist slug ${slug} is not in the snapshot protocols`);
    }
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  const raw = parseSnapshotJson(text);
  const o = requireSnapshotObject(raw);
  const header = parseSnapshotHeader(o);
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => normalizeProtocolRecord(v, i));
  const snapshot: Snapshot = {
    as_of: header.as_of,
    source: header.source,
    floor_usd: header.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
  validateSnapshot(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// The board's own shape check: what the gate refuses, named.
// ---------------------------------------------------------------------------

/** The watchlist slugs the board does not cover. */
function missingWatchlistSlugs(board: BoardRow[], snapshot: Snapshot): string[] {
  const slugs = new Set(board.map((r) => r.slug));
  return snapshot.watchlist.filter((s) => !slugs.has(s));
}

/** The first rank that is not its position, or null when ranks run 1..n. */
function firstRankGap(board: BoardRow[]): string | null {
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  return null;
}

/** The first row that outranks the row above it on implied value, or null when the order holds. */
function firstImpliedOrderBreak(board: BoardRow[]): string | null {
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  return null;
}

/** The shared-value refusal, or null when the board actually ranks by value. */
function sharedImpliedValueMessage(board: BoardRow[]): string | null {
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  return null;
}

/** The first farm-step or implied-value problem on any row, or null when every row is sound. */
function firstFarmStepProblem(board: BoardRow[]): string | null {
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const missing = missingWatchlistSlugs(board, snapshot);
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const rankGap = firstRankGap(board);
  if (rankGap !== null) return rankGap;
  const orderBreak = firstImpliedOrderBreak(board);
  if (orderBreak !== null) return orderBreak;
  const shared = sharedImpliedValueMessage(board);
  if (shared !== null) return shared;
  return firstFarmStepProblem(board);
}

// ---------------------------------------------------------------------------
// The dashboard data: one script, no fetch, no network.
// ---------------------------------------------------------------------------

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
