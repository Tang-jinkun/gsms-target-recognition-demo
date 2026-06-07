"""Helpers for forwarding OpenAI-compatible requests without exposing provider secrets."""
from __future__ import annotations

from urllib.parse import urlparse


def chat_completions_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Default LLM Provider must use a valid HTTP(S) Base URL.")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"
