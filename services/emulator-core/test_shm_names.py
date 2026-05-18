"""POSIX shared-memory name length constraints (macOS shm_open limit)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CORE_PATH = ROOT / "core.py"


def _load_core_module():
    spec = importlib.util.spec_from_file_location("emulator_core", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec from {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ShmNameTests(unittest.TestCase):
    def test_unique_shm_name_within_posix_limit(self) -> None:
        module = _load_core_module()
        for _ in range(32):
            name = module._unique_shm_name("pdi")
            self.assertLessEqual(len(name) + 1, module._POSIX_SHM_NAME_MAX)
            self.assertRegex(name, r"^pdi_[0-9a-f]+$")


if __name__ == "__main__":
    unittest.main()
