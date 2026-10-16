# Development documentation

This directory contains practical local-development runbooks, historical research evidence, and archived experiments. It is not the authority for production behavior unless a document explicitly links to the current architecture or production runbook.

## Current runbooks

- [Testing](testing.md)
- [Graphify local setup](graphify.md)
- [Local development database backup](local-database-backup.md)
- [Local network and mobile testing](local-network-mobile-testing.md)

## Research evidence

Research under [`research/`](research/) records calibration inputs, rejected alternatives, experimental results, and the evidence behind frozen decisions:

- [`research/breadth/`](research/breadth/)
- [`research/intraday-stress/`](research/intraday-stress/)
- [`research/participation/`](research/participation/)
- [`research/volatility/`](research/volatility/)

Research is historical evidence. It does not grant provider, publication, Signal, Market Regime policy, or trading authority. Current runtime definitions live in [`../architecture/`](../architecture/) and operating procedures live in [`../production/`](../production/).

## Archive

[`archive/provider-experiments/`](archive/provider-experiments/) preserves runnable or technically useful provider investigations whose conclusions predate later Tiingo integration. Archived experiments remain non-authoritative and must not be interpreted as fallback policy.

Generated research output should normally use ignored cache directories. Checked-in artifacts are retained only where they are part of the reviewed calibration evidence or are inputs to reproducible offline analysis.
