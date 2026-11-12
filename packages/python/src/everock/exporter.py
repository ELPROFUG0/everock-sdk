"""Bounded, privacy-first OTel exporter for the Everock ingestion protocol."""
import json
import re
import sqlite3
import threading
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from .journal import Journal
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult


def clean_text(value):
    text = str(value)[:8000]
    def url(match):
        try:
            parsed = urlsplit(match.group())
            return f"{parsed.scheme}://{parsed.hostname or ''}{parsed.path}"
        except ValueError:
            return '[URL]'
    text = re.sub(r'https?://[^\s<>"\']+', url, text)
    return re.sub(r'(?i)(password|token|secret|authorization|api_key)\s*[:=]\s*\S+', r'\1=[Redacted]', text)


def route_path(value):
    path = str(value).split('?')[0].split('#')[0]
    path = re.sub(r'\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', ':id', path, flags=re.I)
    path = re.sub(r'/[^/]*@[^/]*(?=/|$)', '/:id', path)
    path = re.sub(r'/\d+(?=/|$)', '/:id', path)
    return re.sub(r'/[0-9a-f]{24,}(?=/|$)', '/:id', path, flags=re.I)[:300]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a project key to another destination.


class EverockSpanExporter(SpanExporter):
    def __init__(self, *, public_key, endpoint, environment='production', release=None,
                 component='main', service_name=None, timeout=2.0, attempts=3, before_send=None,
                 journal_directory=None, journal_max_bytes=8 * 1024 * 1024, journal_ttl_seconds=86400):
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('A collector HTTP(S) URL without credentials or query is required')
        if not public_key or '\n' in public_key or '\r' in public_key:
            raise ValueError('A valid project key is required')
        self.endpoint = endpoint.rstrip('/') + '/ingest'
        self.public_key = public_key
        self.environment, self.release = environment, release
        self.component, self.service = component, service_name or component
        self.timeout = max(0.1, min(float(timeout), 10.0))
        self.attempts = max(1, min(int(attempts), 3))
        self.before_send = before_send
        self._closed = False
        self._lock = threading.Lock()
        self._counts = dict(delivered=0, discarded=0, filtered=0, serialization=0, attempts=0, journal_errors=0, expired=0, capacity_drops=0)
        self._opener = build_opener(NoRedirect())
        self._journal = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._worker = None
        self._retry_at = 0.0
        if journal_directory is not None:
            self._journal = Journal(journal_directory, json.dumps([self.endpoint, public_key, component, self.service, environment]),
                                    journal_max_bytes, journal_ttl_seconds)
            self._worker = threading.Thread(target=self._recover, name='everock-journal', daemon=True)
            self._worker.start()

    def _count(self, key, count=1):
        with self._lock:
            self._counts[key] += count

    def diagnostics(self):
        with self._lock:
            return dict(self._counts)

    def _base(self, span, payload, event_type='trace', message=None, signal=None):
        context = span.context
        payload.update(traceId=f'{context.trace_id:032x}', spanId=f'{context.span_id:016x}',
                       traceFlags=f'{int(context.trace_flags):02x}', component=self.component, service=self.service)
        if span.parent:
            payload['parentSpanId'] = f'{span.parent.span_id:016x}'
        result = dict(id=str(uuid.uuid4()), ts=int(span.start_time // 1_000_000), type=event_type,
                      environment=self.environment, payload=payload, context={'platform': 'server', 'runtime': 'python'})
        if self.release:
            result['release'] = self.release
        if message:
            result['message'] = clean_text(message)
        if signal:
            result['signal'] = signal
        return result

    def _events(self, span):
        attrs = span.attributes or {}
        raw_url = attrs.get('url.full', attrs.get('http.url', ''))
        if raw_url:
            url, collector = urlsplit(str(raw_url)), urlsplit(self.endpoint)
            if (url.scheme, url.netloc, url.path.rstrip('/')) == (collector.scheme, collector.netloc, collector.path):
                return []
        duration = max(0, min(3600000, (span.end_time - span.start_time) / 1_000_000))
        kind = span.kind.name
        method = attrs.get('http.request.method', attrs.get('http.method'))
        payload = dict(kind='span', source='opentelemetry', name=clean_text(span.name), durationMs=duration, failed=span.status.is_ok is False)
        if kind in ('SERVER', 'CLIENT') and method:
            parsed = urlsplit(str(raw_url))
            path = attrs.get('http.route') or attrs.get('url.path') or parsed.path or attrs.get('http.target') or '/'
            status = attrs.get('http.response.status_code', attrs.get('http.status_code', 0))
            status = status if isinstance(status, int) and 100 <= status <= 599 else 0
            payload.update(kind='http', method=str(method).upper()[:12], path=route_path(path),
                host=str(attrs.get('server.address') or attrs.get('http.host') or parsed.hostname or 'runtime')[:253],
                statusCode=status, failed=status == 0 or status >= 400 or span.status.is_ok is False,
                direction='inbound' if kind == 'SERVER' else 'outbound', outcome='response' if status else 'network_error')
        result = [self._base(span, payload, message=span.name)]
        exception = next((e for e in span.events if e.name == 'exception'), None)
        if exception or (payload['kind'] == 'http' and (payload['statusCode'] >= 500 or payload['statusCode'] == 0)):
            detail = exception.attributes or {} if exception else {}
            mechanism = 'framework_error' if exception else ('http_error' if payload['statusCode'] else 'network_error')
            signal = dict(version=1, source='server', mechanism=mechanism, handled=not bool(exception), level='error')
            if payload.get('statusCode'):
                signal['statusCode'] = payload['statusCode']
            error_payload = {'request': dict(payload)} if payload['kind'] == 'http' else {}
            if detail.get('exception.stacktrace'):
                error_payload['stack'] = clean_text(detail['exception.stacktrace'])
            result.append(self._base(span, error_payload, 'error',
                detail.get('exception.message') or f"HTTP {payload.get('statusCode', 0)}", signal))
        return result

    def export(self, spans):
        if self._closed:
            return SpanExportResult.FAILURE
        events = []
        for span in spans:
            try:
                for event in self._events(span):
                    if self.before_send:
                        event = self.before_send(event)
                    if event is None:
                        self._count('filtered'); continue
                    # No arbitrary span attributes/headers/bodies are exported.
                    encoded = json.dumps(event, allow_nan=False).encode()
                    if len(encoded) > 46000:
                        self._count('discarded'); continue
                    events.append(event)
            except Exception:
                self._count('serialization')
        success = True
        while events:
            batch = []
            # Reserve service observations and envelope space within 48 KiB.
            size = 1024
            while events and len(batch) < 20:
                candidate = events[0]
                cost = len(json.dumps(candidate, allow_nan=False).encode()) + 400
                if batch and size + cost > 48 * 1024:
                    break
                batch.append(events.pop(0))
                size += cost
            services = {}
            for event in batch:
                p = event.get('payload', {})
                if p.get('kind') == 'http' and p.get('direction') == 'outbound':
                    item = services.setdefault(p['host'], dict(host=p['host'], ok=0, fail=0, self=False))
                    item['fail' if p['failed'] else 'ok'] += 1
            body = json.dumps(dict(events=batch, services=list(services.values())), allow_nan=False).encode()
            if self._journal:
                try:
                    dropped = self._journal.append(body, len(batch))
                    self._count('capacity_drops', dropped)
                    self._count('discarded', dropped)
                    self._wake.set()
                    continue
                except (OSError, sqlite3.Error):
                    # A full or unavailable disk must not prevent immediate export.
                    self._count('journal_errors')
            delivered = self._send(body) == 'delivered'
            self._count('delivered' if delivered else 'discarded', len(batch))
            success = success and delivered
        return SpanExportResult.SUCCESS if success else SpanExportResult.FAILURE

    def _send(self, body):
        for attempt in range(self.attempts):
            self._count('attempts')
            delay = 0.1 * 2 ** attempt
            try:
                request = Request(self.endpoint, data=body, headers={
                    'Content-Type': 'application/json',
                    'User-Agent': 'Everock-Python-SDK',
                    'x-everock-key': self.public_key,
                })
                with self._opener.open(request, timeout=self.timeout) as response:
                    return 'delivered' if 200 <= response.status < 300 else 'rejected'
            except HTTPError as error:
                with error:
                    if error.code not in (408, 429) and error.code < 500:
                        return 'rejected'
                    header = error.headers.get('Retry-After')
                    if header:
                        try:
                            from email.utils import parsedate_to_datetime
                            seconds = float(header) if header.isdigit() else parsedate_to_datetime(header).timestamp() - time.time()
                        except (ValueError, TypeError, OverflowError):
                            seconds = 30
                        if seconds > 1:
                            self._retry_at = time.monotonic() + min(seconds, 86400)
                            return 'retry'
                        delay = max(delay, seconds)
            except (URLError, TimeoutError, OSError):
                pass
            if attempt + 1 < self.attempts and self._stop.wait(delay):
                return 'retry'
        return 'retry'

    def _recover(self):
        # One sender per exporter. Multiple processes may replay the same immutable
        # batch after a crash; ingestion deduplicates by the original event IDs.
        while not self._stop.is_set():
            try:
                expired, row = self._journal.head()
                self._count('expired', expired)
                self._count('discarded', expired)
                if row and time.monotonic() >= self._retry_at:
                    key, body, count = row
                    outcome = self._send(body)
                    if outcome != 'retry':
                        self._journal.remove(key)
                        self._count('delivered' if outcome == 'delivered' else 'discarded', count)
                        continue
                    self._retry_at = max(self._retry_at, time.monotonic() + 30)
            except (OSError, sqlite3.Error):
                self._count('journal_errors')
            self._wake.wait(30)
            self._wake.clear()

    def shutdown(self):
        self._closed = True
        self._stop.set()
        self._wake.set()
        if self._worker:
            self._worker.join(timeout=self.timeout + 1)

    def force_flush(self, timeout_millis=30000):
        return True  # The processor flushes to disk when journaling is enabled.
