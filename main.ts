// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Strategy (original, from first principles + a latency-aware backtest over
// the dev window's 128,058 events and 1,222 coins):
//   Buy EARLY and only when the entry is smooth. A new coin first becomes
//   buyable when its real SOL reserve reaches 1 SOL, because the harness
//   caps each order at 1% of that reserve and a round trip only counts at
//   0.01 SOL or more. On that first buyable batch, buy a small starter
//   (0.05 SOL, capped at 1% of real reserve) — but only if the entry is
//   smooth, judged against the price of the coin's FIRST trade in the
//   batch the bot decides on (the trigger trade), not against the
//   batch-end marks: a mint often trades several times inside one slot,
//   and anchoring to the batch-end price lets spike-top entries through.
//   Two smooth-entry checks, both in exact bigint ratio math:
//   (1) the batch-end price must sit within 1% of the trigger trade's
//   price — the coin did not spike inside the deciding batch; (2) the
//   trigger price must sit within 5% of the price three trades earlier —
//   the coin did not spike into the trigger. The buy itself carries a 1%
//   slippage limit, so the harness also refuses the fill when the price
//   jumps more than 1% in the 2-slot latency between the batch the bot
//   decides on and the slot the order fills at. A coin whose buy is
//   refused, or that fails either smooth-entry check, is dropped for good:
//   one shot per mint, never a re-entry.
//   Then triage by velocity. Fifty slots after the position first shows,
//   count the trades since entry: fewer than 20 means the coin went quiet
//   after its first buyers, and quiet coins bleed out — sell. The coins
//   that stay busy keep a tight 3% trailing exit (sell when the price falls
//   3% from its peak since entry) and a 3000-slot maximum hold. No fixed
//   take-profit: the rare runners pay for the many small losers only if
//   the trailing stop lets them run, and the stop is what banks them.
//   At most 5 open positions, at most 3 entries per batch.
//   Deterministic: no clock, no environment, no Math.random — every decision
//   comes from the hello / batch / orders / slot stream the harness sends.
//   All price comparisons are exact bigint ratio math, never floats.
//
// Dev-window calibration: the backtest fires on ~175-220 coins (the
// smooth-entry filters skip the spikiest ~70% of first-buyable coins),
// wins ~21% of trades, mean about -1.5 mSOL per trade and about -0.27 SOL
// in total over the window — the least-bad robust region found after
// sweeping momentum entries, trailing stops, take-profits, time exits, dip
// buys, survivor filters, near-completion trades and pyramiding, all of
// which lose more on this window. The live leaderboard agrees the window
// is hard: only 2 of 7 scored entries are positive, the best at +0.076 SOL.
// The 20-mint minimum bar is cleared many times over, and the 50% drawdown
// guardrail is far away with 0.05 SOL starters and at most 5 open positions.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (from the latency-aware dev-window sweep) ----
const WITHIN_BATCH_NUM = 101n; // skip when batch-end price > trigger * 101/100
const WITHIN_BATCH_DEN = 100n;
const PRE_SPIKE_NUM = 105n; // skip when trigger rose >5% over 3 trades back
const PRE_SPIKE_DEN = 100n;
const TRAIL_NUM = 97n; // sell when price <= peak * 97/100
const TRAIL_DEN = 100n;
const MAX_HOLD_SLOTS = 3000; // slots after the position first shows
const TRIAGE_SLOTS = 50; // velocity check this many slots after entry
const TRIAGE_MIN_TRADES = 20; // fewer trades than this in the window: sell
const TARGET_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL per buy, before caps
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip minimum bar
const MAX_BUY_SLIPPAGE_BPS = 100; // 1%: the smooth-entry filter, post-batch
const MAX_SELL_SLIPPAGE_BPS = 2000; // 20%: when a dump starts, get out
const MAX_ENTRIES_PER_BATCH = 3;

interface Coin {
  /** True once a buy was decided on this mint, or it was skipped for good. */
  decided: boolean;
  /**
   * Post-trade prices from batches BEFORE the current one, oldest first,
   * kept to the last four. The entry checks read this history; the current
   * batch's trades are appended only after the entry scan, so the checks
   * always see the prices that came before the trigger trade.
   */
  recent: Array<{ q: bigint; t: bigint }>;
}

interface Open {
  /** Peak price since the position showed, as a ratio. */
  peakQ: bigint;
  peakT: bigint;
  /** Slot the position first appeared in state.positions. */
  entrySlot: number;
  /** Cumulative trade count on the coin when the position first showed. */
  tradesAtEntry: number;
  /** True once the velocity triage has run for this position. */
  triaged: boolean;
}

const coins = new Map<string, Coin>();
const open = new Map<string, Open>();

