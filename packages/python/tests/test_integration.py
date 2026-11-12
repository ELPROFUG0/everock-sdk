import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import SpanKind, StatusCode
from everock import configure, instrument_fastapi, instrument_flask
from everock.exporter import EverockSpanExporter


@pytest.fixture
def collector():
    batches = []
    state = {'status': 200}
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            state['user_agent'] = self.headers.get('User-Agent')
            batches.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(state['status']); self.end_headers(); self.wfile.write(b'{}')
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    yield f'http://127.0.0.1:{server.server_port}', batches, state
    server.shutdown(); thread.join(); server.server_close()


def setup(endpoint):
    return configure(provider=TracerProvider(), public_key='pk_test', endpoint=endpoint,
                     component='api', environment='staging', release='v2')


def inbound(batches):
    return [e for b in batches for e in b['events'] if e['payload'].get('direction') == 'inbound']


def test_fastapi_routes_errors_and_context(collector):
    from fastapi import FastAPI
    import asyncio
    import httpx
    endpoint, batches, state = collector
    telemetry = setup(endpoint)
    app = FastAPI()
    @app.get('/orders/{order_id}')
    async def order(order_id: str):
        return {'id': order_id}
    @app.get('/fail')
    async def fail():
        raise RuntimeError('failed https://user:pass@api.example/path?token=fixture_sensitive_123')
    instrument_fastapi(app, telemetry)
    try:
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://testserver') as client:
                response = await client.get('/orders/123?token=fixture_sensitive_123', headers={'traceparent': '00-'+'1'*32+'-'+'2'*16+'-01'})
                assert response.json() == {'id': '123'}
                assert (await client.get('/fail')).status_code == 500
        asyncio.run(exercise())
        assert telemetry.flush()
        assert state['user_agent'] == 'Everock-Python-SDK'
        events = inbound(batches)
        assert len(events) == 2
        assert events[0]['payload']['path'] == '/orders/{order_id}'
        assert events[0]['payload']['traceId'] == '1'*32
        assert all(e['environment'] == 'staging' and e['release'] == 'v2' for e in events)
        assert any(e['type'] == 'error' for b in batches for e in b['events'])
        assert 'fixture_sensitive_123' not in json.dumps(batches)
        assert 'user:pass' not in json.dumps(batches)
    finally:
        telemetry.shutdown()


def test_flask_routes(collector):
    from flask import Flask
    endpoint, batches, _ = collector
    telemetry = setup(endpoint)
    app = Flask(__name__)
    @app.get('/items/<item_id>')
    def item(item_id):
        return 'unchanged', 201
    instrument_flask(app, telemetry)
    try:
        response = app.test_client().get('/items/123?token=fixture_sensitive_123')
        assert response.status_code == 201 and response.data == b'unchanged'
        assert telemetry.flush()
        assert inbound(batches)[0]['payload']['path'] == '/items/<item_id>'
    finally:
        telemetry.shutdown()


def test_retry_identity_services_and_bounded_failure(collector):
    endpoint, batches, state = collector
    telemetry = setup(endpoint)
    state['status'] = 503
    tracer = telemetry.provider.get_tracer('test')
    with tracer.start_as_current_span('GET', kind=SpanKind.CLIENT, attributes={'http.request.method':'GET', 'url.full':'https://api.example/items/123?token=secret', 'http.response.status_code':503}):
        pass
    telemetry.flush()
    assert len(batches) == 3
    assert batches[0]['events'][0]['id'] == batches[-1]['events'][0]['id']
    assert batches[0]['services'] == [{'host':'api.example','ok':0,'fail':1,'self':False}]
    assert telemetry.exporter.diagnostics()['discarded'] == 2
    state['status'] = 200
    with tracer.start_as_current_span('recovery'):
        pass
    telemetry.flush()
    assert telemetry.exporter.diagnostics()['delivered'] == 1
    telemetry.shutdown()


def test_existing_provider_and_double_configuration(collector):
    telemetry = setup(collector[0])
    with pytest.raises(ValueError, match='already'):
        configure(provider=telemetry.provider, endpoint=collector[0], public_key='pk_test')
    telemetry.shutdown()


