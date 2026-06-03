"""API Key encryption using Fernet symmetric encryption.

Key is taken from the FERNET_KEY environment variable (base64-urlsafe, 32 bytes
encoded). If absent, a per-process ephemeral key is generated and a warning is
logged — data survives the request but NOT restarts. Set FERNET_KEY in
production.
"""
import base64
import logging
import os

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        raw = os.environ.get("FERNET_KEY", "").strip()
        if raw:
            _fernet = Fernet(raw.encode())
        else:
            key = Fernet.generate_key()
            _fernet = Fernet(key)
            logger.warning(
                "FERNET_KEY not set — using ephemeral key. "
                "API keys will be lost on restart. Set FERNET_KEY in production."
            )
    return _fernet


def encrypt(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    return _get_fernet().decrypt(token.encode()).decode()


def mask(plaintext: str) -> str:
    """Return last-4-chars masked string for display."""
    if len(plaintext) <= 4:
        return "****"
    return "****" + plaintext[-4:]
