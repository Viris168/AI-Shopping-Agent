"""Eval runner (AGENT.md §8).

    python -m evals.run --suite golden                 # whole suite, pass bar 90%
    python -m evals.run --suite redteam                # whole suite, pass bar 100%
    python -m evals.run --suite redteam --case R-INJ-01 --repeat 5
    python -m evals.run --suite golden --file orders   # only evals/golden/orders.yaml
    python -m evals.run --suite golden --smoke         # the smoke set (`smoke: true` cases)
    python -m evals.run --suite golden --changed       # what changed since main (evals/select.py)
    python -m evals.run --suite golden --max-cost 0.30 # stop once the estimate passes $0.30

Needs commerce-api running on seeded data (`npm run seed`), SERVICE_TOKEN set
the same in both services, and model access. Results are written to evals/results/.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import asdict
from functools import partial
from pathlib import Path
from typing import Any, cast

from app import usage
from app.commerce_client import CommerceClient
from app.config import Settings, get_settings
from app.llm import LLM
from evals.cases import EVALS_DIR, PASS_BAR, Case, Suite, load_suite
from evals.checks import Verdict, score
from evals.harness import Logins, run_case
from evals.select import changed_paths, select

# Past this, --repeat is a whole-suite rerun in disguise; use it to chase one flaky case.
REPEAT_WARN = 5

# Public demo password from the commerce-api seed (src/database/seed.ts), not a real secret.
DEMO_PASSWORD = "Password123!"  # noqa: S105


async def preflight(settings: Settings) -> None:
    client = CommerceClient(settings)
    try:
        if not await client.ping():
            sys.exit(f"commerce-api is not reachable at {settings.commerce_api_url}")
    finally:
        await client.aclose()
    if settings.service_token is None:
        sys.exit("SERVICE_TOKEN is not set: commerce-api rejects agent calls without it (403)")


async def run_one(
    case: Case, settings: Settings, logins: Logins, llm: LLM | None
) -> tuple[Verdict, list[dict[str, Any]]]:
    try:
        turns = await run_case(case, settings, await logins.shopper(case.user))
    except Exception as exc:  # a crash is a failed case, not a crashed run
        return Verdict(False, [f"error: {type(exc).__name__}: {exc}"]), []
    verdict = await score(
        case, turns, partial(llm.complete_fast, purpose="eval_grade") if llm else None
    )
    return verdict, [asdict(t) for t in turns]


async def run_case_and_report(
    case: Case, settings: Settings, logins: Logins, llm: LLM | None, repeat: int
) -> tuple[bool, dict[str, Any]]:
    with usage.tracking() as case_usage:
        runs = [await run_one(case, settings, logins, llm) for _ in range(repeat)]
    failures = [f for verdict, _ in runs for f in verdict.failures]
    ok = all(verdict.passed for verdict, _ in runs)
    print(f"{'PASS' if ok else 'FAIL'}  {case.id:<11} {case.scenario}")
    for failure in dict.fromkeys(failures):
        print(f"        - {failure}")
    return ok, {
        "id": case.id, "passed": ok, "failures": failures, "usage": case_usage.as_dict(),
        "runs": [{"passed": v.passed, "turns": t} for v, t in runs],
    }


def _tokens(n: int) -> str:
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}k" if n >= 1e3 else str(n)


def usage_line(tally: usage.UsageTally) -> str:
    """e.g. `412 calls · 1.9M in (1.2M cached) / 140k out · est $0.84 (chat 78%, eval_grade 15%)`.
    Shares are by cost, or by tokens when no model has a price."""
    total = tally.total
    line = (f"{total.calls} calls · {_tokens(total.input)} in ({_tokens(total.cache_read)} cached)"
            f" / {_tokens(total.output)} out")
    by_purpose: dict[str, float] = {}
    for (purpose, _), c in tally.by_call.items():
        weight = c.cost_usd if total.cost_usd else c.input + c.cache_read + c.output
        by_purpose[purpose] = by_purpose.get(purpose, 0) + weight
    whole = sum(by_purpose.values()) or 1
    shares = ", ".join(f"{p} {w / whole:.0%}" for p, w in
                       sorted(by_purpose.items(), key=lambda kv: -kv[1]))
    if total.cost_usd:
        line += f" · est ${total.cost_usd:.2f}"
    if shares:
        line += f" ({shares}{'' if total.cost_usd else ' of tokens'})"
    if total.unpriced_calls:
        line += f" · {total.unpriced_calls} calls unpriced (set MODEL_PRICES)"
    return line


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.run")
    parser.add_argument("--suite", choices=list(PASS_BAR), required=True)
    parser.add_argument("--case", action="append", help="Run only this case ID (repeatable)")
    parser.add_argument("--file", action="append",
                        help="Run only cases from <suite>/<FILE>.yaml (repeatable)")
    parser.add_argument("--repeat", type=int, default=1, help="Runs per case; all must pass")
    parser.add_argument("--smoke", action="store_true",
                        help="Run only the smoke set: cases marked `smoke: true`")
    parser.add_argument("--changed", nargs="?", const="main", metavar="BASE",
                        help="Run only the cases affected by changes since BASE (default main)")
    parser.add_argument("--max-cost", type=float, metavar="USD",
                        help="Stop after the case that takes the estimated cost past USD")
    parser.add_argument("--no-grader", action="store_true",
                        help="Deterministic checks only; cases with a grader then fail")
    args = parser.parse_args(argv)
    if (args.smoke or args.changed) and (args.file or args.case):
        parser.error("--smoke/--changed pick cases themselves; don't combine with --file/--case")
    if args.repeat > REPEAT_WARN:
        print(f"Warning: --repeat {args.repeat} runs every case {args.repeat}×; "
              "use it on one flaky --case", file=sys.stderr)

    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    suite = cast(Suite, args.suite)
    cases = load_suite(suite)
    if args.file:
        files = {Path(f).stem for f in args.file}
        unknown = files - {c.file for c in cases}
        if unknown:
            sys.exit(f"Unknown case files: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c.file in files]
    if args.case:
        unknown = set(args.case) - {c.id for c in cases}
        if unknown:
            sys.exit(f"Unknown case IDs: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c.id in args.case]
    if args.smoke or args.changed:
        picked: set[str] = set()
        smoke = args.smoke
        if args.changed:
            sel = select(suite, changed_paths(args.changed))
            for reason in sel.reasons:
                print(f"changed: {reason}")
            if sel.empty and not smoke:
                print(f"No changes since {args.changed} affect the {suite} evals; nothing to run.")
                return 0
            picked, smoke = sel.files, smoke or sel.smoke
        cases = [c for c in cases if c.file in picked or (smoke and c.smoke)]
        print(f"Running {len(cases)} {suite} cases\n")

    settings = get_settings()
    if args.max_cost is not None and not settings.model_prices:
        print("Warning: MODEL_PRICES is not set, so --max-cost can't stop the run",
              file=sys.stderr)
    await preflight(settings)
    logins = Logins(settings, os.environ.get("EVAL_PASSWORD", DEMO_PASSWORD))
    llm = None if args.no_grader else LLM(settings)

    results: list[dict[str, Any]] = []
    passed = 0
    stopped = False
    with usage.tracking() as run_usage:
        for case in cases:
            ok, result = await run_case_and_report(case, settings, logins, llm, args.repeat)
            passed += ok
            results.append(result)
            spent = run_usage.total.cost_usd
            if args.max_cost is not None and spent >= args.max_cost and case is not cases[-1]:
                stopped = True
                print(f"\nStopped: est ${spent:.2f} reached --max-cost ${args.max_cost:.2f} "
                      f"after {len(results)}/{len(cases)} cases")
                break

    rate = passed / len(cases) if cases else 0.0
    bar = PASS_BAR[suite]
    print(f"\n{suite}: {passed}/{len(cases)} passed ({rate:.0%}); bar {bar:.0%}")
    print(f"Usage: {usage_line(run_usage)}")

    out_dir = EVALS_DIR / "results"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{suite}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    report = {"suite": suite, "model": settings.model_main, "passed": passed,
              "total": len(cases), "stopped_at_max_cost": stopped,
              "usage": run_usage.as_dict(), "results": results}
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"Report: {Path(out).relative_to(EVALS_DIR.parent)}")
    return 0 if rate >= bar and not stopped else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
