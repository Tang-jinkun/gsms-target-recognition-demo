"""Convert the target-recognition demo CSV fixtures into GeoJSON."""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path


def convert(source: Path, destination: Path) -> dict:
    features = []
    with source.open("r", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            properties = dict(row)
            longitude = float(properties.pop("longitude"))
            latitude = float(properties.pop("latitude"))
            properties["measured_value"] = float(properties["measured_value"])
            features.append({
                "type": "Feature",
                "geometry": {"type": properties.pop("geometry_type"), "coordinates": [longitude, latitude]},
                "properties": properties,
            })
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "filename": destination.name,
        "total": len(features),
        "waterlogging": sum(feature["properties"]["point_type"] == "积水点" for feature in features),
    }


def main() -> None:
    source_dir = Path(sys.argv[1])
    destination_dir = Path(sys.argv[2])
    summary = [
        convert(source, destination_dir / source.with_suffix(".geojson").name)
        for source in sorted(source_dir.glob("urban_flood_points_*.csv"))
    ]
    (destination_dir / "expected-statistics.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
