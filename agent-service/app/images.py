"""Photos in chat (PLAN-20): check and clean an upload, and turn the fast model's description
of it into data for the main model.

The main model (deepseek-v4-pro) can't see images, so `LLM.describe_image` asks the fast model to
describe the photo, and the loop adds that description to the shopper's message, wrapped in
`<image_description>` like a tool result. The photo itself is never stored, logged or sent again:
only the masked description stays in the conversation.
"""

import base64
import binascii
import io
import json
import re
from typing import Any, Literal

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.config import Settings
from app.guardrails import strip_html
from app.masking import mask

MediaType = Literal["image/jpeg", "image/png", "image/webp"]
Quality = Literal["ok", "blurry", "dark", "cropped", "unclear"]
QUALITIES: tuple[str, ...] = ("ok", "blurry", "dark", "cropped", "unclear")

# Base64 of the largest upload any setting allows; `prepare_image` checks the real limit.
MAX_BASE64_CHARS = 8_000_000

UNREADABLE = "The photo couldn't be read. Ask the shopper to describe it in words or try again."


class ImageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mediaType: MediaType
    data: str = Field(min_length=1, max_length=MAX_BASE64_CHARS)


def _sniff(raw: bytes) -> MediaType | None:
    """The type the bytes really are, from their first bytes, whatever the upload claims."""
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def prepare_image(image: ImageIn, settings: Settings) -> bytes:
    """Decode, check and re-encode an upload as a metadata-free JPEG no longer than
    `image_long_edge` on its long side. Re-encoding drops EXIF (location) and anything hidden in
    the file, and a file that only claims to be an image fails to decode. CPU work: call it in a
    thread. Raises HTTPException with a message for the shopper."""
    try:
        raw = base64.b64decode(image.data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(422, "That photo couldn't be read. Please try another one.") from exc
    if len(raw) > settings.image_max_bytes:
        mb = settings.image_max_bytes / 1_000_000
        raise HTTPException(413, f"Photos can be up to {mb:g} MB. Please send a smaller one.")
    if _sniff(raw) != image.mediaType:
        raise HTTPException(415, "Please send a JPEG, PNG or WebP photo.")
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.width * img.height > settings.image_max_pixels:
                raise HTTPException(413, "That photo is too large. Please send a smaller one.")
            img.load()
            clean = ImageOps.exif_transpose(img).convert("RGB")
    except HTTPException:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise HTTPException(415, "That photo couldn't be read. Please try another one.") from exc
    edge = settings.image_long_edge
    clean.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    clean.save(out, "JPEG", quality=85)
    return out.getvalue()


class ImageDescription(BaseModel):
    """What the fast model returns (app/prompts/image_describe.md). Long fields are cut, not
    rejected: a long receipt is still worth reading."""

    summary: str = ""
    visible_text: str = ""
    items: list[str] = Field(default_factory=list)
    condition: str = ""
    quality: Quality = "ok"

    @field_validator("summary", "condition", mode="before")
    @classmethod
    def _short(cls, value: Any) -> Any:
        return value[:500] if isinstance(value, str) else value

    @field_validator("visible_text", mode="before")
    @classmethod
    def _text(cls, value: Any) -> Any:
        return value[:2000] if isinstance(value, str) else value

    @field_validator("items", mode="before")
    @classmethod
    def _items(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        return [str(v)[:200] for v in value[:10]]

    @field_validator("quality", mode="before")
    @classmethod
    def _quality(cls, value: Any) -> str:
        """An unknown rating keeps the description but marks it unclear."""
        value = value.strip().lower() if isinstance(value, str) else ""
        return value if value in QUALITIES else "unclear"


def parse_description(text: str) -> ImageDescription | None:
    """The description in the fast model's reply (a ```json fence is fine); None if the reply
    isn't one."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return ImageDescription.model_validate(json.loads(m[0]))
    except (json.JSONDecodeError, ValidationError):
        return None


def wrap_image_description(desc: ImageDescription | None) -> str:
    """The description as data for the main model. Tags are stripped first, so text in the photo
    can't close the wrapper, and card numbers, emails and phone numbers are masked."""
    body: dict[str, Any] = (
        mask(strip_html(desc.model_dump())) if desc is not None else {"error": UNREADABLE}
    )
    text = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return f"<image_description>\n{text}\n</image_description>"
