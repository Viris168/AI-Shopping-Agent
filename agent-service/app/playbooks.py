"""Procedural memory: short, reviewed playbooks for common tasks (PLAN-18 step 6).

Playbooks live in the repo (app/prompts/playbooks/*.md) and change only through PRs with evals;
nothing here is learned or written by the model. Which playbook applies is decided in code from
the shopper's message, and the current step from the session state that code already tracks, so
neither can be steered by text in tool results.
"""

import re
from functools import cache
from pathlib import Path

from app.sessions import SessionState

MAX_ACTIVE = 2

# Priority order: a shopper asking for a person mid-return gets the handoff playbook first.
INTENTS: dict[str, re.Pattern[str]] = {
    "handoff": re.compile(
        r"\b(human|real person|a person|someone|representative|support team|speak to|talk to|"
        r"complain\w*)\b",
        re.IGNORECASE,
    ),
    "returns": re.compile(
        r"\b(return\w*|refund\w*|send (it|them) back|exchange|wrong size|doesn'?t fit)\b",
        re.IGNORECASE,
    ),
    "order_status": re.compile(
        r"\b(where('?s| is) my|track\w*|has it shipped|deliver(ed|y)|arriv\w*|order status)\b"
        r"|\bORD-\d+",
        re.IGNORECASE,
    ),
    "product_compare": re.compile(
        r"\b(compare|comparison|vs\.?|versus|difference between|which (one )?is better|"
        r"better than)\b",
        re.IGNORECASE,
    ),
}
# A playbook ends when its confirmed action succeeds; its last step covers the follow-up reply.
FINISHED_BY = {"returns": "create_return", "handoff": "create_support_ticket"}
LAST_STEP = {"returns": 5, "handoff": 4}


@cache
def text(name: str) -> str:
    return (Path(__file__).parent / "prompts" / "playbooks" / f"{name}.md").read_text(
        encoding="utf-8"
    ).strip()


def select(state: SessionState, message: str) -> None:
    """On each shopper message: the playbooks it asks for, else the unfinished ones running."""
    matched = [name for name, pattern in INTENTS.items() if pattern.search(message)]
    if "returns" in matched:  # its first steps already find and check the order
        matched = [m for m in matched if m != "order_status"]
    running = [p for p in state.playbooks if p not in state.playbooks_done]
    state.playbooks = matched[:MAX_ACTIVE] if matched else running
    state.playbooks_done = []


def finish(state: SessionState, tool: str) -> None:
    """A confirmed action completed a playbook's task: show its last step for the follow-up
    reply, then drop it on the next shopper message."""
    state.playbooks_done += [p for p in state.playbooks if FINISHED_BY.get(p) == tool]


def step(name: str, state: SessionState) -> int:
    """The step the conversation is at, from what code has seen happen (1-based)."""
    if name in state.playbooks_done:
        return LAST_STEP[name]
    pending = (state.pending_action or {}).get("tool")
    if name == "returns":
        if pending == "create_return":
            return 4
        return 2 if state.focus_order else 1
    if name == "order_status":
        return 2 if state.focus_order else 1
    if name == "product_compare":
        return 2 if len(state.focus_products) >= 2 else 1
    if name == "handoff":
        return 4 if pending == "create_support_ticket" else 1
    return 1


def render(state: SessionState) -> str:
    """The per-request prompt section, or "" when no playbook applies."""
    if not state.playbooks:
        return ""
    parts = ["## Playbook (the store's steps for this task; the rules above still apply)"]
    for name in state.playbooks:
        parts.append(f"{text(name)}\nYou are at step {step(name, state)}.")
    return "\n\n".join(parts)
