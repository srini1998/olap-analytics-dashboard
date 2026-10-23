import json, os, random, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import pytest
from race_stream import (RaceStream, build_events, drivers_from, load_snapshot, load_queries, event_time)

ROOT = os.path.join(os.path.dirname(__file__), '..')
GOLDEN = os.path.join(os.path.dirname(__file__), 'golden')
STREAM = os.path.join(ROOT, 'data', 'monza-2024.stream.json')
SNAP = load_snapshot()
EVENTS = build_events(SNAP)
DRIVERS = drivers_from(SNAP)


def stream(events=EVENTS):
    s = RaceStream(DRIVERS)
    for i in range(0, len(events), 50):
        s.ingest(events[i:i + 50])
    return s


def test_events_are_ordered_unique_and_complete():
    assert len({e['event_id'] for e in EVENTS}) == len(EVENTS)
    assert [event_time(e) for e in EVENTS] == sorted(event_time(e) for e in EVENTS)
    laps = [e for e in EVENTS if e['type'] == 'lap']
    assert len(laps) == sum(1 for l in SNAP['laps'] if l['lap_duration'] is not None)
    assert {e['type'] for e in EVENTS} == {'lap', 'pit', 'stint'}


def test_stream_file_is_current():
    data = {'source': SNAP['source'], 'license': SNAP['license'], 'session': SNAP['session'],
            'drivers': DRIVERS, 'result': SNAP['result'], 'events': EVENTS}
    if os.environ.get('UPDATE_GOLDEN') or not os.path.exists(STREAM):
        with open(STREAM, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
    assert json.load(open(STREAM)) == json.loads(json.dumps(data))


def test_laps_completed_match_official_classification():
    """Independent check against OpenF1's session_result: laps per driver and the podium order."""
    tower = stream().query('tower', as_of=10000)
    laps = {r['driver_number']: r['laps'] for r in tower}
    for r in SNAP['result']:
        assert laps[r['driver_number']] == r['number_of_laps']
    official = [r['driver_number'] for r in sorted(SNAP['result'], key=lambda r: r['position'] or 99)]
    assert [r['driver_number'] for r in tower][:8] == official[:8]
    # timing-derived winner margin is close to the official one (timing line vs classification)
    assert abs(tower[1]['gap'] - SNAP['result'][1]['gap_to_leader']) < 0.5


def test_exact_replay_is_noop_and_conflict_rolls_back_batch():
    s = stream()
    before = s.query('tower', as_of=10000)
    assert s.ingest(EVENTS[:100]) == {'inserted': 0, 'duplicates': 100}
    bad = dict(EVENTS[-1], lap_s=EVENTS[-1]['lap_s'] + 1)
    fresh = RaceStream(DRIVERS)
    fresh.ingest(EVENTS[:-1])
    with pytest.raises(ValueError, match='Conflicting'):
        s.ingest([bad])
    with pytest.raises(ValueError):
        fresh.ingest([EVENTS[-1], dict(EVENTS[0], t=99.0)])  # new row + conflict: nothing commits
    assert fresh.conn.execute('SELECT COUNT(*) FROM fact_lap WHERE event_id=?', (EVENTS[-1]['event_id'],)).fetchone()[0] == 0
    assert s.query('tower', as_of=10000) == before
    assert s.stats['rejected_batches'] == 1


def test_out_of_order_delivery_gives_identical_answers():
    shuffled = EVENTS[:]
    random.Random(4).shuffle(shuffled)
    a, b = stream(), stream(shuffled)
    for name, params in [('tower', {}), ('degradation', {}), ('lapchart', {}), ('sectors', {})]:
        assert a.query(name, as_of=2500, **params) == b.query(name, as_of=2500, **params)


def test_as_of_time_travel_equals_partial_ingest():
    full = stream()
    partial = stream([e for e in EVENTS if event_time(e) <= 1500])
    for name in ('tower', 'rolling', 'lapchart', 'sectors', 'degradation'):
        assert full.query(name, as_of=1500) == partial.query(name, as_of=1500)


def test_no_future_leak_into_tyre_state():
    s = stream()
    # PIA's second stint starts after his first stop; before it, the tower shows the first set
    early = {r['code']: r for r in s.query('tower', as_of=600)}
    first = [e for e in EVENTS if e['type'] == 'stint' and e['driver_number'] == 81 and e['stint_number'] == 1][0]
    assert early['PIA']['compound'] == first['compound'] and early['PIA']['pits'] == 0


def test_rollups_and_windows():
    s = stream()
    by_compound = s.query('rollup', as_of=10000, grp='compound', lap_from=1, lap_to=53, clean_only=1)
    assert {r['dimension'] for r in by_compound} <= {'SOFT', 'MEDIUM', 'HARD'}
    all_laps = s.query('rollup', as_of=10000, grp='team', lap_from=1, lap_to=53, clean_only=0)
    assert sum(r['laps'] for r in all_laps) == len([e for e in EVENTS if e['type'] == 'lap'])
    windows = s.query('rollup', as_of=10000, grp='lap_window', lap_from=1, lap_to=53, clean_only=0)
    assert {r['dimension'] for r in windows} == {f'laps {i}–{i + 9}' for i in range(1, 52, 10)}
    rolling = s.query('rolling', as_of=10000)
    lec = [r for r in rolling if r['code'] == 'LEC']
    assert lec[4]['avg5'] == round(sum(r['lap_s'] for r in lec[:5]) / 5, 3)
    tumbling = s.query('tumbling', as_of=10000, width=10)
    assert {r['window_start'] for r in tumbling} == {1, 11, 21, 31, 41, 51}


def test_query_inputs_are_whitelisted_and_bound():
    s = stream()
    with pytest.raises(ValueError):
        s.query('rollup', as_of=1, grp="team'; DROP TABLE fact_lap;--", lap_from=1, lap_to=2, clean_only=0)
    with pytest.raises(ValueError):
        s.query('tower')
    with pytest.raises(ValueError):
        s.query('nope', as_of=1)
    with pytest.raises(ValueError):
        s.ingest([{'type': 'lap', 'event_id': 'x', 'driver_number': 1, 'lap_number': 1, 't_end': 1,
                   'lap_s': float('nan'), 'pit_out': 0}])
    assert s.conn.execute('SELECT COUNT(*) FROM fact_lap').fetchone()[0] > 0


GOLDEN_CASES = [
    ('tower', {'as_of': 600}), ('tower', {'as_of': 2400}), ('tower', {'as_of': 10000}),
    ('rollup', {'as_of': 3000, 'grp': 'driver', 'lap_from': 5, 'lap_to': 40, 'clean_only': 1}),
    ('rollup', {'as_of': 10000, 'grp': 'stint', 'lap_from': 1, 'lap_to': 53, 'clean_only': 1}),
    ('rollup', {'as_of': 10000, 'grp': 'compound', 'lap_from': 1, 'lap_to': 53, 'clean_only': 0}),
    ('rollup', {'as_of': 10000, 'grp': 'lap_window', 'lap_from': 1, 'lap_to': 53, 'clean_only': 1}),
    ('rolling', {'as_of': 2000}), ('degradation', {'as_of': 10000}), ('lapchart', {'as_of': 1200}),
    ('sectors', {'as_of': 4000}), ('tumbling', {'as_of': 10000, 'width': 5}),
]


def test_golden_query_outputs_are_current():
    s = stream()
    data = [{'query': n, 'params': p, 'rows': s.query(n, **p)} for n, p in GOLDEN_CASES]
    path = os.path.join(GOLDEN, 'race-queries.json')
    os.makedirs(GOLDEN, exist_ok=True)
    if os.environ.get('UPDATE_GOLDEN') or not os.path.exists(path):
        with open(path, 'w') as f:
            json.dump(data, f, indent=1)
    assert json.load(open(path)) == json.loads(json.dumps(data))


def test_query_file_parses():
    q = load_queries()
    assert set(q) == {'tower', 'rollup', 'rolling', 'degradation', 'lapchart', 'sectors', 'tumbling'}
    assert all('{{base}}' not in v['sql'] for v in q.values())
