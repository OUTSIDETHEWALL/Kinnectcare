"""Validate the deployed model without importing server startup or a database."""
import ast
from pathlib import Path
from typing import Optional

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError


def snapshot_model():
    tree = ast.parse((Path(__file__).parents[1] / "server.py").read_text())
    node = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "DeviceSnapshotUpdate"
    )
    scope = {"BaseModel": BaseModel, "ConfigDict": ConfigDict, "Optional": Optional}
    exec(compile(ast.Module(body=[node], type_ignores=[]), "server.py", "exec"), scope)
    return scope["DeviceSnapshotUpdate"]


@pytest.mark.parametrize("mode", ["0", "1", None, "location-and-geofences"])
def test_stringified_native_tracking_mode_satisfies_deployed_contract(mode):
    assert snapshot_model()(sdk_tracking_mode=mode).sdk_tracking_mode == mode


def test_raw_numeric_mode_explains_original_validation_failure():
    with pytest.raises(ValidationError) as caught:
        snapshot_model()(sdk_tracking_mode=1)
    assert caught.value.errors()[0]["loc"] == ("sdk_tracking_mode",)
