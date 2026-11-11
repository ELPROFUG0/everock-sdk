"""Everock Python integration. Configuration never replaces an existing OTel provider."""
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from .exporter import EverockSpanExporter


class Integration:
    def __init__(self, provider, processor, exporter):
        self.provider, self.processor, self.exporter = provider, processor, exporter

    def flush(self, timeout_millis=10000):
        return self.processor.force_flush(timeout_millis)

    def shutdown(self):
        self.processor.shutdown()


def configure(*, provider=None, **options):
    if provider is None:
        provider = trace.get_tracer_provider()
        if isinstance(provider, trace.ProxyTracerProvider):
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
    if not hasattr(provider, 'add_span_processor'):
        raise ValueError('Pass an OpenTelemetry SDK TracerProvider')
    if getattr(provider, '_everock_integration', None):
        raise ValueError('Everock is already configured on this provider')
    exporter = EverockSpanExporter(**options)
    processor = BatchSpanProcessor(exporter, max_queue_size=2048, max_export_batch_size=128, schedule_delay_millis=1000)
    provider.add_span_processor(processor)
    integration = Integration(provider, processor, exporter)
    provider._everock_integration = integration
    return integration


def instrument_fastapi(app, integration):
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app, tracer_provider=integration.provider)


def instrument_flask(app, integration):
    from opentelemetry.instrumentation.flask import FlaskInstrumentor
    FlaskInstrumentor().instrument_app(app, tracer_provider=integration.provider)


def instrument_django(integration):
    """Call before get_wsgi_application()/get_asgi_application()."""
    from opentelemetry.instrumentation.django import DjangoInstrumentor
    DjangoInstrumentor().instrument(tracer_provider=integration.provider)


def instrument_httpx(integration):
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    HTTPXClientInstrumentor().instrument(tracer_provider=integration.provider)


def instrument_requests(integration):
    from opentelemetry.instrumentation.requests import RequestsInstrumentor
    RequestsInstrumentor().instrument(tracer_provider=integration.provider)
