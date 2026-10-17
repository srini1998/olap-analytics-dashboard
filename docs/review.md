# Engineering review / October 17, 2026

## problem
Repeated events must not rewrite past sales; conflicting batches must not partially commit.

## example
Retry a receipt without double counting. Reject a conflicting ID and roll back all new rows; bind query filter values.

## dataSource
Authored commerce events in SQLite, not a live PostgreSQL feed.

## verification
16 passing checks include SQL injection rejection, immutable receipts, batch rollback and running totals.

## limitations
Supported grouped/windowed SQLite queries. Prior percentile/sliding-window/PostgreSQL claims did not match the code and were removed.

## Reproduce
Python 3.12, free project requirements and pytest: `python -m pytest tests -q`. Actual output: docs/test-results.txt. No paid API calls used. Optional local generation needs Ollama/qwen2.5:3b.
