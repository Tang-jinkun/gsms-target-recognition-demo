import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.job_inputs import file_sha256, freeze_snapshot_inputs, verify_input_manifest


class FrozenJobInputsTest(unittest.TestCase):
    def test_freezes_inputs_rewrites_paths_and_writes_verifiable_manifest(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            project_files = root / "project-files"
            job_dir = root / "job"
            project_files.mkdir()
            source = project_files / "lulc.tif"
            source.write_bytes(b"validated-data")
            fingerprints = {
                "asset-1": {
                    "path": "lulc.tif",
                    "size": source.stat().st_size,
                    "sha256": file_sha256(source),
                }
            }
            inputs, manifest = freeze_snapshot_inputs(
                job_dir,
                project_files,
                {"lulc_bas_asset_id": "lulc.tif", "calc_sequestration": False},
                fingerprints,
            )

            self.assertEqual(inputs["lulc_bas_asset_id"], "lulc.tif")
            self.assertEqual((job_dir / "inputs" / "lulc.tif").read_bytes(), b"validated-data")
            (job_dir / "input-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            verify_input_manifest(manifest, job_dir / "inputs")

    def test_runner_rejects_modified_frozen_input(self):
        with TemporaryDirectory() as directory:
            job_dir = Path(directory)
            inputs_dir = job_dir / "inputs"
            inputs_dir.mkdir()
            frozen = inputs_dir / "carbon.csv"
            frozen.write_bytes(b"original")
            manifest = {
                "assets": [
                    {
                        "asset_id": "asset-1",
                        "frozen_path": "inputs/carbon.csv",
                        "sha256": file_sha256(frozen),
                    }
                ]
            }
            (job_dir / "input-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            frozen.chmod(0o666)
            frozen.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                verify_input_manifest(manifest, inputs_dir)

    def test_freeze_failure_removes_partial_inputs(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            project_files = root / "project-files"
            job_dir = root / "job"
            project_files.mkdir()
            source = project_files / "carbon.csv"
            source.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "changed before freezing"):
                freeze_snapshot_inputs(
                    job_dir,
                    project_files,
                    {"carbon_pools_asset_id": "carbon.csv"},
                    {
                        "asset-1": {
                            "path": "carbon.csv",
                            "size": source.stat().st_size,
                            "sha256": "not-the-current-hash",
                        }
                    },
                )
            self.assertFalse((job_dir / "inputs").exists())


if __name__ == "__main__":
    unittest.main()
