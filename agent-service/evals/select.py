"""Which eval cases a change needs (PLAN-19 M3): `python -m evals.run --changed`.

A changed case file runs that file. A changed tool runs the case files for its area. Anything else
the agent sees or does (prompt, loop, model config, harness, seed data) runs the smoke set, since
it can affect every area. Docs, tests and other services run nothing.
"""

import subprocess
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from evals.cases import Suite

# app/tools/<module>.py → case files per suite. registry.py and __init__.py fall back to smoke.
TOOL_FILES: dict[str, dict[Suite, set[str]]] = {
    "cart": {"golden": {"cart", "coupons", "checkout", "guest"}, "redteam": {"money", "confirm"}},
    "catalog": {"golden": {"catalog"}, "redteam": {"planted", "injection", "facts"}},
    "faq": {"golden": {"faq"}, "redteam": {"planted", "injection"}},
    "orders": {"golden": {"orders", "returns"}, "redteam": {"access", "confirm"}},
    "support": {"golden": {"support"}, "redteam": {"confirm"}},
    "memory": {"golden": {"memory"}, "redteam": {"memory"}},
}
# Other single-area modules, by path from the repo root.
MODULE_FILES: dict[str, dict[Suite, set[str]]] = {
    "agent-service/app/memory.py": TOOL_FILES["memory"],
}
# Everything else that changes what the agent sees or does (same scope as CI's eval trigger).
SMOKE_PREFIXES = (
    "agent-service/app/",
    "agent-service/evals/",
    "agent-service/pyproject.toml",
    "commerce-api/src/database/seed",
)
NO_EFFECT = {"agent-service/evals/README.md"}


@dataclass
class Selection:
    files: set[str] = field(default_factory=set)
    smoke: bool = False
    reasons: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.files and not self.smoke


def select(suite: Suite, paths: list[str]) -> Selection:
    """Case files (and whether to add the smoke set) for `suite`, from repo-relative paths."""
    sel = Selection()
    for raw in sorted(set(paths)):
        path = PurePosixPath(raw)
        parts = path.parts
        if parts[:2] == ("agent-service", "evals") and path.suffix == ".yaml":
            if len(parts) == 4 and parts[2] == suite:
                sel.files.add(path.stem)
                sel.reasons.append(f"{raw} → {path.stem}")
            continue  # the other suite's cases
        if parts[:3] == ("agent-service", "app", "tools") and path.stem in TOOL_FILES:
            files = TOOL_FILES[path.stem][suite]
        elif raw in MODULE_FILES:
            files = MODULE_FILES[raw][suite]
        elif raw.startswith(SMOKE_PREFIXES) and raw not in NO_EFFECT:
            sel.smoke = True
            sel.reasons.append(f"{raw} → smoke")
            continue
        else:
            continue
        sel.files |= files
        sel.reasons.append(f"{raw} → {', '.join(sorted(files))}")
    return sel


def _git(*args: str) -> list[str]:
    # Fixed git subcommands; BASE is the developer's own --changed argument.
    out = subprocess.run(  # noqa: S603
        ["git", *args], capture_output=True, text=True, check=True  # noqa: S607
    ).stdout
    return [line for line in out.splitlines() if line]


def changed_paths(base: str) -> list[str]:
    """Repo-relative paths changed since the merge base with `base`: commits, staged and
    unstaged edits, and new untracked files."""
    merge_base = _git("merge-base", "HEAD", base)[0]
    return _git("diff", "--name-only", merge_base) + _git(
        "ls-files", "--others", "--exclude-standard", "--full-name",
        "--", ":/",  # whole repo, whatever the working directory
    )
