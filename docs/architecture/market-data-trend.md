# Market data and Trend calibration

## Authority and evidence

Massive is the market-data authority. Alpaca remains the brokerage, account and
execution authority. There is no Alpaca fallback in market-data ingestion or Trend.
MarketBar records unadjusted provider OHLCV as first accepted after completion.
Database triggers reject updates/deletes; overlap inserts do nothing. There is no
automatic historical comparison, correction or revision process. Closed intervals
can still receive late vendor corrections: accepted observations are not a claim
that the vendor will never subsequently change its history.

MarketCalendarException is small mutable operator configuration. Weekends are
closed; normal sessions are 09:30–16:00 America/New_York. Operators maintain holiday
closures and early closes using https://www.nyse.com/trade/hours-calendars.
There is no automatic holiday import. Daily eligibility begins 30 minutes after
the expected close; regular-session 15-minute eligibility begins five minutes
after interval end. These are code constants, not editable settings.

Historical backfill accepts valid returned daily observations without demanding
decades of manual holiday entries. Current operational gaps use the maintained
calendar. A closed session, an interval not yet eligible and an eligible missing
bar are distinct. Missing bars are never synthesized.

## Assessment foundation

MarketRegimeDimensionAssessment is an immutable terminal evidence contract.
It has six dimension names, but only Trend's UP/NEUTRAL/DOWN vocabulary is defined.
UNAVAILABLE/FAILED rows have null states; missing data is never NEUTRAL. Attempts
are unique per dimension/version/target/attempt, and at most one VALID result may
exist per dimension/version/target. A previous assessment must share dimension and
algorithm version. Research profiles never insert into this table.

## Calibration boundary

Trend is daily, based on SPY and RSP confirmation. Calibration runs three frozen
research candidates (TIGHT, MIDDLE, LOOSE), never an authoritative TREND_V1.
The pure calculator consumes split-normalized data. Split events come from Massive
as bounded research inputs and are returned in lab evidence, without a corporate
action table. Raw MarketBars remain unadjusted.

Hysteresis steps one state immediately on deterioration and requires two supporting
valid sessions per recovery step. Missing sessions pause confirmation. Each
independent candidate rebuilds its own state. Future intraday refreshes cannot
advance daily hysteresis.

CurrentMarketState and Market Diary retain their narrative/n8n purpose. There is
no Market Regime trading gate, strategy policy, overall regime calculation or
execution integration. Next: operator review of the Trend Lab and selection of
one profile. Only after that review will selected thresholds be frozen under a
production identifier such as TREND_V1 and immutable assessments be published.
