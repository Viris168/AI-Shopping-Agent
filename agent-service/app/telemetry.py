"""Tracing, metrics, request IDs and log format (ARCHITECTURE.md §8).

Code calls the OpenTelemetry API only. The SDK and its OTLP/HTTP exporters start when
OTEL_EXPORTER_OTLP_ENDPOINT is set (auth in OTEL_EXPORTER_OTLP_HEADERS); otherwise every span
and instrument is a no-op, so tests and local runs need no collector.

Dashboard and alert definitions built on these names: infra/monitoring/.
"""

import json
import logging
import re
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.trace import Span, Status, StatusCode
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings

SERVICE_NAME = "agent-service"

tracer = trace.get_tracer(SERVICE_NAME)
_meter = metrics.get_meter(SERVICE_NAME)

# Latency buckets in seconds: first token should sit well under 4 s, turns under 45 s.
_LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 20, 30, 45, 60]


def _histogram(name: str, description: str) -> metrics.Histogram:
    return _meter.create_histogram(
        name, unit="s", description=description,
        explicit_bucket_boundaries_advisory=_LATENCY_BUCKETS,
    )


turn_duration = _histogram("agent.turn.duration", "Whole turn, request to `done`")
first_token = _histogram("agent.turn.first_token", "Request to first text_delta")
active_streams = _meter.create_up_down_counter("agent.streams.active", description="Open streams")
turn_errors = _meter.create_counter("agent.turn.errors", description="Turns ending in an error")
model_calls = _meter.create_counter("agent.model.calls", description="Model API calls by status")
model_duration = _histogram("agent.model.duration", "One model API call")
model_tokens = _meter.create_counter("agent.model.tokens", unit="{token}", description="Tokens")
tool_calls = _meter.create_counter("agent.tool.calls", description="Tool runs by status")
tool_duration = _histogram("agent.tool.duration", "One tool run, including API retries")
tool_cache = _meter.create_counter("agent.tool.cache", description="Tool cache hits and misses")
conversations = _meter.create_counter("agent.conversations", description="New conversations")
handoffs = _meter.create_counter("agent.handoffs", description="Support tickets created")
actions = _meter.create_counter("agent.actions", description="Confirm-first actions by result")
feedback = _meter.create_counter("agent.feedback", description="Thumbs up/down")
kill_switch_rejections = _meter.create_counter(
    "agent.disabled.rejections", description="Requests refused by the kill switch"
)


# --- request IDs -----------------------------------------------------------------

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
# Accept a caller's ID only if it is short and plain, so it can't break log lines.
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


def request_id() -> str:
    """This request's ID; one per incoming request, sent to commerce-api as X-Request-Id."""
    rid = _request_id.get()
    if rid is None:
        rid = str(uuid.uuid4())
        _request_id.set(rid)
    return rid


class RequestIdMiddleware:
    """Pure ASGI, so the ID's context reaches the streaming response's worker task."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope["headers"]).get(b"x-request-id", b"").decode("latin-1")
        rid = incoming if _VALID_REQUEST_ID.match(incoming) else str(uuid.uuid4())
        token = _request_id.set(rid)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"x-request-id", rid.encode()))
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            _request_id.reset(token)


# --- spans -------------------------------------------------------------------------

def annotate(**attributes: Any) -> None:
    """Add attributes to the current span (no-op when tracing is off)."""
    span = trace.get_current_span()
    for key, value in attributes.items():
        if value is not None:
            span.set_attribute(key, value)


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[Span]:
    """A span that records exceptions as errors. Attributes must be free of personal data."""
    with tracer.start_as_current_span(name) as s:
        s.set_attribute("request.id", request_id())
        for key, value in attributes.items():
            if value is not None:
                s.set_attribute(key, value)
        yield s


def mark_error(s: Span, error_type: str) -> None:
    s.set_attribute("error.type", error_type)
    s.set_status(Status(StatusCode.ERROR))


class Stopwatch:
    def __init__(self) -> None:
        self.start = time.perf_counter()

    @property
    def elapsed(self) -> float:
        return time.perf_counter() - self.start


# --- logs ------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    """One JSON object per line, with request and trace IDs to join logs, traces and
    commerce-api's logs. The message is already masked by MaskingFilter."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": _request_id.get(),
        }
        ctx = trace.get_current_span().get_span_context()
        if ctx.is_valid:
            entry["trace_id"] = format(ctx.trace_id, "032x")
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = f"{record.levelname} {record.name}: {record.getMessage()}"
        rid = _request_id.get()
        if rid:
            line += f" [{rid}]"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


# --- setup -----------------------------------------------------------------------

def setup(settings: Settings) -> Callable[[], None]:
    """Start the OTLP exporters if configured. Returns a shutdown function that flushes them."""
    endpoint = (settings.otel_exporter_otlp_endpoint or "").rstrip("/")
    if not endpoint:
        return lambda: None

    # Imported here: the SDK is only needed when exporting.
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
    from opentelemetry.util.re import parse_env_headers

    # Settings (not the exporters' own env lookup), so values from .env work too.
    raw_headers = settings.otel_exporter_otlp_headers
    headers = parse_env_headers(raw_headers.get_secret_value(), liberal=True) if raw_headers else {}
    resource = Resource.create({
        "service.name": SERVICE_NAME,
        # Prometheus-style backends turn namespace/name into the `job` label, so dashboards
        # and alerts can tell environments apart: job="production/agent-service".
        "service.namespace": settings.deploy_env or settings.app_env,
        "deployment.environment.name": settings.deploy_env or settings.app_env,
    })
    tracer_provider = TracerProvider(
        resource=resource, sampler=ParentBased(TraceIdRatioBased(settings.trace_sample_ratio))
    )
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces", headers=headers))
    )
    trace.set_tracer_provider(tracer_provider)

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics", headers=headers),
            export_interval_millis=30_000,
        )],
    )
    metrics.set_meter_provider(meter_provider)
    logging.getLogger(__name__).info("telemetry exporting to %s", endpoint)

    def shutdown() -> None:
        tracer_provider.shutdown()
        meter_provider.shutdown()

    return shutdown
