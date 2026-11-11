"""Size- and age-limited retry journal. Contains sanitized batches, never keys."""
import hashlib
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path


class Journal:
    def __init__(self, directory, identity, max_bytes, ttl_seconds):
        root = Path(directory)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name == 'posix' and root.stat().st_mode & 0o077:
            raise ValueError('journal_directory must be private (chmod 700)')
        self.path = root / (hashlib.sha256(identity.encode()).hexdigest() + '.sqlite3')
        self.max_bytes = max(49152, min(int(max_bytes), 64 * 1024 * 1024))
        self.ttl = max(1, min(int(ttl_seconds), 7 * 86400))
        with closing(self.connect()) as db:
            db.execute('CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL NOT NULL, body BLOB NOT NULL, n INTEGER NOT NULL)')

    def connect(self):
        return sqlite3.connect(self.path, timeout=1)

    def append(self, body, count):
        dropped = 0
        with closing(self.connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO batches(created,body,n) VALUES(?,?,?)', (time.time(), body, count))
            size, = db.execute('SELECT SUM(length(body)) FROM batches').fetchone()
            while size > self.max_bytes:
                row, size_removed, n = db.execute('SELECT id,length(body),n FROM batches ORDER BY id LIMIT 1').fetchone()
                db.execute('DELETE FROM batches WHERE id=?', (row,))
                size -= size_removed
                dropped += n
        return dropped

    def head(self):
        with closing(self.connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            cutoff = time.time() - self.ttl
            expired, = db.execute('SELECT COALESCE(SUM(n),0) FROM batches WHERE created<=?', (cutoff,)).fetchone()
            db.execute('DELETE FROM batches WHERE created<=?', (cutoff,))
            return expired, db.execute('SELECT id,body,n FROM batches ORDER BY id LIMIT 1').fetchone()

    def remove(self, row):
        with closing(self.connect()) as db, db:
            db.execute('DELETE FROM batches WHERE id=?', (row,))
