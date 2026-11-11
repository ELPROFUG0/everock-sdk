import json
import sqlite3
import subprocess
import sys
import time
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.sdk.trace import TracerProvider
from everock import configure
from everock.journal import Journal


def wait_for(check):
    deadline = time.monotonic() + 5
    while not check():
        assert time.monotonic() < deadline
        time.sleep(.02)


def test_recovery_without_new_spans(tmp_path):
    received = []
    status = [503]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(status[0])
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    options = dict(public_key='pk_private_fixture', endpoint=f'http://127.0.0.1:{server.server_port}',
                   journal_directory=tmp_path, attempts=1)
    integration = None
    try:
        # Abrupt process death: no atexit hook and no graceful SDK shutdown.
        subprocess.run([sys.executable, '-c', """
import os, sys
from everock import configure
from opentelemetry.sdk.trace import TracerProvider
sdk = configure(provider=TracerProvider(), public_key='pk_private_fixture', endpoint=sys.argv[1],
                journal_directory=sys.argv[2], attempts=1)
with sdk.provider.get_tracer('test').start_as_current_span('durable'):
    pass
assert sdk.flush()
os._exit(0)
""", options['endpoint'], str(tmp_path)], timeout=10, check=True)
        with closing(sqlite3.connect(next(tmp_path.glob('*.sqlite3')))) as db:
            original = json.loads(db.execute('SELECT body FROM batches').fetchone()[0])
        assert all(b'pk_private_fixture' not in file.read_bytes() for file in tmp_path.iterdir())
        status[0] = 200
        integration = configure(provider=TracerProvider(), **options)
        wait_for(lambda: integration.exporter.diagnostics()['delivered'] == 1)
        assert received[-1] == original
        integration.shutdown()
        integration = configure(provider=TracerProvider(), **options)
        assert integration.exporter._journal.head()[1] is None
    finally:
        if integration:
            integration.shutdown()
        server.shutdown()
        thread.join()
        server.server_close()


def test_capacity_expiry_and_project_isolation(tmp_path):
    journal = Journal(tmp_path, 'first', 49152, 10)
    other = Journal(tmp_path, 'second', 49152, 10)
    assert journal.append(b'a' * 30000, 2) == 0
    assert journal.append(b'b' * 30000, 3) == 2
    assert other.head() == (0, None)
    with closing(journal.connect()) as db, db:
        db.execute('UPDATE batches SET created=0')
    assert journal.head() == (3, None)
