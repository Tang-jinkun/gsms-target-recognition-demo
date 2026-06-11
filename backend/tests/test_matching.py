import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from app.matching import (
    build_asset_fingerprints,
    changed_asset_fingerprints,
    file_sha256,
    build_model_inputs_from_bindings,
    check_code_coverage_values,
    next_snapshot_status,
    validation_snapshot_id,
)
from app.routers.matching import _score_data_hub_candidate
from invest_models.carbon import MODEL_SCHEMA as CARBON_MODEL_SCHEMA
from invest_models.habitat_quality import MODEL_SCHEMA as HABITAT_MODEL_SCHEMA
from app.llm_proxy import chat_completions_url


class MatchingFactsTest(unittest.TestCase):
    def test_openai_compatible_provider_url_is_normalized(self):
        self.assertEqual(
            chat_completions_url("https://provider.example/v1/"),
            "https://provider.example/v1/chat/completions",
        )
        self.assertEqual(
            chat_completions_url("http://localhost:11434/v1/chat/completions"),
            "http://localhost:11434/v1/chat/completions",
        )
        with self.assertRaisesRegex(ValueError, "HTTP"):
            chat_completions_url("file:///secret")

    def test_code_coverage_passes_when_table_covers_raster(self):
        result = check_code_coverage_values([1, 2, 2], ["1", "2", "3"])
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["missing_values"], [])

    def test_code_coverage_reports_missing_codes(self):
        result = check_code_coverage_values([1, 9], [1, 2, 3])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["missing_values"], ["9"])

    def test_model_schemas_expose_matching_contracts(self):
        carbon_pools = next(
            item for item in CARBON_MODEL_SCHEMA["inputs"]
            if item.get("invest_arg") == "carbon_pools_path"
        )
        threats = next(
            item for item in HABITAT_MODEL_SCHEMA["inputs"]
            if item.get("invest_arg") == "threats_table_path"
        )
        self.assertIn("lucode", carbon_pools["required_fields"])
        self.assertIn("threat", threats["required_fields"])
        self.assertTrue(CARBON_MODEL_SCHEMA["matching_relations"])
        self.assertTrue(HABITAT_MODEL_SCHEMA["matching_relations"])

    def test_data_hub_discovery_scores_required_table_fields(self):
        data_file = SimpleNamespace(
            id="pools-1",
            name="carbon_pools.csv",
            file_type="table",
            file_format="csv",
            size=128,
            crs=None,
            bounds=None,
            bounds_wgs84=None,
            folder_id="folder-1",
            folder=SimpleNamespace(name="Carbon"),
            extra_meta={
                "columns": ["lucode", "c_above", "c_below", "c_soil", "c_dead"],
                "row_count": 3,
            },
        )
        slot = next(
            item for item in CARBON_MODEL_SCHEMA["inputs"]
            if item.get("invest_arg") == "carbon_pools_path"
        )

        result = _score_data_hub_candidate(data_file, slot, None, False)

        self.assertFalse(result["rejected"])
        self.assertGreaterEqual(result["score"], 0.8)
        self.assertIn("Contains required fields", " ".join(result["reasons"]))

    def test_data_hub_discovery_rejects_wrong_type_before_recommendation(self):
        data_file = SimpleNamespace(
            id="table-1",
            name="lulc_codes.csv",
            file_type="table",
            file_format="csv",
            size=128,
            crs=None,
            bounds=None,
            bounds_wgs84=None,
            folder_id=None,
            folder=None,
            extra_meta={"columns": ["lucode"]},
        )
        slot = next(
            item for item in CARBON_MODEL_SCHEMA["inputs"]
            if item.get("invest_arg") == "lulc_bas_path"
        )

        result = _score_data_hub_candidate(data_file, slot, None, False)

        self.assertTrue(result["rejected"])
        self.assertEqual(result["score"], 0)
        self.assertIn("Expected raster", result["rejection_reasons"][0])

    def test_binding_report_converts_invest_slots_to_gsms_asset_inputs(self):
        inputs = build_model_inputs_from_bindings(
            CARBON_MODEL_SCHEMA,
            {
                "recommendedNextAction": "proceed-to-validation",
                "conflicts": [],
                "unresolvedQuestions": [],
                "bindings": [
                    {
                        "slot": "lulc_bas_path",
                        "status": "matched",
                        "selectedAssetId": "lulc-1",
                    },
                    {
                        "slot": "carbon_pools_path",
                        "status": "matched",
                        "selectedAssetId": "pools-1",
                    },
                ],
            },
            {"lulc-1": "lulc.tif", "pools-1": "carbon.csv"},
            {"calc_sequestration": False},
        )
        self.assertEqual(inputs["lulc_bas_asset_id"], "lulc.tif")
        self.assertEqual(inputs["carbon_pools_asset_id"], "carbon.csv")
        self.assertFalse(inputs["calc_sequestration"])

    def test_binding_report_rejects_assets_outside_the_scene(self):
        with self.assertRaisesRegex(ValueError, "not imported into the scene"):
            build_model_inputs_from_bindings(
                CARBON_MODEL_SCHEMA,
                {
                    "recommendedNextAction": "proceed-to-validation",
                    "conflicts": [],
                    "unresolvedQuestions": [],
                    "bindings": [
                        {
                            "slot": "lulc_bas_path",
                            "status": "matched",
                            "selectedAssetId": "outside",
                        },
                    ],
                },
                {},
            )

    def test_parameters_cannot_bypass_scene_asset_bindings(self):
        with self.assertRaisesRegex(ValueError, "Asset inputs must come from Binding Report"):
            build_model_inputs_from_bindings(
                CARBON_MODEL_SCHEMA,
                {
                    "recommendedNextAction": "proceed-to-validation",
                    "conflicts": [],
                    "unresolvedQuestions": [],
                    "bindings": [],
                },
                {},
                {"lulc_bas_asset_id": "outside.tif"},
            )

    def test_validation_snapshot_is_stable_and_input_sensitive(self):
        first = validation_snapshot_id("carbon", "scene-1", {"a": 1, "b": 2})
        reordered = validation_snapshot_id("carbon", "scene-1", {"b": 2, "a": 1})
        changed = validation_snapshot_id("carbon", "scene-1", {"a": 9, "b": 2})
        self.assertEqual(first, reordered)
        self.assertNotEqual(first, changed)

    def test_validation_snapshot_changes_with_asset_fingerprint(self):
        first = validation_snapshot_id(
            "carbon", "scene-1", {"a": 1}, {"asset-1": {"sha256": "one"}}
        )
        changed = validation_snapshot_id(
            "carbon", "scene-1", {"a": 1}, {"asset-1": {"sha256": "two"}}
        )
        self.assertNotEqual(first, changed)

    def test_file_sha256_detects_content_changes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "data.csv"
            path.write_text("one", encoding="utf-8")
            first = file_sha256(path)
            path.write_text("two", encoding="utf-8")
            self.assertNotEqual(first, file_sha256(path))

    def test_asset_fingerprint_check_detects_changed_selected_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "lulc.tif"
            path.write_bytes(b"original")
            data_file = SimpleNamespace(id="lulc-1", path="lulc.tif")
            report = {
                "bindings": [
                    {
                        "status": "matched",
                        "selectedAssetId": "lulc-1",
                    }
                ]
            }
            with patch("app.matching.project_files_dir", return_value=root):
                fingerprints = build_asset_fingerprints(report, {"lulc-1": data_file})
                self.assertEqual(
                    changed_asset_fingerprints(fingerprints, {"lulc-1": data_file}),
                    [],
                )
                path.write_bytes(b"modified")
                self.assertEqual(
                    changed_asset_fingerprints(fingerprints, {"lulc-1": data_file}),
                    ["lulc-1"],
                )

    def test_snapshot_state_machine_requires_confirmation_before_consuming(self):
        with self.assertRaisesRegex(ValueError, "Only a confirmed"):
            next_snapshot_status("awaiting_confirmation", "consume", True)
        self.assertEqual(
            next_snapshot_status("awaiting_confirmation", "confirm", True),
            "confirmed",
        )
        self.assertEqual(next_snapshot_status("confirmed", "consume", True), "consumed")

    def test_snapshot_state_machine_blocks_failed_and_rejected_snapshots(self):
        with self.assertRaisesRegex(ValueError, "failed validation"):
            next_snapshot_status("validation_failed", "confirm", False)
        with self.assertRaisesRegex(ValueError, "rejected"):
            next_snapshot_status("rejected", "confirm", True)
        self.assertEqual(
            next_snapshot_status("confirmed", "invalidate", True),
            "invalidated",
        )
        with self.assertRaisesRegex(ValueError, "invalidated"):
            next_snapshot_status("invalidated", "confirm", True)


if __name__ == "__main__":
    unittest.main()
