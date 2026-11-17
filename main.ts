// Range Rider — a slow range-trading bot for the cbBTC/USDC 1-minute
// bars-replay (agent-fun/bars-replay/v1).
//
// The hello message hands us one symbol (CBBTC), 1,000 USDC of paper cash,
// the caps and the fees; then every batch carries one bar that just closed
// plus the fills of the orders we sent on the previous batch. We answer
// every batch with exactly one reply echoing its seq, carrying zero or one
// order. Orders decided on a batch fill at the next bar's open, so every
// decision here is made on closes we have already seen — no lookahead.
//
// Strategy (designed from the dev window's own behaviour, then checked for
// robustness on drifted and reshuffled copies of it):
//   * Keep a rolling window of the last 480 closes (8 hours). That is the
//     range the market has actually traded in: its low, its high, its span.
//   * Buy the bottom of the range: when the latest close sits in the bottom
//     15% of that span, spend all the cash on CBBTC. A dip that deep inside
//     an 8-hour range is where the window's big up-moves started.
//   * Sell the top of the range: when the latest close reaches the top 5%
//     of the span, sell the whole position. The window's rallies all rolled
//     over near the top of their range, and a round trip costs ~34 bps, so
//     the exit has to be near the extreme, not at the middle.
//   * Trailing stop as the safety net: once in a position, remember the
//     highest close since entry; sell everything if the close falls 80 bps
//     below that peak. That caps the damage when a dip keeps falling instead
//     of recovering, which is the one way this range logic loses.
//   * No trade at all until 480 closes have been seen. The first 8 hours
//     are for building the range, not for guessing in a narrow one.
//   * One position at a time, full size, at most one order per reply.
//     No randomness, no wall clock: every decision is a pure function of
//     the bars seen so far, so two runs produce byte-identical action logs.
//
// Why not the usual fast trend rules: on this window the 1-minute noise
// (about 6 bps per bar) whipsaws every short EMA cross and every breakout
// of a short lookback, and each whipsaw pays the full round-trip cost.
// The slow range is the only shape that survived: it made money in both
// halves of the dev window, under +300/-300 bps of added drift, and it
// keeps its maximum drawdown near 1%.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BARS = 480;
const BUY_BAND_PCT = 15; // buy when close is in the bottom 15% of the range
const SELL_BAND_PCT = 95; // sell when close is in the top 5% of the range
const TRAIL_BPS = 80; // trailing stop: 80 bps below the peak close since entry
const MAX_SLIPPAGE_BPS = 300; // max slippage vs the latest close, in bps
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units

// Closes seen so far, as plain numbers. A close is an integer price at
// price_scale 5 (about 6.4e9), far below 2^53, so every value here — and
// every product below, at most ~1e13 — is an exact integer in a JS number.
const closes: number[] = [];

// Highest close since the current position opened (0 while flat).
let peakClose = 0;

// Lowest and highest close of the last LOOKBACK_BARS closes, plus the span.
function rangeNow(): { lo: number; hi: number; span: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  const start = closes.length - LOOKBACK_BARS;
  for (let i = start; i < closes.length; i++) {
    const c = closes[i]!;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return { lo, hi, span: hi - lo };
}

// Decide the orders for one batch. The batch's bar (when CBBTC traded that
// minute) is folded into the close history first, so the range and the
// decision both use closes up to and including this bar — the same closes
// the harness has already sent us, never a future one.
function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return []; // a minute with no CBBTC bar: nothing new
  if (state.warmingUp) return []; // warm-up batches reject every order
  const close = Number(bar.c);
  closes.push(close);
  if (closes.length < LOOKBACK_BARS) return []; // still building the range

  const { lo, span } = rangeNow();
  if (span <= 0) return []; // a flat range has no bottom or top to trade
  const held = state.positions.get(SYMBOL)?.qty ?? 0n;

  if (held === 0n) {
    // Flat: buy the bottom of the range, all the cash we hold.
    // (close - lo) * 100 < span * BUY_BAND_PCT, in exact integers.
    if ((close - lo) * 100 < span * BUY_BAND_PCT && state.cash >= MIN_NOTIONAL) {
      peakClose = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // In a position: raise the peak, then check the two exits.
  if (close > peakClose) peakClose = close;
  // Top of the range: (close - lo) * 100 > span * SELL_BAND_PCT.
  const atTop = (close - lo) * 100 > span * SELL_BAND_PCT;
  // Trailing stop: close * 10000 < peakClose * (10000 - TRAIL_BPS).
  const stopped = close * 10000 < peakClose * (10000 - TRAIL_BPS);
  if (atTop || stopped) {
    return [{ side: 'sell', symbol: SYMBOL, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onBatch,
});
