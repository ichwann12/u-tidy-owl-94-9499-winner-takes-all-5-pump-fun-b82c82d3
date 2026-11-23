// Quiet-launch sniper for the make.fun "Winner Takes All — $5 Pump.fun Replay Sprint".
//
// What the dev data says (kit's frozen 24h window, 1,222 mints, 126,801 trades):
//  - Every coin's first trade is a buy. The price jumps off the create price within the
//    first 1-2 slots (median entry multiple ~1.3x by the time any bot can fill, 2 slots
//    after deciding), then most coins decay back toward the create price. The big move
//    happens before a bot can buy, so chasing it loses; the money is in being early,
//    being picky, and getting out fast.
//  - No coin ever trades below its create price in the window, so a buy near the launch
//    has a bounded downside, but the round trip still costs ~2.9% (1.25% curve fees each
//    way plus a flat 105,000-lamport tx fee per order), which is the whole game: the
//    strategy must win more often than the fee drag eats.
//  - Coins that run have loud launches (big creator buys, many early buyers) — but by
//    the time a bot fills, those have already spiked and they crash hardest afterwards.
//    The coins that lose least are the quiet ones: a few real buyers, a small creator
//    buy, real SOL already on the curve. So this bot buys only quiet launches, takes a
//    quick +10% when the launch pops, cuts at -8%, and never holds past 50 slots.
//
// Rules (all amounts in lamports, all comparisons in exact bigint math):
//  - One buy per coin, 0.03 SOL at most, and only when the 1% size cap lets at least
//    0.01 SOL through (so every round trip counts toward the 20-mint guardrail).
//  - Buy only within 10 slots of creation, only while the curve holds 2-30 SOL of real
//    reserves, only if the creator bought at most 1 SOL in the create slot, only if at
//    most 3 distinct non-creator buyers have bought, and never after the creator sold.
//  - Sell the whole position when its net value (sell proceeds after curve fees, less
//    one tx fee) is >= 110% of its basis (SOL spent plus tx fees paid), or <= 92% of
//    its basis, or 50 slots after the buy filled, or the creator sells after we bought.
//    No separate stale exit: with a 50-slot max hold, a coin that stops trading is sold
//    at 50 slots anyway, and an extra stale rule only adds exits at worse prices.
//  - Deterministic: a pure function of the batches. No clock, no environment, no
//    randomness, no network, no files. Two runs on the same data produce identical
//    action logs.

import { runBot, BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// --- strategy constants -------------------------------------------------------

const STAKE_LAMPORTS = 30_000_000n; // 0.03 SOL aimed per coin
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's minimum round trip
const MIN_REAL_SOL = 2_000_000_000n; // need >= 2 SOL of real reserves to buy
const MAX_REAL_SOL = 30_000_000_000n; // skip curves already holding > 30 SOL
const MAX_DEV_BUY = 1_000_000_000n; // creator buys in the create slot, at most 1 SOL
const MAX_BUYERS = 3; // at most 3 distinct non-creator buyers so far
const MAX_AGE_SLOTS = 10; // oldest a coin may be when the first buy is decided
const TAKE_PROFIT_BPS = 1_000n; // sell at +10% of basis
const STOP_LOSS_BPS = 800n; // sell at -8% of basis
const MAX_HOLD_SLOTS = 50; // never hold past 50 slots after the buy filled
const CURVE_FEE_BPS = 125n; // protocol 95 bps + creator 30 bps, charged on every fill

// --- curve math ---------------------------------------------------------------

// SOL received for selling `tokens` against virtual reserves (vq, vt), after the
// 1.25% curve fee. Mirrors the bonding curve: q = t*vq/(vt+t), fees rounded up.
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

// --- per-coin tape ------------------------------------------------------------

interface CoinTape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint; // creator buys in the create slot only
  buyers: Set<Pubkey>; // distinct non-creator buyers
  devSold: boolean; // creator sold at any point
  lastTradeSlot: number;
  buysSent: number; // 0 = never bought, 1 = bought (no retries, no adds)
  done: boolean; // never consider this coin for entry again
  complete: boolean; // its CompleteEvent arrived
}

