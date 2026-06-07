"""Tests for deterministic InVEST result analysis."""
from __future__ import annotations

import json
import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

try:
    import rasterio
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

from app.result_analysis import (
    check_baseline_alternate_delta_consistency,
    check_delta_internal_consistency,
    file_sha256,
    fingerprints_unchanged,
    load_analysis,
    resolve_output_role,
    save_analysis,
)

if HAS_RASTERIO:
    from app.result_analysis import (
        analyze_job_outputs,
        compute_change_statistics,
        compute_raster_statistics,
    )


def _write_geotiff(path: Path, data: np.ndarray, nodata: float | None = None,
                   crs: str = "EPSG:4326", transform=None) -> None:
    """Write a minimal single-band GeoTIFF using rasterio."""
    import rasterio
    from rasterio.transform import from_bounds

    if transform is None:
        transform = from_bounds(0, 0, 1, 1, data.shape[1], data.shape[0])
    with rasterio.open(
        str(path), "w", driver="GTiff",
        height=data.shape[0], width=data.shape[1],
        count=1, dtype=data.dtype, crs=crs, transform=transform,
        nodata=nodata,
    ) as dst:
        dst.write(data, 1)


CARBON_SCHEMA = {
    "id": "carbon",
    "outputs": [
        {
            "name": "c_storage_bas_{results_suffix}.tif",
            "type": "raster",
            "role": "baseline-carbon-storage",
            "quantity": "carbon storage",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "c_storage_alt_{results_suffix}.tif",
            "type": "raster",
            "role": "alternate-carbon-storage",
            "quantity": "carbon storage",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "delta_cur_fut_{results_suffix}.tif",
            "type": "raster",
            "role": "carbon-change",
            "quantity": "carbon change",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "npv_fut_{results_suffix}.tif",
            "type": "raster",
            "role": "valuation",
            "quantity": "net present value",
            "unit": "USD/pixel",
            "aggregation": "sum",
        },
        {
            "name": "carbon_preview.geojson",
            "type": "geojson",
        },
    ],
}


class ResolveOutputRoleTest(unittest.TestCase):
    def test_baseline_storage(self):
        result = resolve_output_role("c_storage_bas_mvp.tif", CARBON_SCHEMA)
        self.assertEqual(result["role"], "baseline-carbon-storage")
        self.assertEqual(result["unit"], "Mg C/pixel")

    def test_alternate_storage(self):
        result = resolve_output_role("c_storage_alt_mvp.tif", CARBON_SCHEMA)
        self.assertEqual(result["role"], "alternate-carbon-storage")

    def test_carbon_change(self):
        result = resolve_output_role("delta_cur_fut_mvp.tif", CARBON_SCHEMA)
        self.assertEqual(result["role"], "carbon-change")

    def test_valuation(self):
        result = resolve_output_role("npv_fut_mvp.tif", CARBON_SCHEMA)
        self.assertEqual(result["role"], "valuation")

    def test_unknown_output_is_unclassified(self):
        result = resolve_output_role("some_other.tif", CARBON_SCHEMA)
        self.assertEqual(result["role"], "unclassified")
        self.assertEqual(result["quantity"], "")


