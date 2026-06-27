import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__),'..','src'))
import pytest
from pipeline import OLAPPipeline, OLAPQuery, Event, generate_sample_events
from datetime import datetime

@pytest.fixture
def pipeline():
    p = OLAPPipeline(db_path=":memory:")
    events = generate_sample_events(200)
    p.ingest_batch(events)
    return p

class TestIngestion:
    def test_ingest_single_event(self):
        p = OLAPPipeline(":memory:")
        e = Event("e1","u1","p1","purchase",99.99,1,datetime.utcnow().isoformat())
        p.ingest_event(e)
        assert p.event_count == 1

    def test_ingest_batch(self):
        p = OLAPPipeline(":memory:")
        events = generate_sample_events(50)
        p.ingest_batch(events)
        assert p.event_count == 50

    def test_pipeline_stats_after_ingest(self, pipeline):
        stats = pipeline.pipeline_stats()
        assert stats["total_events_ingested"] == 200
        assert stats["total_revenue"] > 0

class TestQueries:
    def test_revenue_by_country(self, pipeline):
        result = pipeline.query(OLAPQuery("revenue","country","last_week"))
        assert isinstance(result, list)

    def test_orders_by_category(self, pipeline):
        result = pipeline.query(OLAPQuery("orders","category","last_week"))
        assert isinstance(result, list)

    def test_users_by_segment(self, pipeline):
        result = pipeline.query(OLAPQuery("users","segment","last_week"))
        assert isinstance(result, list)

    def test_result_has_dimension_and_value(self, pipeline):
        result = pipeline.query(OLAPQuery("revenue","country","last_week"))
        if result:
            assert "dimension" in result[0]
            assert "value" in result[0]

    def test_results_ordered_by_value_desc(self, pipeline):
        result = pipeline.query(OLAPQuery("revenue","country","last_week"))
        if len(result) >= 2:
            assert result[0]["value"] >= result[1]["value"]

class TestWindowFunctions:
    def test_running_totals_returns_list(self, pipeline):
        result = pipeline.running_totals(hours=48)
        assert isinstance(result, list)

    def test_running_totals_cumulative_increases(self, pipeline):
        result = pipeline.running_totals(hours=48)
        if len(result) >= 2:
            for i in range(1, len(result)):
                assert result[i]["cumulative_revenue"] >= result[i-1]["cumulative_revenue"]

    def test_top_products_returns_list(self, pipeline):
        result = pipeline.top_products(limit=5)
        assert len(result) <= 5

    def test_top_products_have_rank(self, pipeline):
        result = pipeline.top_products(limit=5)
        if result:
            assert "rank_in_category" in result[0]

class TestEdgeCases:
    def test_empty_db_query_returns_empty(self):
        p = OLAPPipeline(":memory:")
        result = p.query(OLAPQuery("revenue","country","last_hour"))
        assert result == []

    def test_dedup_on_same_event_id(self):
        p = OLAPPipeline(":memory:")
        e = Event("dup","u1","p1","purchase",50.0,1,datetime.utcnow().isoformat())
        p.ingest_event(e); p.ingest_event(e)
        stats = p.pipeline_stats()
        assert stats["events_in_db"] == 1
