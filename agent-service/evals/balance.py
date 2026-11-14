"""Check the eval account's balance before spending it (PLAN-19 M1).

Evals bill the dev/eval provider account (a separate account from production's; see
infra/README.md). DeepSeek is prepaid, so a run that outgrows the balance used to die halfway with
`402`. `evals.run` and `evals.cost_probe` call `check` first; CI runs it before seeding:

    python -m evals.balance redteam golden      # can the account cover both full suites?

Only with a DeepSeek base URL (app/balance.py); other providers, or an unreachable balance
endpoint, skip the check with a note.
"""

import argparse
import asyncio
import sys

import httpx

from app import balance
from app.config import Settings, get_settings
from evals.cases import PASS_BAR, Suite, load_suite

# M2: about $0.0023 per case at DeepSeek's peak price; rounded up for headroom.
PER_CASE_USD = 0.0025
WARN_BELOW_USD = 2.0


def estimate(cases: int, repeat: int = 1, max_cost: float | None = None) -> float:
    """Worst-case spend of a run: a `--max-cost` cap bounds it."""
    cost = cases * repeat * PER_CASE_USD
    return min(cost, max_cost) if max_cost is not None else cost


async def check(settings: Settings, needed_usd: float) -> str | None:
    """None when the run can go ahead (a warning may be printed), else why it can't."""
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            usd = await balance.fetch(settings, http)
    except Exception as exc:
        print(f"Note: eval balance not checked ({type(exc).__name__})", file=sys.stderr)
        return None
    if usd is None:
        return None  # not DeepSeek, or no key: nothing to check
    if usd < needed_usd:
        return (f"Eval account balance ${usd:.2f} is below this run's estimated "
                f"${needed_usd:.2f}. Top up the dev/eval account (infra/README.md), or run "
                f"fewer cases (--smoke, --changed, --max-cost).")
    if usd < WARN_BELOW_USD:
        print(f"Warning: eval account balance is ${usd:.2f}; top it up soon.", file=sys.stderr)
    return None


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.balance")
    parser.add_argument("suites", nargs="+", choices=list(PASS_BAR))
    args = parser.parse_args(argv)
    suites: list[Suite] = args.suites
    needed = estimate(sum(len(load_suite(s)) for s in suites))
    problem = await check(get_settings(), needed)
    if problem:
        print(problem, file=sys.stderr)
        return 1
    print(f"Eval balance covers an estimated ${needed:.2f} for {', '.join(suites)}.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
