"""Token use of one long conversation, call by call (PLAN-19 M4 step 1).

    python -m evals.cost_probe --label before
    python -m evals.cost_probe --label routed --routing   # model routing on (PLAN-19 M5)

Eval cases are mostly one or two turns, so they can't show what happens to the prefix cache as a
conversation grows. This runs one scripted 12-turn conversation as alice through the real loop
and prints, for every model call, the turn, the tool round, how many messages were sent, and
uncached input / cache-hit / output tokens. Compare runs before and after a prompt-layout change.

Needs the same setup as `evals.run` (seeded commerce-api, SERVICE_TOKEN, model access) and
`MODEL_PRICES` for the cost column. Costs about 25 main-model calls (a few US cents). The return
in turn 8 only opens a Confirm card; nothing is submitted.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections.abc import Callable
from typing import Any

from anthropic.types import Message

from app.config import get_settings
from app.llm import LLM
from app.usage import estimate_cost
from evals.cases import EVALS_DIR, Case
from evals.harness import Logins, run_case
from evals.run import DEMO_PASSWORD, preflight

TURNS = [
    "Hi! I'm looking for a rain jacket.",
    "How much is the Packable Rain Jacket?",
    "Add one to my cart.",
    "What's in my cart now?",
    "Do I get free shipping?",
    "Where is my order ORD-1002?",
    "What was in ORD-1001?",
    "Can I return the Trailrunner shoes from ORD-1001? They're too small.",
    "How long do refunds take?",
    "Do you have running shoes?",
    "Which one is the cheapest?",
    "Thanks, that's all.",
]


def _is_tool_results(message: Any) -> bool:
    content = message.get("content") if isinstance(message, dict) else None
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )


class ProbeLLM(LLM):
    """The real model client, logging every main-model call's usage."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.log: list[dict[str, Any]] = []
        self._turn = 0
        self._round = 0

    async def stream(self, **kwargs: Any) -> Message:
        messages = kwargs["messages"]
        fast = bool(kwargs.get("fast"))
        last = self.log[-1] if self.log else None
        redo = last is not None and last["fast"] and not fast and last["msgs_id"] == id(messages)
        if not redo:  # the main model redoing a dropped fast round is the same round
            if not _is_tool_results(messages[-1]):  # a shopper message (or event): new turn
                self._turn += 1
                self._round = 0
            self._round += 1
        resp = await super().stream(**kwargs)
        u = resp.usage
        self.log.append({
            "turn": self._turn, "round": self._round, "messages": len(messages),
            "model": resp.model, "fast": fast, "msgs_id": id(messages),
            "input": u.input_tokens, "cache_read": u.cache_read_input_tokens or 0,
            "output": u.output_tokens,
        })
        return resp


def report(
    log: list[dict[str, Any]], price_cost: Callable[[int, int, int, str], float | None]
) -> dict[str, Any]:
    print(f"{'turn':>4} {'round':>5} {'msgs':>4} {'uncached':>8} {'cached':>7} {'out':>5}  model")
    for c in log:
        print(f"{c['turn']:>4} {c['round']:>5} {c['messages']:>4} {c['input']:>8} "
              f"{c['cache_read']:>7} {c['output']:>5}  {c.get('model', '')}")
    calls = len(log) or 1
    uncached = sum(c["input"] for c in log)
    cached = sum(c["cache_read"] for c in log)
    output = sum(c["output"] for c in log)
    costs = [price_cost(c["input"], c["cache_read"], c["output"], c.get("model", ""))
             for c in log]
    cost = None if any(c is None for c in costs) else sum(c for c in costs if c is not None)
    summary = {
        "calls": len(log),
        "uncached_per_call": round(uncached / calls),
        "cached_per_call": round(cached / calls),
        "output_per_call": round(output / calls),
        "cache_hit_share": round(cached / ((uncached + cached) or 1), 3),
        "cost_usd": cost,
    }
    print(f"\n{len(log)} calls · {summary['uncached_per_call']} uncached / "
          f"{summary['cached_per_call']} cached / {summary['output_per_call']} out per call · "
          f"cache hits {summary['cache_hit_share']:.0%} of input"
          + (f" · est ${cost:.4f}" if cost is not None else " · no price (set MODEL_PRICES)"))
    return summary


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.cost_probe")
    parser.add_argument("--label", default="probe", help="Name for the report file")
    parser.add_argument("--routing", action="store_true", help="Model routing on")
    args = parser.parse_args(argv)

    settings = get_settings()
    if args.routing:
        settings = settings.model_copy(update={"model_routing_enabled": True})
    await preflight(settings)
    logins = Logins(settings, os.environ.get("EVAL_PASSWORD", DEMO_PASSWORD))
    llm = ProbeLLM(settings)
    case = Case.model_validate({
        "id": "G-PROBE-01", "scenario": "Cost probe: a 12-turn conversation",
        "turns": TURNS, "expect": {},
    })
    records = await run_case(case, settings, await logins.shopper("alice"), llm=llm)

    def cost(i: int, c: int, o: int, model: str) -> float | None:
        return estimate_cost(settings.model_prices.get(model), i, c, o)

    for call in llm.log:
        call.pop("msgs_id")
    summary = report(llm.log, cost)

    out_dir = EVALS_DIR / "results"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"cost-probe-{args.label}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({
        "label": args.label, "model": settings.model_main, "routing": args.routing,
        "window_messages": settings.window_messages, "summary": summary, "calls": llm.log,
        "replies": [r.text for r in records],
    }, indent=2), encoding="utf-8")
    print(f"Report: {out.relative_to(EVALS_DIR.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