interface OpenTrade {
  openedSlot: number; // slot the buy filled
  txPaid: bigint; // tx fees paid on this position's fills so far
  devSoldAtOpen: boolean; // whether the creator had already sold when we bought
}

const tapes = new Map<Pubkey, CoinTape>();
const openTrades = new Map<Pubkey, OpenTrade>();
const selling = new Set<Pubkey>(); // mints with a sell order in flight

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'buy') return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

// --- the bot ------------------------------------------------------------------

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // 1. Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          buyers: new Set(),
          devSold: false,
          lastTradeSlot: e.slot,
          buysSent: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const tape = tapes.get(e.mint);
        if (tape === undefined) continue;
        const sol = BigInt(e.sol_amount);
        tape.lastTradeSlot = e.slot;
        const isDev = e.user === tape.creator;
        if (e.is_buy) {
          if (isDev && e.slot === tape.createSlot) tape.devBuy += sol;
          else if (!isDev) tape.buyers.add(e.user);
        } else if (isDev) {
          tape.devSold = true;
        }
      } else {
        const tape = tapes.get(e.mint);
        if (tape !== undefined) {
          tape.complete = true;
          tape.done = true;
        }
      }
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // Latest reserves for the mints we hold or have pending, from this batch's marks.
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, {
        vq: BigInt(m.virtual_quote_reserves),
        vt: BigInt(m.virtual_token_reserves),
      });
    }

    // 2. Fold in the fills that resolved since the last batch.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is gone.
        openTrades.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const trade = openTrades.get(f.mint);
      if (f.status !== 'rejected' && trade !== undefined) {
        trade.txPaid += BigInt(f.tx_fee_lamports);
      }
      if (f.side === 'buy' && f.status === 'filled' && trade === undefined) {
        openTrades.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          devSoldAtOpen: tapes.get(f.mint)?.devSold ?? false,
        });
      }
    }
    for (const mint of [...selling]) {
      if (!hasPendingSell(state, mint)) selling.delete(mint);
    }
    for (const mint of [...openTrades.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
        openTrades.delete(mint);
      }
    }

    // 3. Exits: take profit, cut losses, age out, or leave when the creator sells.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders || selling.has(mint)) continue;
      const tape = tapes.get(mint);
      let trade = openTrades.get(mint);
      if (trade === undefined) {
        trade = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: tape?.devSold ?? false };
        openTrades.set(mint, trade);
      }
      let mark = marks.get(mint);
      if (mark === undefined) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        mark = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mark.vq, mark.vt) - tx;
      const basis = pos.cost_lamports + trade.txPaid;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + TAKE_PROFIT_BPS)) exit = true;
        if (value * BPS <= basis * (BPS - STOP_LOSS_BPS)) exit = true;
      }
      if (state.slot - trade.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (tape !== undefined && tape.devSold && !trade.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      if (tape !== undefined) tape.done = true;
    }

    // 4. Entries: quiet launches only, one small buy each, while slots are free.
    let free = state.freeCashLamports();
    let open = state.committedPositionCount();
    for (const tape of tapes.values()) {
      if (orders.length >= maxOrders) break;
      if (tape.done || tape.complete) continue;
      const age = state.slot - tape.createSlot;
      if (age > MAX_AGE_SLOTS) {
        tape.done = true;
        continue;
      }
      if (tape.buysSent > 0) continue;
      if (open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(tape.mint);
      if (curve === undefined || curve.complete) continue;
      if (tape.devSold) {
        tape.done = true;
        continue;
      }
      const realSol = curve.real_quote_reserves;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      if (tape.devBuy > MAX_DEV_BUY) {
        tape.done = true;
        continue;
      }
      if (tape.buyers.size > MAX_BUYERS) {
        tape.done = true;
        continue;
      }
      const cap = state.maxBuyLamports(tape.mint);
      const amount = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: tape.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      open += 1;
      tape.buysSent = 1;
    }

    return orders;
  },
});
