"""VR作品フォルダ（data.js がある場所）を返す。"""
from __future__ import annotations

import os
from pathlib import Path


def _has_project_markers(base: Path) -> bool:
    return (base / "data.js").is_file() and (
        (base / "viewer.html").is_file() or (base / "map.html").is_file()
    )


def project_root() -> Path:
    """起動.vbs が渡す VR_PROJECT_ROOT を最優先（別作品フォルダへの誤保存を防ぐ）。"""
    env_root = os.environ.get("VR_PROJECT_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root).resolve()
        if _has_project_markers(candidate):
            return candidate

    tools_dir = Path(__file__).resolve().parent
    for base in (tools_dir.parent, tools_dir.parent.parent):
        if _has_project_markers(base):
            return base
    if (tools_dir.parent / "data.js").is_file():
        return tools_dir.parent
    return tools_dir.parent


def kit_dir() -> Path:
    """VRガイド動画用フォルダ（この vr_project.py と同じ場所）。"""
    return Path(__file__).resolve().parent
