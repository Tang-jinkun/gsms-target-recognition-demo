"""Deterministic state transitions for persisted Agent sessions."""
from __future__ import annotations


def next_session_status(current: str, action: str) -> str:
    if action == "enqueue_message":
        if current in {"queued", "running", "awaiting_confirmation"}:
            raise ValueError(f"Agent session is busy: {current}")
        return "queued"
    if action == "start":
        if current != "queued":
            raise ValueError("Only a queued Agent session can start.")
        return "running"
    if action == "request_confirmation":
        if current not in {"queued", "running"}:
            raise ValueError("Only an active Agent session can request confirmation.")
        return "awaiting_confirmation"
    if action == "approve_confirmation":
        if current != "awaiting_confirmation":
            raise ValueError("Agent session is not awaiting confirmation.")
        return "queued"
    if action == "reject_confirmation":
        if current != "awaiting_confirmation":
            raise ValueError("Agent session is not awaiting confirmation.")
        return "idle"
    if action == "complete":
        if current not in {"queued", "running"}:
            raise ValueError("Only an active Agent session can complete.")
        return "idle"
    if action == "fail":
        return "failed"
    raise ValueError(f"Unknown Agent session action: {action}")


def next_confirmation_status(current: str, approved: bool) -> str:
    if current != "pending":
        raise ValueError(f"Agent confirmation is already resolved: {current}")
    return "approved" if approved else "rejected"


def consume_confirmation_status(current: str) -> str:
    if current != "approved":
        raise ValueError(f"Only an approved Agent confirmation can be consumed: {current}")
    return "consumed"
