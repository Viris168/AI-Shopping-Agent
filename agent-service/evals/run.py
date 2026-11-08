"""Eval runner (AGENT.md §8).

    python -m evals.run --suite redteam                # whole suite, pass bar 100%
    python -m evals.run --suite redteam --case R-INJ-01 --repeat 5

Needs commerce-api running on freshly seeded data (`npm run seed`), SERVICE_TOKEN set
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
from pathlib import Path
from typing import Any, cast

from app.commerce_client import CommerceClient
from app.config import Settings, get_settings
from app.llm import LLM
from evals.cases import EVALS_DIR, PASS_BAR, Case, Suite, load_suite
from evals.checks import Verdict, score
from evals.harness import Logins, run_case

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
        turns = await run_case(case, settings, await logins.auth(case.user))
    except Exception as exc:  # a crash is a failed case, not a crashed run
        return Verdict(False, [f"error: {type(exc).__name__}: {exc}"]), []
    verdict = await score(case, turns, llm.complete_fast if llm else None)
    return verdict, [asdict(t) for t in turns]


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.run")
    parser.add_argument("--suite", choices=list(PASS_BAR), required=True)
    parser.add_argument("--case", action="append", help="Run only this case ID (repeatable)")
    parser.add_argument("--repeat", type=int, default=1, help="Runs per case; all must pass")
    parser.add_argument("--no-grader", action="store_true",
                        help="Deterministic checks only; cases with a grader then fail")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    suite = cast(Suite, args.suite)
    cases = load_suite(suite)
    if args.case:
        unknown = set(args.case) - {c.id for c in cases}
        if unknown:
            sys.exit(f"Unknown case IDs: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c.id in args.case]

    settings = get_settings()
    await preflight(settings)
    logins = Logins(settings, os.environ.get("EVAL_PASSWORD", DEMO_PASSWORD))
    llm = None if args.no_grader else LLM(settings)

    results: list[dict[str, Any]] = []
    passed = 0
    for case in cases:
        runs = [await run_one(case, settings, logins, llm) for _ in range(args.repeat)]
        failures = [f for verdict, _ in runs for f in verdict.failures]
        ok = all(verdict.passed for verdict, _ in runs)
        passed += ok
        print(f"{'PASS' if ok else 'FAIL'}  {case.id:<11} {case.attack}")
        for failure in dict.fromkeys(failures):
            print(f"        - {failure}")
        results.append({
            "id": case.id, "passed": ok, "failures": failures,
            "runs": [{"passed": v.passed, "turns": t} for v, t in runs],
        })

    rate = passed / len(cases) if cases else 0.0
    bar = PASS_BAR[suite]
    print(f"\n{suite}: {passed}/{len(cases)} passed ({rate:.0%}); bar {bar:.0%}")

    out_dir = EVALS_DIR / "results"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{suite}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    report = {"suite": suite, "model": settings.model_main, "passed": passed,
              "total": len(cases), "results": results}
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"Report: {Path(out).relative_to(EVALS_DIR.parent)}")
    return 0 if rate >= bar else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
