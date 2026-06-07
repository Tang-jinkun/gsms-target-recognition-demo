"""Create persistent Docker secrets without replacing existing values."""
from __future__ import annotations

import base64
import secrets
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"


def existing_values(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def main() -> None:
    current = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    values = existing_values(current)
    defaults = {
        "GSMS_FERNET_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
        "GSMS_AGENT_PROXY_TOKEN": secrets.token_urlsafe(48),
        "GSMS_BACKEND_BIND": "127.0.0.1",
        "GSMS_BACKEND_PORT": "8000",
        "GSMS_FRONTEND_BIND": "0.0.0.0",
        "GSMS_FRONTEND_PORT": "3000",
    }
    additions: list[str] = []
    for key, value in defaults.items():
        if not values.get(key):
            additions.append(f"{key}={value}")
    if not additions:
        print(f"Using existing {ENV_PATH}")
        return
    prefix = current.rstrip()
    content = f"{prefix}\n" if prefix else ""
    content += "\n".join(additions) + "\n"
    ENV_PATH.write_text(content, encoding="utf-8")
    print(f"Initialized persistent Docker configuration in {ENV_PATH}")


if __name__ == "__main__":
    main()
