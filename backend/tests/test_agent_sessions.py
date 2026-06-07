import unittest

from app.agent_sessions import (
    consume_confirmation_status,
    next_confirmation_status,
    next_session_status,
)


class AgentSessionStateTest(unittest.TestCase):
    def test_message_queue_and_worker_lifecycle(self):
        self.assertEqual(next_session_status("idle", "enqueue_message"), "queued")
        self.assertEqual(next_session_status("queued", "start"), "running")
        self.assertEqual(next_session_status("running", "complete"), "idle")

    def test_busy_session_rejects_another_user_message(self):
        for status in ("queued", "running", "awaiting_confirmation"):
            with self.assertRaisesRegex(ValueError, "busy"):
                next_session_status(status, "enqueue_message")

    def test_confirmation_pauses_and_resumes_session(self):
        self.assertEqual(
            next_session_status("running", "request_confirmation"),
            "awaiting_confirmation",
        )
        self.assertEqual(
            next_session_status("awaiting_confirmation", "pause"),
            "awaiting_confirmation",
        )
        self.assertEqual(
            next_confirmation_status("pending", True),
            "approved",
        )
        self.assertEqual(
            next_session_status("awaiting_confirmation", "approve_confirmation"),
            "queued",
        )

    def test_rejected_confirmation_returns_session_to_idle(self):
        self.assertEqual(next_confirmation_status("pending", False), "rejected")
        self.assertEqual(
            next_session_status("awaiting_confirmation", "reject_confirmation"),
            "idle",
        )

    def test_confirmation_cannot_be_resolved_twice(self):
        with self.assertRaisesRegex(ValueError, "already resolved"):
            next_confirmation_status("approved", True)

    def test_only_approved_confirmation_can_be_consumed(self):
        self.assertEqual(consume_confirmation_status("approved"), "consumed")
        with self.assertRaisesRegex(ValueError, "approved"):
            consume_confirmation_status("pending")


if __name__ == "__main__":
    unittest.main()