@unittest.skipUnless(HAS_RASTERIO, "rasterio not installed")
class RasterStatisticsTest(unittest.TestCase):
    def test_basic_statistics(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.tif"
            data = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
            _write_geotiff(path, data)

            stats = compute_raster_statistics(path)
            self.assertEqual(stats["validPixels"], 4)
            self.assertEqual(stats["nodataPixels"], 0)
            self.assertAlmostEqual(stats["minimum"], 1.0)
            self.assertAlmostEqual(stats["maximum"], 4.0)
            self.assertAlmostEqual(stats["mean"], 2.5)
            self.assertAlmostEqual(stats["total"], 10.0)
            self.assertAlmostEqual(stats["p05"], 1.15, places=1)
            self.assertAlmostEqual(stats["median"], 2.5)
            self.assertAlmostEqual(stats["p95"], 3.85, places=1)

    def test_nodata_excluded(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.tif"
            data = np.array([[1.0, -9999.0], [3.0, -9999.0]], dtype=np.float32)
            _write_geotiff(path, data, nodata=-9999.0)

            stats = compute_raster_statistics(path)
            self.assertEqual(stats["validPixels"], 2)
            self.assertEqual(stats["nodataPixels"], 2)
            self.assertAlmostEqual(stats["total"], 4.0)

    def test_nan_and_inf_excluded(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.tif"
            data = np.array([[1.0, float('nan')], [float('inf'), 2.0]], dtype=np.float32)
            _write_geotiff(path, data)

            stats = compute_raster_statistics(path)
            self.assertEqual(stats["validPixels"], 2)
            self.assertAlmostEqual(stats["total"], 3.0)

    def test_all_nodata_returns_null_stats(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.tif"
            data = np.full((2, 2), -9999.0, dtype=np.float32)
            _write_geotiff(path, data, nodata=-9999.0)

            stats = compute_raster_statistics(path)
            self.assertEqual(stats["validPixels"], 0)
            self.assertIsNone(stats["minimum"])
            self.assertIsNone(stats["total"])

    def test_spatial_metadata(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.tif"
            data = np.array([[1.0]], dtype=np.float32)
            _write_geotiff(path, data, crs="EPSG:32633")

            stats = compute_raster_statistics(path)
            self.assertEqual(stats["spatial"]["crs"], "EPSG:32633")
            self.assertEqual(stats["spatial"]["width"], 1)
            self.assertEqual(stats["spatial"]["height"], 1)


@unittest.skipUnless(HAS_RASTERIO, "rasterio not installed")
class ChangeStatisticsTest(unittest.TestCase):
    def test_positive_negative_zero_counts(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "delta.tif"
            data = np.array([[5.0, -3.0], [0.0, 2.0]], dtype=np.float32)
            _write_geotiff(path, data)

            stats = compute_change_statistics(path)
            self.assertEqual(stats["positivePixels"], 2)
            self.assertEqual(stats["negativePixels"], 1)
            self.assertEqual(stats["zeroPixels"], 1)
            self.assertAlmostEqual(stats["positiveTotal"], 7.0)
            self.assertAlmostEqual(stats["negativeTotal"], -3.0)
            self.assertAlmostEqual(stats["total"], 4.0)


class ConsistencyCheckTest(unittest.TestCase):
    def test_baseline_alternate_delta_passes(self):
        result = check_baseline_alternate_delta_consistency(100.0, 120.0, 20.0)
        self.assertEqual(result["status"], "passed")

    def test_baseline_alternate_delta_warning_on_mismatch(self):
        result = check_baseline_alternate_delta_consistency(100.0, 120.0, 999.0)
        self.assertEqual(result["status"], "warning")
        self.assertIn("difference", result["explanation"])

    def test_baseline_alternate_delta_not_applicable_when_missing(self):
        result = check_baseline_alternate_delta_consistency(None, 120.0, 20.0)
        self.assertEqual(result["status"], "not-applicable")

    def test_delta_internal_consistency_passes(self):
        result = check_delta_internal_consistency(50.0, -30.0, 20.0)
        self.assertEqual(result["status"], "passed")

    def test_delta_internal_consistency_warning(self):
        result = check_delta_internal_consistency(50.0, -30.0, 999.0)
        self.assertEqual(result["status"], "warning")


@unittest.skipUnless(HAS_RASTERIO, "rasterio not installed")
class AnalyzeJobOutputsTest(unittest.TestCase):
    def test_full_analysis_with_consistency_checks(self):
        with TemporaryDirectory() as td:
            outputs_dir = Path(td) / "outputs"
            outputs_dir.mkdir()
            # Baseline: 4 pixels, values [10, 20, 30, 40] = total 100
            _write_geotiff(
                outputs_dir / "c_storage_bas_mvp.tif",
                np.array([[10.0, 20.0], [30.0, 40.0]], dtype=np.float32),
            )
            # Alternate: total 120
            _write_geotiff(
                outputs_dir / "c_storage_alt_mvp.tif",
                np.array([[15.0, 25.0], [35.0, 45.0]], dtype=np.float32),
            )
            # Delta: total 20 (120 - 100)
            _write_geotiff(
                outputs_dir / "delta_cur_fut_mvp.tif",
                np.array([[5.0, 5.0], [5.0, 5.0]], dtype=np.float32),
            )

            result = analyze_job_outputs(
                outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
            )

            self.assertEqual(result["sceneId"], "scene-1")
            self.assertEqual(result["jobId"], "job-1")
            self.assertEqual(result["modelId"], "carbon")
            self.assertEqual(len(result["rasters"]), 3)
            self.assertEqual(len(result["comparisons"]), 2)
            self.assertEqual(result["warnings"], [])

            # Check fingerprints
            self.assertIn("c_storage_bas_mvp.tif", result["outputFingerprints"])

            # Check roles
            roles = {r["role"]: r for r in result["rasters"]}
            self.assertIn("baseline-carbon-storage", roles)
            self.assertIn("alternate-carbon-storage", roles)
            self.assertIn("carbon-change", roles)

            # Check consistency
            self.assertEqual(result["comparisons"][0]["status"], "passed")
            self.assertEqual(result["comparisons"][1]["status"], "passed")

    def test_corrupted_raster_produces_warning(self):
        with TemporaryDirectory() as td:
            outputs_dir = Path(td) / "outputs"
            outputs_dir.mkdir()
            # Valid raster
            _write_geotiff(
                outputs_dir / "c_storage_bas_mvp.tif",
                np.array([[1.0]], dtype=np.float32),
            )
            # Corrupted file (not a valid GeoTIFF)
            (outputs_dir / "c_storage_alt_mvp.tif").write_bytes(b"not a tiff")

            result = analyze_job_outputs(
                outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
            )
            self.assertEqual(len(result["rasters"]), 1)
            self.assertEqual(len(result["warnings"]), 1)
            self.assertIn("c_storage_alt_mvp.tif", result["warnings"][0])

    def test_all_corrupted_raises(self):
        with TemporaryDirectory() as td:
            outputs_dir = Path(td) / "outputs"
            outputs_dir.mkdir()
            (outputs_dir / "c_storage_bas_mvp.tif").write_bytes(b"not a tiff")

            with self.assertRaises(ValueError, msg="All raster outputs failed"):
                analyze_job_outputs(
                    outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
                )

    def test_no_rasters_raises(self):
        with TemporaryDirectory() as td:
            outputs_dir = Path(td) / "outputs"
            outputs_dir.mkdir()

            with self.assertRaises(ValueError, msg="No raster outputs found"):
                analyze_job_outputs(
                    outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
                )

    def test_unclassified_output(self):
        with TemporaryDirectory() as td:
            outputs_dir = Path(td) / "outputs"
            outputs_dir.mkdir()
            _write_geotiff(
                outputs_dir / "weird_output.tif",
                np.array([[1.0]], dtype=np.float32),
            )

            result = analyze_job_outputs(
                outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
            )
            self.assertEqual(result["rasters"][0]["role"], "unclassified")


@unittest.skipUnless(HAS_RASTERIO, "rasterio not installed")
class FingerprintCacheTest(unittest.TestCase):
    def test_fingerprints_unchanged_returns_true_when_cached(self):
        with TemporaryDirectory() as td:
            job_dir = Path(td)
            outputs_dir = job_dir / "outputs"
            outputs_dir.mkdir()
            _write_geotiff(
                outputs_dir / "c_storage_bas_mvp.tif",
                np.array([[1.0]], dtype=np.float32),
            )

            result = analyze_job_outputs(
                outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
            )
            save_analysis(job_dir, result)

            fingerprints = {"c_storage_bas_mvp.tif": file_sha256(outputs_dir / "c_storage_bas_mvp.tif")}
            self.assertTrue(fingerprints_unchanged(job_dir, fingerprints))

    def test_fingerprints_unchanged_returns_false_after_change(self):
        with TemporaryDirectory() as td:
            job_dir = Path(td)
            outputs_dir = job_dir / "outputs"
            outputs_dir.mkdir()
            _write_geotiff(
                outputs_dir / "c_storage_bas_mvp.tif",
                np.array([[1.0]], dtype=np.float32),
            )

            result = analyze_job_outputs(
                outputs_dir, CARBON_SCHEMA, "scene-1", "job-1", "carbon",
            )
            save_analysis(job_dir, result)

            # Modify the file
            _write_geotiff(
                outputs_dir / "c_storage_bas_mvp.tif",
                np.array([[99.0]], dtype=np.float32),
            )

            fingerprints = {"c_storage_bas_mvp.tif": file_sha256(outputs_dir / "c_storage_bas_mvp.tif")}
            self.assertFalse(fingerprints_unchanged(job_dir, fingerprints))

    def test_fingerprints_unchanged_returns_false_when_no_cache(self):
        with TemporaryDirectory() as td:
            job_dir = Path(td)
            self.assertFalse(fingerprints_unchanged(job_dir, {"a.tif": "abc"}))


class PersistenceTest(unittest.TestCase):
    def test_save_and_load_roundtrip(self):
        with TemporaryDirectory() as td:
            job_dir = Path(td)
            data = {"sceneId": "s1", "jobId": "j1", "rasters": [], "comparisons": [], "warnings": []}
            save_analysis(job_dir, data)
            loaded = load_analysis(job_dir)
            self.assertEqual(loaded, data)

    def test_load_returns_none_when_missing(self):
        with TemporaryDirectory() as td:
            self.assertIsNone(load_analysis(Path(td)))


class FingerprintTest(unittest.TestCase):
    def test_sha256_detects_content_changes(self):
        with TemporaryDirectory() as td:
            path = Path(td) / "test.bin"
            path.write_bytes(b"hello")
            first = file_sha256(path)
            path.write_bytes(b"world")
            second = file_sha256(path)
            self.assertNotEqual(first, second)
            self.assertEqual(len(first), 64)


if __name__ == "__main__":
    unittest.main()
