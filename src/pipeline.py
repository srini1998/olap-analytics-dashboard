"""
Real-Time OLAP Analytics Pipeline
-----------------------------------
Ingests streaming events → writes to star schema → 
powers sub-second aggregations via pre-computed window functions.

Star Schema:
  fact_events (event_id, user_id, product_id, ts, revenue, quantity)
  dim_users   (user_id, country, segment)
  dim_products(product_id, category, price)
"""
import sqlite3, json, time, random, math, threading
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

@dataclass
class Event:
    event_id: str
    user_id: str
    product_id: str
    event_type: str   # "purchase", "view", "cart_add"
    revenue: float
    quantity: int
    timestamp: str    # ISO format

@dataclass
class OLAPQuery:
    metric: str           # "revenue","orders","users","avg_order_value"
    group_by: str         # "country","category","segment","hour"
    time_window: str      # "last_hour","last_day","last_week"
    filters: Dict[str, Any] = field(default_factory=dict)

class OLAPPipeline:
    """
    Lightweight OLAP engine using SQLite with window functions.
    In production: replace SQLite with PostgreSQL + TimescaleDB.
    """
    def __init__(self, db_path: str = ":memory:"):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._create_schema()
        self._seed_dimensions()
        self.event_count = 0
        self.start_time = time.time()

    def _create_schema(self):
        cur = self.conn.cursor()
        cur.executescript("""
        CREATE TABLE IF NOT EXISTS fact_events (
            event_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            revenue REAL DEFAULT 0,
            quantity INTEGER DEFAULT 1,
            timestamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dim_users (
            user_id TEXT PRIMARY KEY,
            country TEXT,
            segment TEXT
        );
        CREATE TABLE IF NOT EXISTS dim_products (
            product_id TEXT PRIMARY KEY,
            category TEXT,
            price REAL
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON fact_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_user ON fact_events(user_id);
        CREATE INDEX IF NOT EXISTS idx_events_product ON fact_events(product_id);
        """)
        self.conn.commit()

    def _seed_dimensions(self):
        users = [(f"u{i}", random.choice(["US","UK","IN","CA","DE"]),
                  random.choice(["premium","standard","trial"])) for i in range(100)]
        products = [(f"p{i}", random.choice(["electronics","apparel","books","food","sports"]),
                     round(random.uniform(5, 500), 2)) for i in range(50)]
        cur = self.conn.cursor()
        cur.executemany("INSERT OR IGNORE INTO dim_users VALUES (?,?,?)", users)
        cur.executemany("INSERT OR IGNORE INTO dim_products VALUES (?,?,?)", products)
        self.conn.commit()

    def ingest_event(self, event: Event):
        self.ingest_batch([event])

    def ingest_batch(self, events: List[Event]):
        """Atomic immutable event receipts; exact retry is a no-op."""
        if len(events)>10000:
            raise ValueError("Batch exceeds 10,000 events")
        rows=[]
        for e in events:
            if not e.event_id or len(e.event_id)>200 or e.event_type not in {"purchase","view","cart_add"} or not math.isfinite(e.revenue) or e.revenue<0 or not isinstance(e.quantity,int) or e.quantity<0:
                raise ValueError("Invalid event")
            datetime.fromisoformat(e.timestamp)
            rows.append((e.event_id,e.user_id,e.product_id,e.event_type,e.revenue,e.quantity,e.timestamp))
        with self._lock, self.conn:
            inserted=0
            for row in rows:
                old=self.conn.execute("SELECT * FROM fact_events WHERE event_id=?",(row[0],)).fetchone()
                if old is not None:
                    if tuple(old)!=row:
                        raise ValueError("Conflicting replay for event_id")
                    continue
                self.conn.execute("INSERT INTO fact_events VALUES (?,?,?,?,?,?,?)",row)
                inserted+=1
        self.event_count+=inserted

    def _time_filter(self, window: str) -> str:
        now = datetime.utcnow()
        if window == "last_hour":
            cutoff = now - timedelta(hours=1)
        elif window == "last_day":
            cutoff = now - timedelta(days=1)
        elif window == "last_week":
            cutoff = now - timedelta(weeks=1)
        else:
            raise ValueError("Unsupported time window")
        return cutoff.isoformat()

    def query(self, q: OLAPQuery) -> List[Dict]:
        if q.metric not in {"revenue","orders","users","avg_order_value"} or q.group_by not in {"country","category","segment","hour","product_id","user_id","event_type"}:
            raise ValueError("Unsupported metric or group")
        if any(k not in {"user_id","product_id","event_type"} for k in q.filters):
            raise ValueError("Unsupported filter column")
        cutoff = self._time_filter(q.time_window)
        if q.group_by == "country":
            group_col = "du.country"
            join = "JOIN dim_users du ON f.user_id=du.user_id"
        elif q.group_by == "category":
            group_col = "dp.category"
            join = "JOIN dim_products dp ON f.product_id=dp.product_id"
        elif q.group_by == "segment":
            group_col = "du.segment"
            join = "JOIN dim_users du ON f.user_id=du.user_id"
        elif q.group_by == "hour":
            group_col = "strftime('%Y-%m-%d %H:00', f.timestamp)"
            join = ""
        else:
            group_col = f"f.{q.group_by}"
            join = ""

        if q.metric == "revenue":
            agg = "ROUND(SUM(f.revenue), 2)"
        elif q.metric == "orders":
            agg = "COUNT(f.event_id)"
        elif q.metric == "users":
            agg = "COUNT(DISTINCT f.user_id)"
        elif q.metric == "avg_order_value":
            agg = "ROUND(AVG(f.revenue), 2)"
        else:
            agg = "COUNT(*)"

        filter_clauses = ["f.timestamp >= ?", "f.event_type='purchase'"]
        parameters = [cutoff]
        for k, v in q.filters.items():
            filter_clauses.append(f"f.{k}=?")
            parameters.append(str(v))

        sql = f"""
        SELECT {group_col} AS dimension, {agg} AS value,
               COUNT(f.event_id) AS event_count,
               SUM(f.revenue) AS total_revenue
        FROM fact_events f {join}
        WHERE {' AND '.join(filter_clauses)}
        GROUP BY {group_col}
        ORDER BY value DESC
        LIMIT 20
        """
        rows = self.conn.execute(sql,parameters).fetchall()
        return [dict(row) for row in rows]

    def running_totals(self, hours: int = 24) -> List[Dict]:
        """Window function: cumulative revenue over the last N hours."""
        cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
        sql = """
        SELECT 
            strftime('%Y-%m-%d %H:00', timestamp) AS hour,
            SUM(revenue) AS hourly_revenue,
            SUM(SUM(revenue)) OVER (ORDER BY strftime('%Y-%m-%d %H:00', timestamp)) AS cumulative_revenue,
            COUNT(*) AS events
        FROM fact_events
        WHERE timestamp >= ? AND event_type='purchase'
        GROUP BY hour
        ORDER BY hour
        """
        rows = self.conn.execute(sql, (cutoff,)).fetchall()
        return [dict(row) for row in rows]

    def top_products(self, limit: int = 10) -> List[Dict]:
        sql = """
        SELECT f.product_id, dp.category,
               SUM(f.revenue) AS total_revenue,
               COUNT(f.event_id) AS orders,
               RANK() OVER (PARTITION BY dp.category ORDER BY SUM(f.revenue) DESC) AS rank_in_category
        FROM fact_events f
        JOIN dim_products dp ON f.product_id=dp.product_id
        WHERE f.event_type='purchase'
        GROUP BY f.product_id, dp.category
        ORDER BY total_revenue DESC LIMIT ?
        """
        rows = self.conn.execute(sql, (limit,)).fetchall()
        return [dict(row) for row in rows]

    def pipeline_stats(self) -> Dict:
        total = self.conn.execute("SELECT COUNT(*) FROM fact_events").fetchone()[0]
        revenue = self.conn.execute(
            "SELECT COALESCE(SUM(revenue),0) FROM fact_events WHERE event_type='purchase'"
        ).fetchone()[0]
        return {
            "total_events_ingested": self.event_count,
            "events_in_db": total,
            "total_revenue": round(revenue, 2),
            "uptime_seconds": round(time.time() - self.start_time, 1)
        }

def generate_sample_events(n: int = 100) -> List[Event]:
    """Generate synthetic e-commerce events for demo/testing."""
    rng = random.Random(42)
    base = datetime.utcnow() - timedelta(hours=48)
    events = []
    for i in range(n):
        ts = base + timedelta(minutes=rng.randint(0, 2880))
        events.append(Event(
            event_id=f"evt_{i:06d}",
            user_id=f"u{rng.randint(0,99)}",
            product_id=f"p{rng.randint(0,49)}",
            event_type=rng.choice(["purchase","purchase","purchase","view","cart_add"]),
            revenue=round(rng.uniform(5,300),2) if rng.random()>0.3 else 0,
            quantity=rng.randint(1,5),
            timestamp=ts.isoformat()
        ))
    return events
