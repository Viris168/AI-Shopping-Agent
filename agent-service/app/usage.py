"""Model usage and estimated cost (PLAN-19 M2).

`llm.py` reports every model call here. `tracking()` collects them in-process, so an eval run can
say what it spent without a telemetry collector:

    with usage.tracking() as tally:
        ...                       # every model call in here, including tasks started in here
    print(tally.total.cost_usd)

Tallies nest: a call counts in every tally open around it (e.g. one per case and one per run).
"""

import dataclasses
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from app.config import ModelPrice

_MILLION = 1_000_000


def estimate_cost(
    price: ModelPrice | None, input_tokens: int, cache_read: int, output_tokens: int
) -> float | None:
    """USD for one call, or None when the model has no price. Assumes `input_tokens` excludes
    cache reads, as on Anthropic's API (DeepSeek's to be verified, PLAN-19 M2 step 6)."""
    if price is None:
        return None
    return (
        input_tokens * price.input + cache_read * price.cache_read + output_tokens * price.output
    ) / _MILLION


@dataclasses.dataclass
class Counts:
    calls: int = 0
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cost_usd: float = 0.0
    unpriced_calls: int = 0  # calls whose model had no price, so cost_usd leaves them out

    def add(self, other: "Counts") -> None:
        for field in dataclasses.fields(self):
            setattr(self, field.name, getattr(self, field.name) + getattr(other, field.name))


@dataclasses.dataclass
class UsageTally:
    by_call: dict[tuple[str, str], Counts] = dataclasses.field(default_factory=dict)

    def add(self, purpose: str, model: str, counts: Counts) -> None:
        self.by_call.setdefault((purpose, model), Counts()).add(counts)

    @property
    def total(self) -> Counts:
        total = Counts()
        for counts in self.by_call.values():
            total.add(counts)
        return total

    def take(self) -> Counts:
        """Totals so far, then start again from zero."""
        total = self.total
        self.by_call.clear()
        return total

    def as_dict(self) -> dict[str, Any]:
        return {
            "total": dataclasses.asdict(self.total),
            "by_call": [
                {"purpose": purpose, "model": model, **dataclasses.asdict(counts)}
                for (purpose, model), counts in sorted(self.by_call.items())
            ],
        }


_open: ContextVar[tuple[UsageTally, ...]] = ContextVar("usage_tallies", default=())


@contextmanager
def tracking() -> Iterator[UsageTally]:
    tally = UsageTally()
    token = _open.set((*_open.get(), tally))
    try:
        yield tally
    finally:
        _open.reset(token)


def record(purpose: str, model: str, counts: Counts) -> None:
    for tally in _open.get():
        tally.add(purpose, model, counts)
