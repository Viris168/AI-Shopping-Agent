"""Can the fast model describe shopper photos? (PLAN-20 M0)

    python -m evals.image_fixtures                    # once: draw the test images
    python -m evals.image_probe                       # all fixtures on MODEL_FAST
    python -m evals.image_probe --only blurry.png     # one image
    python -m evals.image_probe --dir ~/photos        # your own photos too (graded by hand)
    python -m evals.image_probe --check-main          # also confirm MODEL_MAIN can't see images

Sends each image with the describe prompt (`app/prompts/image_describe.md`) straight to the model,
with no commerce-api or agent loop. Prints, per image: whether the reply is valid JSON, the
automatic checks from `evals.image_fixtures.FIXTURES`, image tokens, latency and cost. The full
replies go to `evals/results/image-probe-*.json` for grading by hand.

Image tokens are input tokens minus a text-only call with the same prompt; if they come out near
zero the model didn't see the image (DeepSeek's v4-pro swaps images for "[Unsupported Image]").
Costs one flash call per image, plus one baseline call.
"""

import argparse
import asyncio
import base64
import json
import re
import statistics
import sys
import time
from importlib import resources
from pathlib import Path
from typing import Any, cast

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam

from app.config import Settings, get_settings
from app.llm import NO_THINKING
from app.usage import estimate_cost
from evals.image_fixtures import FIXTURES, OUT_DIR, Fixture

RESULTS_DIR = Path(__file__).parent / "results"
MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".webp": "image/webp"}
ASK = "Describe this image."
QUALITIES = {"ok", "blurry", "dark", "cropped", "unclear"}
# Fewer image tokens than this means the image probably wasn't seen.
MIN_IMAGE_TOKENS = 50


def describe_prompt() -> str:
    return (resources.files("app") / "prompts" / "image_describe.md").read_text(encoding="utf-8")