/** Compare price q1/t1 with q2/t2: -1, 0, 1. Exact bigint math, no floats. */
function cmpPrice(q1: bigint, t1: bigint, q2: bigint, t2: bigint): number {
  const a = q1 * t2;
  const b = q2 * t1;
  return a < b ? -1 : a > b ? 1 : 0;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // ---- fold this batch's events into per-coin records (history first) ----
    // A coin's price is its curve ratio. Only the coin record is created
    // here; the price history is appended after the entry scan below, so
    // the entry checks see the trades that came before this batch.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, { decided: false, recent: [] });
        }
      } else if (e.event === 'TradeEvent') {
        if (!coins.has(e.mint)) {
          // First sight through a trade (create missed): start the record.
          coins.set(e.mint, { decided: false, recent: [] });
        }
      }
    }

    const out: OrderInput[] = [];
    const pendingMints = new Set<string>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);

    // ---- exits first: velocity triage, trailing stop, max hold ----
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let rec = open.get(mint);
      const q = curve.virtual_quote_reserves;
      const t = curve.virtual_token_reserves;
      if (rec === undefined) {
        rec = {
          peakQ: q,
          peakT: t,
          entrySlot: state.slot,
          tradesAtEntry: curve.trades,
          triaged: false,
        };
        open.set(mint, rec);
      }
      // Peak is the best price seen while holding.
      if (cmpPrice(q, t, rec.peakQ, rec.peakT) > 0) {
        rec.peakQ = q;
        rec.peakT = t;
      }
      let sell = false;
      // Velocity triage: a coin that went quiet after its first buyers bleeds.
      if (!rec.triaged && state.slot - rec.entrySlot >= TRIAGE_SLOTS) {
        rec.triaged = true;
        if (curve.trades - rec.tradesAtEntry < TRIAGE_MIN_TRADES) sell = true;
      }
      // Sell when the price has fallen 3% from its peak, or the hold is stale.
      const fell = q * rec.peakT * TRAIL_DEN <= rec.peakQ * t * TRAIL_NUM;
      const stale = state.slot - rec.entrySlot > MAX_HOLD_SLOTS;
      if (sell || fell || stale) {
        out.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SELL_SLIPPAGE_BPS,
        });
        open.delete(mint);
      }
    }
    // Drop tracking for positions the harness closed (complete / flatten).
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) open.delete(mint);
    }

    // ---- entries: first buyable batch, only when the entry is smooth ----
    // The trigger trade is the mint's first trade in this batch (the loop
    // below sees each mint once, at its first event). Both smooth-entry
    // checks anchor to that trade's price, never to the batch-end marks.
    const maxOpen = state.hello.caps.max_open_positions;
    let buysThisBatch = 0;
    if (state.committedPositionCount() < maxOpen) {
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        if (seen.has(e.mint)) continue;
        seen.add(e.mint);
        const rec = coins.get(e.mint);
        const curve = state.curves.get(e.mint);
        if (rec === undefined || curve === undefined) continue;
        if (rec.decided || curve.complete) continue;
        if (state.positions.has(e.mint) || pendingMints.has(e.mint)) continue;
        // Buyable only once the 1% cap reaches the round-trip minimum:
        // real reserve >= 1 SOL. Not buyable yet: leave it undecided.
        const cap = state.maxBuyLamports(e.mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        // Trigger price: this trade's post-trade reserves.
        const tq = BigInt(e.virtual_quote_reserves);
        const tt = BigInt(e.virtual_token_reserves);
        // Check 1 — no spike inside the deciding batch: the batch-end price
        // (the marks) must sit within 1% of the trigger trade's price.
        const mq = curve.virtual_quote_reserves;
        const mt = curve.virtual_token_reserves;
        if (mq * tt * WITHIN_BATCH_DEN > tq * mt * WITHIN_BATCH_NUM) {
          rec.decided = true; // spiked inside the batch: drop for good
          continue;
        }
        // Check 2 — no spike into the trigger: the trigger price must sit
        // within 5% of the price three trades earlier (the history holds
        // the four trades before this batch; three back is index 1).
        const r = rec.recent;
        if (r.length >= 4) {
          const threeAgo = r[1];
          if (
            tq * threeAgo.t * PRE_SPIKE_DEN >
            threeAgo.q * tt * PRE_SPIKE_NUM
          ) {
            rec.decided = true; // spiked into the trigger: drop for good
            continue;
          }
        }
        // Capacity: the backtest takes a coin on its first buyable batch or
        // never — a coin bought later, after a slot frees up, is bought at
        // a worse price, so drop it for good instead of retrying it.
        if (buysThisBatch >= MAX_ENTRIES_PER_BATCH) {
          rec.decided = true;
          continue;
        }
        if (state.committedPositionCount() + buysThisBatch >= maxOpen) {
          rec.decided = true;
          continue;
        }
        // Size: small starter, capped by the harness's 1%-of-real-reserve
        // rule and by free cash; skip dust the minimum bar would not count.
        const free = state.freeCashLamports();
        let size = TARGET_BUY_LAMPORTS;
        if (size > cap) size = cap;
        const cashShare = free / 4n;
        if (size > cashShare) size = cashShare;
        if (size < MIN_BUY_LAMPORTS) continue;
        rec.decided = true;
        buysThisBatch++;
        out.push({
          side: 'buy',
          mint: e.mint,
          quote_lamports: size,
          max_slippage_bps: MAX_BUY_SLIPPAGE_BPS,
        });
      }
    }

    // ---- append this batch's trades to the per-coin price history ----
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const rec = coins.get(e.mint);
      if (rec === undefined) continue;
      rec.recent.push({
        q: BigInt(e.virtual_quote_reserves),
        t: BigInt(e.virtual_token_reserves),
      });
      if (rec.recent.length > 4) rec.recent.shift();
    }

    return out;
  },
});
