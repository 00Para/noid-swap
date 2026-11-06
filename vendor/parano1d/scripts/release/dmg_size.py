#!/usr/bin/env python3
"""Size a DMG from file lengths, including sparse files and hard links."""

import os
from pathlib import Path
import sys

MIB = 1024 * 1024


def image_size_mib(root: Path) -> int:
    if not root.is_dir():
        raise ValueError(f"DMG source directory is missing: {root}")
    payload = 0
    for directory, _, files in os.walk(root, followlinks=False):
        for name in files:
            payload += (Path(directory) / name).lstat().st_size
    # Leave room for filesystem metadata and allocation rounding.
    required = payload + (payload + 3) // 4 + 64 * MIB
    return max(256, (required + MIB - 1) // MIB)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: dmg_size.py SOURCE_DIR")
    print(image_size_mib(Path(sys.argv[1])))