def parse_reply(text: str) -> dict[str, Any] | None:
    """The JSON object in the reply, allowing a ```json fence; None if there isn't one."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m[0])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def grade(fx: Fixture | None, data: dict[str, Any] | None) -> list[str]:
    """Failed checks; empty means pass. Photos without a fixture only get the shape checks."""
    if data is None:
        return ["not JSON"]
    fails = []
    for key in ("summary", "visible_text", "items", "condition", "quality"):
        if key not in data:
            fails.append(f"missing {key}")
    quality = str(data.get("quality", "")).strip().lower()
    if quality not in QUALITIES:
        fails.append(f"quality {quality!r} not allowed")
    if fx is None:
        return fails
    if quality not in fx.quality:
        fails.append(f"quality {quality!r}, want {'/'.join(fx.quality)}")
    seen = str(data.get("visible_text", "")).lower()
    fails += [f"text missing {t!r}" for t in fx.text if t.lower() not in seen]
    if fx.mentions:
        about = " ".join(str(data.get(k, "")) for k in ("summary", "items", "condition")).lower()
        if not any(w in about for w in fx.mentions):
            fails.append(f"mentions none of {', '.join(fx.mentions)}")
    if fx.damaged:
        condition = str(data.get("condition", "")).lower()
        if "no visible damage" in condition or "not applicable" in condition:
            fails.append("damage missed")
    return fails


async def call(client: AsyncAnthropic, model: str, system: str,
               image: tuple[str, bytes] | None) -> tuple[str, Any, float]:
    content: list[dict[str, Any]] = []
    if image:
        media_type, raw = image
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": media_type, "data": base64.b64encode(raw).decode(),
        }})
    content.append({"type": "text", "text": ASK})
    start = time.perf_counter()
    resp = await client.messages.create(
        model=model, max_tokens=700, system=system, thinking=NO_THINKING,
        messages=cast(list[MessageParam], [{"role": "user", "content": content}]),
    )
    took = time.perf_counter() - start
    text = "".join(b.text for b in resp.content if b.type == "text")
    return text, resp.usage, took


def collect(only: str | None, extra: Path | None) -> list[tuple[Path, Fixture | None]]:
    items: list[tuple[Path, Fixture | None]] = []
    for fx in FIXTURES:
        path = OUT_DIR / fx.name
        if not path.exists():
            sys.exit(f"{path} missing; run `python -m evals.image_fixtures` first")
        items.append((path, fx))
    if extra:
        items += [(p, None) for p in sorted(extra.expanduser().iterdir())
                  if p.suffix.lower() in MEDIA_TYPES]
    if only:
        items = [(p, fx) for p, fx in items if p.name == only]
        if not items:
            sys.exit(f"no image named {only}")
    return items


async def probe(settings: Settings, model: str, items: list[tuple[Path, Fixture | None]],
                concurrency: int) -> dict[str, Any]:
    key = settings.anthropic_api_key
    client = AsyncAnthropic(
        api_key=key.get_secret_value() if key else None,
        base_url=settings.anthropic_base_url or None,
        timeout=settings.model_timeout_s, max_retries=2,
    )
    system = describe_prompt()
    price = settings.model_prices.get(model)
    _, base_usage, _ = await call(client, model, system, None)
    baseline = base_usage.input_tokens + (base_usage.cache_read_input_tokens or 0)
    gate = asyncio.Semaphore(concurrency)

    async def one(path: Path, fx: Fixture | None) -> dict[str, Any]:
        raw = await asyncio.to_thread(path.read_bytes)
        async with gate:
            try:
                text, u, took = await call(
                    client, model, system, (MEDIA_TYPES[path.suffix.lower()], raw)
                )
            except Exception as exc:  # report the failure, keep probing the rest
                return {"image": path.name, "error": f"{type(exc).__name__}: {exc}"}
        data = parse_reply(text)
        total_in = u.input_tokens + (u.cache_read_input_tokens or 0)
        fails = grade(fx, data)
        if total_in - baseline < MIN_IMAGE_TOKENS:
            fails.insert(0, "image not seen")
        return {
            "image": path.name, "bytes": len(raw), "fixture": fx is not None,
            "note": fx.note if fx else "your photo: grade by hand",
            "pass": not fails, "fails": fails,
            "image_tokens": total_in - baseline, "input_tokens": u.input_tokens,
            "cache_read": u.cache_read_input_tokens or 0, "output_tokens": u.output_tokens,
            "latency_s": round(took, 2),
            "cost_usd": estimate_cost(price, u.input_tokens, u.cache_read_input_tokens or 0,
                                      u.output_tokens),
            "reply": data if data is not None else text,
        }

    rows = await asyncio.gather(*(one(p, fx) for p, fx in items))
    ok = [r for r in rows if "error" not in r]
    costs = [r["cost_usd"] for r in ok if r["cost_usd"] is not None]
    return {
        "model": model, "prompt_tokens": baseline, "results": rows,
        "summary": {
            "images": len(rows), "errors": len(rows) - len(ok),
            "fixtures_passed": sum(r["pass"] for r in ok if r["fixture"]),
            "fixtures": sum(1 for _, fx in items if fx),
            "image_tokens_median": statistics.median(r["image_tokens"] for r in ok) if ok else None,
            "latency_s_median": statistics.median(r["latency_s"] for r in ok) if ok else None,
            "latency_s_max": max((r["latency_s"] for r in ok), default=None),
            "cost_usd_per_image": statistics.mean(costs) if costs else None,
        },
    }


def show(report: dict[str, Any]) -> None:
    print(f"\n{report['model']} · describe prompt {report['prompt_tokens']} tokens")
    print(f"{'image':28} {'result':6} {'img tok':>7} {'out':>5} {'sec':>5}  notes")
    for r in report["results"]:
        if "error" in r:
            print(f"{r['image']:28} {'ERROR':6} {'':>7} {'':>5} {'':>5}  {r['error'][:90]}")
            continue
        result = ("pass" if r["pass"] else "FAIL") if r["fixture"] else "check"
        notes = "; ".join(r["fails"]) or r["note"]
        print(f"{r['image']:28} {result:6} {r['image_tokens']:>7} {r['output_tokens']:>5} "
              f"{r['latency_s']:>5.1f}  {notes}")
    s = report["summary"]
    cost = f"${s['cost_usd_per_image']:.5f}" if s["cost_usd_per_image"] is not None else "n/a"
    print(f"\n{s['fixtures_passed']}/{s['fixtures']} fixtures passed · {s['errors']} errors · "
          f"median {s['image_tokens_median']} image tokens · median {s['latency_s_median']} s "
          f"(max {s['latency_s_max']} s) · {cost} per image")


async def check_main(settings: Settings) -> None:
    """One call on MODEL_MAIN with a clear screenshot: does it see the image?"""
    fx = next(f for f in FIXTURES if f.name == "order_shipped.png")
    report = await probe(settings, settings.model_main, [(OUT_DIR / fx.name, fx)], 1)
    row = report["results"][0]
    seen = "error" not in row and "image not seen" not in row["fails"]
    print(f"\n{settings.model_main}: {'sees images' if seen else 'does NOT see images'} "
          f"({row.get('error') or str(row['image_tokens']) + ' image tokens'})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", help="default: MODEL_FAST")
    ap.add_argument("--only", help="one image by file name")
    ap.add_argument("--dir", type=Path, help="also describe the photos in this folder")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--check-main", action="store_true", help="also try one image on MODEL_MAIN")
    ap.add_argument("--label", default="run")
    args = ap.parse_args()
    settings = get_settings()
    model = args.model or settings.model_fast
    report = asyncio.run(probe(settings, model, collect(args.only, args.dir), args.concurrency))
    show(report)
    if args.check_main:
        asyncio.run(check_main(settings))
    RESULTS_DIR.mkdir(exist_ok=True)
    out = RESULTS_DIR / f"image-probe-{args.label}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"full replies: {out}")


if __name__ == "__main__":
    main()
