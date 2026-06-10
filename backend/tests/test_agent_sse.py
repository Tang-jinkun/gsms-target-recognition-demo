import unittest

from app.routers.agent import _format_sse_event, _resolve_sse_cursor


class FormatSseEventTest(unittest.TestCase):
    def test_frame_has_id_event_and_json_data(self):
        frame = _format_sse_event({
            "id": 42,
            "type": "tool.started",
            "data": {"tool": "invest_carbon", "tool_call_id": "tc_1"},
        })
        self.assertEqual(
            frame,
            'id: 42\nevent: tool.started\n'
            'data: {"tool": "invest_carbon", "tool_call_id": "tc_1"}\n\n',
        )

    def test_frame_terminates_with_blank_line(self):
        frame = _format_sse_event({"id": 1, "type": "x", "data": {}})
        self.assertTrue(frame.endswith("\n\n"))

    def test_non_ascii_payload_is_preserved(self):
        frame = _format_sse_event({
            "id": 7,
            "type": "model.streaming",
            "data": {"text": "分析中"},
        })
        self.assertIn("分析中", frame)
        self.assertNotIn("\\u", frame)

    def test_data_is_single_line(self):
        # Newlines inside the JSON would break the SSE frame boundary.
        frame = _format_sse_event({
            "id": 3,
            "type": "model.streaming",
            "data": {"text": "line one\nline two"},
        })
        data_line = next(l for l in frame.splitlines() if l.startswith("data: "))
        self.assertIn("\\n", data_line)


class ResolveSseCursorTest(unittest.TestCase):
    def test_header_takes_precedence_over_query(self):
        self.assertEqual(_resolve_sse_cursor("99", 5), 99)

    def test_query_used_when_no_header(self):
        self.assertEqual(_resolve_sse_cursor(None, 5), 5)

    def test_falls_back_to_query_on_malformed_header(self):
        self.assertEqual(_resolve_sse_cursor("not-a-number", 5), 5)

    def test_zero_default_when_neither_supplied(self):
        self.assertEqual(_resolve_sse_cursor(None, 0), 0)


if __name__ == "__main__":
    unittest.main()
