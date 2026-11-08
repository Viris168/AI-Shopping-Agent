"""Hide personal data before anything reaches logs, traces or transcripts."""

import logging
import re
from typing import Any

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+"), "[jwt]"),
    (re.compile(r"\bsk-ant-[\w-]+"), "[api-key]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[email]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[card]"),
]
_PHONE = re.compile(r"\+?\d[\d ().-]{7,}\d")
_SECRET_KEYS = re.compile(r"authorization|password|token|secret|api[_-]?key", re.I)


def mask_text(text: str) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    # Phone-like runs: 9+ digits, so dates (2026-11-08) and order numbers survive.
    return _PHONE.sub(lambda m: "[phone]" if sum(c.isdigit() for c in m[0]) >= 9 else m[0], text)


def mask(value: Any) -> Any:
    """Recursively mask strings and redact secret-looking keys."""
    if isinstance(value, str):
        return mask_text(value)
    if isinstance(value, dict):
        return {
            k: "[redacted]" if isinstance(k, str) and _SECRET_KEYS.search(k) else mask(v)
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return [mask(v) for v in value]
    return value


class MaskingFilter(logging.Filter):
    """Attach to handlers so formatted log lines never carry personal data."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = mask_text(record.getMessage())
        record.args = None
        return True
