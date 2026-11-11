# Everock Python (beta, not yet published)

Python 3.10+. Install the wheel built from this repository; the package is not yet on PyPI.
Build: `uv build packages/python`. Install the framework extra, for example `everock-sdk[fastapi,httpx]` from your wheel.

```python
import os
from fastapi import FastAPI
from everock import configure, instrument_fastapi, instrument_httpx

telemetry = configure(
    public_key=os.environ['EVEROCK_PUBLIC_KEY'],
    endpoint=os.environ['EVEROCK_ENDPOINT'],
    environment='production', release='1.0.0', component='api',
)
app = FastAPI()
instrument_fastapi(app, telemetry)
instrument_httpx(telemetry)
```

Use `instrument_flask(app, telemetry)` for Flask or `instrument_django(telemetry)` before Django constructs its ASGI/WSGI application. Install the respective extra. Initialize once per worker process, after fork. Integrations preserve application responses and use OpenTelemetry context propagation.

An existing SDK TracerProvider can be supplied as `provider=`; Everock adds its own processor and does not replace other exporters. Do not instrument a library a second time if your application already instruments it. Call `telemetry.flush()` at controlled shutdown, then `telemetry.shutdown()`; never flush per request.

HTTP spans supply endpoints, durations, errors, environment, release and component. Outbound HTTP spans supply service observations. The exporter omits arbitrary attributes, headers, query strings, bodies and SQL statements. Exceptions still need application-specific filtering when messages contain sensitive data: `before_send(event)` can return `None` to discard. Browser sessions/replay require the browser SDK.

Delivery uses a bounded 2,048-span in-memory OpenTelemetry queue and up to three bounded attempts per batch with stable event IDs. For restart recovery, pass `journal_directory` pointing to a private directory on a persistent volume. SQLite stores post-filter batches with stable IDs and no key, up to 8 MiB of payloads and 24 hours by default (`journal_max_bytes`, `journal_ttl_seconds`). Background replay also runs at startup without new traffic. A crash can still lose spans not yet exported from the in-memory queue. `telemetry.exporter.diagnostics()` counts delivery, filtering and export failures; queue overflow is reported by OpenTelemetry's own diagnostics, not this counter. This beta does not claim lossless delivery or automatic coverage of every database/queue library.
