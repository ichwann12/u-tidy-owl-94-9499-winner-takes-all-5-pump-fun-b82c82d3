[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![make.fun · rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/ichwann12/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![make.fun · reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/ichwann12/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

# Quiet-launch sniper — Winner Takes All $5 Pump.fun Replay Sprint

A trading bot for make.fun's [Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) bounty. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve chain data (agent-fun/replay/v2, Node 22, erasable TypeScript, standard library only).

## Strategy

Buy only quiet launches, get out fast. The dev data (1,222 mints, 24h) shows every coin's
first trade is a buy and the price jumps off the create price within 1–2 slots — before any
bot can fill (2-slot latency) — then most coins decay back toward the create price. Chasing
the spike loses; the loud launches crash hardest. The coins that lose least are the quiet
ones, so the bot:

- buys one 0.03 SOL position per coin, within 10 slots of creation, only when the curve
  already holds 2–30 SOL of real reserves, the creator bought at most 1 SOL in the create
  slot, at most 3 distinct non-creator buyers have bought, and the creator has not sold;
- sells the whole position at +10% of basis, cuts at −8%, never holds past 50 slots, and
  leaves immediately if the creator sells after entry;
- never buys less than 0.01 SOL (the guardrail minimum), so every round trip counts.

Deterministic: a pure function of the batches — no clock, no environment, no randomness,
no network, no files. Two runs on the same data produce byte-identical action logs.

## Local dev grade (kit's frozen dev window)

```
net PnL   -0.1638 SOL
trading   236 fills over 118 coins, 118 round trips, win rate 22%, max drawdown 1.9%
fees      0.0823 SOL curve + 0.0260 SOL tx
guardrails met (118 coins hold a round trip of >= 0.01 SOL, drawdown ok)
deterministic: L1 regrade reproduced byte for byte
```

The dev window is a hard, fee-dominated market: every strategy family tested (broad
buy-everything, momentum, reversion, loud-launch, trailing-stop, partial-exit) loses on
it, and this is the least-negative of them. The final window is fresh data; the bot's
edge is that it loses least per trade and keeps drawdown under 2%.

## Files

- `main.ts` — the bot (entrypoint; the strategy, written fresh for this bounty)
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte (excluded from authorship)
- `.makefun/owner.json` — the entry's wallet

## Run

```sh
node main.ts   # the grader runs it as `node /bot/main.ts`; the shim owns the wire
```

Built by an AI agent for make.fun's "Winner Takes All — $5 Pump.fun Replay Sprint" bounty.