def test_permanent_error_not_retried(collector):
    endpoint, batches, state = collector
    state['status'] = 401
    telemetry = setup(endpoint)
    with telemetry.provider.get_tracer('test').start_as_current_span('one'):
        pass
    telemetry.flush(); telemetry.shutdown()
    assert len(batches) == 1


def test_collector_exclusion(collector):
    endpoint, batches, _ = collector
    telemetry = setup(endpoint)
    with telemetry.provider.get_tracer('test').start_as_current_span('collector', kind=SpanKind.CLIENT, attributes={'http.url':endpoint+'/ingest', 'http.method':'POST'}):
        pass
    telemetry.flush(); telemetry.shutdown()
    assert batches == []


def test_bad_configuration():
    with pytest.raises(ValueError):
        EverockSpanExporter(public_key='pk', endpoint='https://user:password@host')


def test_django_template_and_status(collector):
    from django.conf import settings
    from django.urls import path
    from django.http import HttpResponse
    from django.core.wsgi import get_wsgi_application
    from django.test import Client
    from everock import instrument_django
    from opentelemetry.instrumentation.django import DjangoInstrumentor
    endpoint, batches, _ = collector
    telemetry = setup(endpoint)
    global urlpatterns
    urlpatterns = [path('items/<int:item_id>', lambda request, item_id: HttpResponse('ok', status=202))]
    if not settings.configured:
        settings.configure(ROOT_URLCONF=__name__, SECRET_KEY='test-only', ALLOWED_HOSTS=['testserver'], MIDDLEWARE=[])
    instrument_django(telemetry)
    get_wsgi_application()
    try:
        assert Client().get('/items/123').status_code == 202
        telemetry.flush()
        event = inbound(batches)[0]
        assert event['payload']['statusCode'] == 202
        assert '123' not in event['payload']['path']
    finally:
        DjangoInstrumentor().uninstrument()
        telemetry.shutdown()


def test_real_outbound_httpx_requests(collector):
    import httpx
    import requests
    from everock import instrument_httpx, instrument_requests
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.requests import RequestsInstrumentor
    telemetry = setup(collector[0])
    instrument_httpx(telemetry); instrument_requests(telemetry)
    try:
        # Collector fixture returns 501 to GET, on a path that is not ingestion.
        assert httpx.get(collector[0]+'/dependency').status_code == 501
        assert requests.get(collector[0]+'/dependency', timeout=2).status_code == 501
        telemetry.flush()
        outbound = [e for b in collector[1] for e in b['events'] if e['payload'].get('direction') == 'outbound']
        assert len(outbound) == 2
        assert all(e['payload']['failed'] for e in outbound)
        assert sum(s['fail'] for b in collector[1] for s in b['services']) == 2
    finally:
        HTTPXClientInstrumentor().uninstrument(); RequestsInstrumentor().uninstrument()
        telemetry.shutdown()


def test_large_batches_are_bounded_and_filtered(collector):
    endpoint, batches, _ = collector
    telemetry = setup(endpoint)
    tracer = telemetry.provider.get_tracer('test')
    for _ in range(25):
        with tracer.start_as_current_span('x' * 7000):
            pass
    assert telemetry.flush()
    telemetry.shutdown()
    assert sum(len(batch['events']) for batch in batches) == 25
    assert all(len(json.dumps(batch).encode()) <= 48 * 1024 for batch in batches)
    assert len(batches) > 1


def test_filter_exceptions_do_not_escape_into_application(collector):
    def broken_filter(event):
        raise RuntimeError('filter failure')
    telemetry = configure(provider=TracerProvider(), public_key='pk_test', endpoint=collector[0], before_send=broken_filter)
    with telemetry.provider.get_tracer('test').start_as_current_span('safe'):
        pass
    assert telemetry.flush()
    telemetry.shutdown()
    assert collector[1] == []
    assert telemetry.exporter.diagnostics()['serialization'] == 1
