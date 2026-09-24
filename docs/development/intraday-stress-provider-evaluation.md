# Intraday Stress V1 provider evaluation, September 2026

Research decision record. **Tiingo consolidated is the selected provider candidate
for the next production-integration design phase for market-state observation.**
This grants no production authority and does not select an execution-sensitive
pricing source. Captured prices are bounded research evidence, not ground truth.

| Full session | Tiingo WS SPY/RSP | Tiingo REST SPY/RSP | WS vs REST actionable raw states | WS vs Massive delayed actionable raw states |
|---|---:|---:|---:|---:|
| September 23, 2026 | 390/390 each | 390/390 each | 25/25 exact | 25/25 exact |
| September 24, 2026 | 390/390 each | 390/390 each | 25/25 exact | 25/25 exact |

The two sessions together provided 780/780 minutes per symbol and 50/50 exact
actionable raw-state agreement for Tiingo WS versus REST and WS versus the
Massive delayed reference. Massive is a delayed comparator, not truth. Alpaca
Free/IEX had excellent latency but materially sparse RSP continuity under the
strict 15/15 evidence rule. Twelve Data had better, still incomplete RSP
continuity; on September 24 it produced one adjacent first-target state
disagreement relative to Tiingo and Massive. The existing
[provider comparison](intraday-stress-provider-comparison.md) documents the
products, capture methods, and interpretation limits.

The offline [revision forensics](intraday-stress-provider-comparison.md#offline-tiingo-rest-revision-forensics)
found 1,422 broad Tiingo REST value changes across both sessions. It separated
1,397 post-close changes from 25 first-completion changes following initial
partial observations; there were no additional pre-close value evolutions in
these captures. Of the post-close changes, 1,369 were volume-only and 28 touched
price. The largest individual price change was 1.415 bps. First-completed versus
final-observed bars produced no actionable V1 component, raw-state, or
effective-state change. One RSP 15-minute close changed by $0.005 in the
nonactionable September 24 closing window. Final observed is only the last
version this experiment saw; it is not a provider finality guarantee.

Tiingo consolidated remains beta. Its WebSocket events carry derived reference
prices, not executed trades, and no volume. REST produces provider OHLCV. The
two streams and Massive may agree on stress states without matching every price.
Continue adverse and more volatile session validation opportunistically using
the preserved, isolated research harness. The next phase must design and
validate production integration separately before granting any authority.
