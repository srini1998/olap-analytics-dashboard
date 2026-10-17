# Real-Time OLAP Dashboard

Repeated events must not rewrite past sales; conflicting batches must not partially commit.

Retry a receipt without double counting. Reject a conflicting ID and roll back all new rows; bind query filter values.

See [review](docs/review.md) and [actual checks](docs/test-results.txt) for data, validation and limitations.

```sh
python -m pytest tests -q
```

No production-readiness or independent model-quality guarantee is claimed.
