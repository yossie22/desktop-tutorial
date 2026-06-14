# -*- coding: utf-8 -*-
"""VR動画ホットスポット配置ツール用の簡易サーバー（data.js の読込・保存）"""
from __future__ import annotations

import json
import os
import base64
import re
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, unquote, urlparse

from vr_project import kit_dir, project_root

ROOT = project_root()
KIT = kit_dir()  # VRガイド動画用（モデル貼り付け用.html がある場所）
if not (ROOT / "data.js").is_file():
    raise FileNotFoundError("data.js が見つかりません: " + str(ROOT))
PORT = 8765
PREVIEW_BY_SCENE: dict[str, dict] = {}


def sanitize_preview_hotspot(hotspot: dict) -> dict:
    """cc003 等は canvasBlackKey なし＝GitHub と同じ lighten。プレビューに残った黒抜き設定を除去。"""
    h = dict(hotspot)
    if not h.get("canvasBlackKey"):
        for k in ("canvasBlackKey", "blackKeyThreshold", "blackKeySoft"):
            h.pop(k, None)
    return h
PLACER_HTML = "モデル貼り付け用.html"
SHADOW_HTML = "影設定.html"
EOS_SHADOW_HTML = "EOS影設定.html"
PLACER_URL = "http://127.0.0.1:%d/placer" % PORT
SHADOW_URL = "http://127.0.0.1:%d/shadow" % PORT
EOS_SHADOW_URL = "http://127.0.0.1:%d/eos-shadow" % PORT


class ReuseHTTPServer(HTTPServer):
    allow_reuse_address = True


class ThreadingHTTPServer(ThreadingMixIn, ReuseHTTPServer):
    daemon_threads = True


def kill_listeners_on_port(port: int) -> None:
    """以前の起動で残ったサーバーを止める（8765 重複で接続エラーになるのを防ぐ）"""
    ps = (
        "Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue | "
        "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
    ) % port
    kwargs: dict = {"capture_output": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    subprocess.run(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        **kwargs,
    )


def placer_html_path() -> Path | None:
    for p in (KIT / PLACER_HTML, ROOT / PLACER_HTML):
        if p.is_file():
            return p
    return None


def shadow_html_path() -> Path | None:
    for p in (KIT / SHADOW_HTML, ROOT / SHADOW_HTML):
        if p.is_file():
            return p
    return None


def eos_shadow_html_path() -> Path | None:
    for p in (KIT / EOS_SHADOW_HTML, ROOT / EOS_SHADOW_HTML):
        if p.is_file():
            return p
    return None


def parse_data_js(text: str) -> tuple[str, dict]:
    hist = ""
    m = re.match(r"^// GENERATOR_HISTORY: .+\r?\n", text)
    if m:
        hist = m.group(0)
        text = text[len(hist) :]
    body = text.strip()
    if body.startswith("var APP_DATA"):
        body = re.sub(r"^var\s+APP_DATA\s*=\s*", "", body)
    body = re.sub(r";\s*$", "", body)
    body = re.sub(r",(\s*[}\]])", r"\1", body)
    return hist, json.loads(body)


def format_data_js(hist: str, data: dict) -> str:
    return hist + "var APP_DATA = " + json.dumps(data, indent=2, ensure_ascii=False) + ";\n"


def write_data_js_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def read_hotspot_from_disk(scene_id: str, hotspot_index: int) -> dict | None:
    path = ROOT / "data.js"
    text = path.read_text(encoding="utf-8")
    _, data = parse_data_js(text)
    for scene in data.get("scenes") or []:
        if scene.get("id") == scene_id:
            hotspots = scene.get("videoHotspots") or []
            if hotspot_index < len(hotspots):
                return hotspots[hotspot_index]
            return None
    return None


def save_hotspot_to_disk(scene_id: str, hotspot: dict, hotspot_index: int) -> dict:
    path = ROOT / "data.js"
    text = path.read_text(encoding="utf-8")
    hist, data = parse_data_js(text)
    found = False
    for scene in data.get("scenes") or []:
        if scene.get("id") == scene_id:
            hotspots = scene.get("videoHotspots")
            if not isinstance(hotspots, list):
                hotspots = []
            while len(hotspots) <= hotspot_index:
                hotspots.append({})
            hotspots[hotspot_index] = hotspot
            scene["videoHotspots"] = hotspots
            found = True
            break
    if not found:
        raise ValueError("シーンが見つかりません: " + scene_id)
    out_text = format_data_js(hist, data)
    write_data_js_atomic(path, out_text)
    gh_path = ROOT / "GitHubUpload" / "data.js"
    if gh_path.parent.is_dir():
        write_data_js_atomic(gh_path, out_text)
    saved = read_hotspot_from_disk(scene_id, hotspot_index)
    if not saved:
        raise RuntimeError("保存後の読み戻しに失敗しました")
    log_path = KIT / "placer_last_save.log"
    log_path.write_text(
        "%s scene=%s index=%d yaw=%s width=%s height=%s path=%s\n"
        % (
            datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            scene_id,
            hotspot_index,
            saved.get("yaw"),
            saved.get("width"),
            saved.get("height"),
            path,
        ),
        encoding="utf-8",
    )
    PREVIEW_BY_SCENE[str(scene_id)] = saved
    return {
        "hotspot": saved,
        "dataJsPath": str(path),
        "savedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }


SHADOW_DIR = ROOT / "shadows"


def ensure_shadow_dir() -> Path:
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    return SHADOW_DIR


def save_foot_shadow_image(
    scene_id: str, data_base64: str, filename: str | None = None, kind: str = "foot"
) -> str:
    ensure_shadow_dir()
    raw = (data_base64 or "").strip()
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        blob = base64.b64decode(raw, validate=False)
    except Exception as e:
        raise ValueError("PNG データの decode に失敗しました: " + str(e)) from e
    if len(blob) < 32:
        raise ValueError("画像データが小さすぎます")
    ext = ".png"
    if filename:
        name = Path(filename).name
        if name.lower().endswith((".png", ".webp")):
            ext = Path(name).suffix.lower()
    safe_id = re.sub(r"[^\w\-]+", "_", scene_id)
    if kind == "eos":
        out_name = "%s_eos_foot%s" % (safe_id, ext)
    else:
        out_name = "%s_foot%s" % (safe_id, ext)
    out_path = SHADOW_DIR / out_name
    out_path.write_bytes(blob)
    return "shadows/" + out_name.replace("\\", "/")


def list_foot_shadow_images() -> list[str]:
    ensure_shadow_dir()
    out = []
    for p in sorted(SHADOW_DIR.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".png", ".webp", ".jpg", ".jpeg"):
            continue
        out.append("shadows/" + p.name)
    return out


def save_foot_shadow_to_disk(scene_id: str, hotspot_index: int, patch: dict) -> dict:
    path = ROOT / "data.js"
    text = path.read_text(encoding="utf-8")
    hist, data = parse_data_js(text)
    found = False
    for scene in data.get("scenes") or []:
        if scene.get("id") == scene_id:
            hotspots = scene.get("videoHotspots")
            if not isinstance(hotspots, list) or hotspot_index >= len(hotspots):
                raise ValueError("videoHotspot がありません: " + scene_id)
            hs = hotspots[hotspot_index]
            if "footShadow" in patch:
                hs["footShadow"] = bool(patch["footShadow"])
            if "footShadowImage" in patch and patch["footShadowImage"]:
                hs["footShadowImage"] = str(patch["footShadowImage"]).replace("\\", "/")
            elif patch.get("footShadow") is False:
                hs.pop("footShadowImage", None)
            if "footShadowConfig" in patch and isinstance(patch["footShadowConfig"], dict):
                hs["footShadowConfig"] = patch["footShadowConfig"]
            for legacy in ("footShadowStrength", "footShadowHeight", "groundShadow", "groundShadowStrength", "groundShadowHeight"):
                hs.pop(legacy, None)
            found = True
            break
    if not found:
        raise ValueError("シーンが見つかりません: " + scene_id)
    out_text = format_data_js(hist, data)
    write_data_js_atomic(path, out_text)
    gh_path = ROOT / "GitHubUpload" / "data.js"
    if gh_path.parent.is_dir():
        write_data_js_atomic(gh_path, out_text)
    saved = read_hotspot_from_disk(scene_id, hotspot_index)
    if not saved:
        raise RuntimeError("保存後の読み戻しに失敗しました")
    log_path = KIT / "shadow_last_save.log"
    log_path.write_text(
        "%s scene=%s index=%d footShadow=%s path=%s\n"
        % (
            datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            scene_id,
            hotspot_index,
            saved.get("footShadow"),
            path,
        ),
        encoding="utf-8",
    )
    return {
        "hotspot": saved,
        "dataJsPath": str(path),
        "savedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }


def read_hi_res_peek_from_disk(scene_id: str) -> dict | None:
    path = ROOT / "data.js"
    text = path.read_text(encoding="utf-8")
    _, data = parse_data_js(text)
    for scene in data.get("scenes") or []:
        if scene.get("id") == scene_id:
            peek = scene.get("hiResPeek")
            return peek if isinstance(peek, dict) else None
    return None


def save_hi_res_peek_shadow_to_disk(scene_id: str, patch: dict) -> dict:
    path = ROOT / "data.js"
    text = path.read_text(encoding="utf-8")
    hist, data = parse_data_js(text)
    found = False
    for scene in data.get("scenes") or []:
        if scene.get("id") != scene_id:
            continue
        peek = scene.get("hiResPeek")
        if not isinstance(peek, dict) or not peek.get("imageSrc"):
            raise ValueError("hiResPeek（EOS写真）がありません: " + scene_id)
        if "footShadow" in patch:
            peek["footShadow"] = bool(patch["footShadow"])
        if "footShadowImage" in patch and patch["footShadowImage"]:
            peek["footShadowImage"] = str(patch["footShadowImage"]).replace("\\", "/")
        elif patch.get("footShadow") is False:
            peek.pop("footShadowImage", None)
        if "footShadowConfig" in patch and isinstance(patch["footShadowConfig"], dict):
            peek["footShadowConfig"] = patch["footShadowConfig"]
        found = True
        break
    if not found:
        raise ValueError("シーンが見つかりません: " + scene_id)
    out_text = format_data_js(hist, data)
    write_data_js_atomic(path, out_text)
    gh_path = ROOT / "GitHubUpload" / "data.js"
    if gh_path.parent.is_dir():
        write_data_js_atomic(gh_path, out_text)
    saved = read_hi_res_peek_from_disk(scene_id)
    if not saved:
        raise RuntimeError("保存後の読み戻しに失敗しました")
    log_path = KIT / "eos_shadow_last_save.log"
    log_path.write_text(
        "%s scene=%s footShadow=%s path=%s\n"
        % (
            datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            scene_id,
            saved.get("footShadow"),
            path,
        ),
        encoding="utf-8",
    )
    return {
        "hiResPeek": saved,
        "dataJsPath": str(path),
        "savedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        rel = unquote(urlparse(path).path)
        if rel.endswith("/" + PLACER_HTML) or rel == "/" + PLACER_HTML:
            for p in (KIT / PLACER_HTML, ROOT / PLACER_HTML):
                if p.is_file():
                    return str(p)
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        # pythonw では sys.stderr が None のため、書き込みでリクエスト全体が落ちる
        msg = "%s - %s\n" % (self.address_string(), fmt % args)
        stream = sys.stderr
        if stream is not None:
            try:
                stream.write(msg)
            except OSError:
                pass

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_placer_html(self):
        path = placer_html_path()
        if not path:
            self.send_error(404, "placer html not found")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_shadow_html(self):
        path = shadow_html_path()
        if not path:
            self.send_error(404, "shadow html not found")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_eos_shadow_html(self):
        path = eos_shadow_html_path()
        if not path:
            self.send_error(404, "eos shadow html not found")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/placer", "/placer.html"):
            self._serve_placer_html()
            return
        if parsed.path in ("/shadow", "/shadow.html"):
            self._serve_shadow_html()
            return
        if parsed.path in ("/eos-shadow", "/eos-shadow.html"):
            self._serve_eos_shadow_html()
            return
        if parsed.path == "/api/project-info":
            self._send_json(
                200,
                {
                    "ok": True,
                    "root": str(ROOT),
                    "dataJs": str(ROOT / "data.js"),
                    "kit": str(KIT),
                },
            )
            return
        if parsed.path == "/api/hotspot":
            qs = parse_qs(parsed.query)
            scene_id = (qs.get("scene") or ["23-cc001"])[0]
            try:
                text = (ROOT / "data.js").read_text(encoding="utf-8")
                hist, data = parse_data_js(text)
                overlay = {}
                ov_path = ROOT / "data_overlay.json"
                if ov_path.is_file():
                    overlay = json.loads(ov_path.read_text(encoding="utf-8"))
                scene = None
                for s in data.get("scenes") or []:
                    if s.get("id") == scene_id:
                        scene = s
                        break
                if scene and overlay.get("scenes", {}).get(scene_id):
                    patch = overlay["scenes"][scene_id]
                    for k, v in patch.items():
                        scene[k] = v
                hotspots = (scene or {}).get("videoHotspots") or []
                idx = int((qs.get("index") or ["0"])[0])
                if idx < 0:
                    idx = 0
                hotspot = hotspots[idx] if idx < len(hotspots) else None
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "sceneId": scene_id,
                        "hotspotIndex": idx,
                        "hotspot": hotspot,
                        "hotspotCount": len(hotspots),
                        "hasHistory": bool(hist),
                    },
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/foot-shadow-images":
            try:
                self._send_json(200, {"ok": True, "images": list_foot_shadow_images()})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/data-scenes":
            try:
                text = (ROOT / "data.js").read_text(encoding="utf-8")
                _, data = parse_data_js(text)
                out = []
                for s in data.get("scenes") or []:
                    hs = s.get("videoHotspots") or []
                    if not hs:
                        continue
                    out.append({
                        "id": s.get("id"),
                        "label": (s.get("name") or s.get("id") or "") + " / " + (s.get("id") or ""),
                        "hasVideoHotspot": True,
                    })
                self._send_json(200, {"ok": True, "scenes": out})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/hi-res-peek-scenes":
            try:
                text = (ROOT / "data.js").read_text(encoding="utf-8")
                _, data = parse_data_js(text)
                out = []
                for s in data.get("scenes") or []:
                    peek = s.get("hiResPeek") or {}
                    if not peek.get("imageSrc"):
                        continue
                    out.append({
                        "id": s.get("id"),
                        "label": (s.get("name") or s.get("id") or "") + " / " + (s.get("id") or ""),
                        "imageSrc": peek.get("imageSrc"),
                        "hasVideo": bool(peek.get("videoSrc")),
                    })
                self._send_json(200, {"ok": True, "scenes": out})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/hi-res-peek":
            qs = parse_qs(parsed.query)
            scene_id = (qs.get("scene") or [""])[0]
            try:
                peek = read_hi_res_peek_from_disk(scene_id) if scene_id else None
                if not peek:
                    self._send_json(404, {"ok": False, "error": "hiResPeek がありません"})
                    return
                self._send_json(200, {"ok": True, "sceneId": scene_id, "hiResPeek": peek})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/video-files":
            try:
                video_dir = ROOT / "video"
                webm_files = []
                mp4_files = []
                if video_dir.is_dir():
                    for p in sorted(video_dir.iterdir()):
                        if not p.is_file():
                            continue
                        ext = p.suffix.lower()
                        if ext == ".webm":
                            webm_files.append(
                                {"name": p.name, "path": "video/" + p.name}
                            )
                        elif ext in (".mp4", ".m4v", ".mov"):
                            mp4_files.append(
                                {"name": p.name, "path": "video/" + p.name}
                            )
                hint = ""
                if not (video_dir / "guide_alpha.webm").is_file():
                    if (video_dir / "guide_alpha.webm.bak").is_file():
                        hint = (
                            "guide_alpha.webm がありません。"
                            " guide_alpha.webm.bak から復元できます（バックアップ .bak を .webm にコピー）。"
                        )
                    elif (video_dir / "guide_alpha.repair.webm").is_file():
                        hint = (
                            "guide_alpha.webm がありません。"
                            " repair.webm だけある場合は半透明になりやすいです。"
                            " rembg で作り直すか .bak から復元してください。"
                        )
                self._send_json(
                    200,
                    {"ok": True, "webm": webm_files, "hevc": mp4_files, "hint": hint},
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if parsed.path == "/api/preview-hotspot":
            qs = parse_qs(parsed.query)
            scene_id = (qs.get("scene") or [""])[0]
            hotspot = PREVIEW_BY_SCENE.get(scene_id) if scene_id else None
            self._send_json(
                200,
                {"ok": True, "sceneId": scene_id, "hotspot": hotspot},
            )
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "JSON が不正です"})
            return

        if parsed.path == "/api/preview-hotspot":
            scene_id = payload.get("sceneId")
            hotspot = payload.get("hotspot")
            if not scene_id or not hotspot:
                self._send_json(400, {"ok": False, "error": "sceneId と hotspot が必要です"})
                return
            PREVIEW_BY_SCENE[str(scene_id)] = sanitize_preview_hotspot(hotspot)
            self._send_json(200, {"ok": True, "sceneId": scene_id})
            return

        if parsed.path == "/api/upload-foot-shadow-image":
            try:
                scene_id = payload.get("sceneId")
                data_b64 = payload.get("dataBase64") or payload.get("imageData")
                filename = payload.get("filename")
                if not scene_id or not data_b64:
                    raise ValueError("sceneId と dataBase64 が必要です")
                rel = save_foot_shadow_image(str(scene_id), str(data_b64), filename)
                self._send_json(
                    200,
                    {"ok": True, "sceneId": scene_id, "footShadowImage": rel},
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if parsed.path == "/api/save-foot-shadow":
            try:
                scene_id = payload.get("sceneId")
                hotspot_index = int(payload.get("hotspotIndex") or 0)
                if hotspot_index < 0:
                    hotspot_index = 0
                if not scene_id:
                    raise ValueError("sceneId が必要です")
                patch = {
                    "footShadow": payload.get("footShadow", True),
                    "footShadowConfig": payload.get("footShadowConfig") or {},
                }
                if payload.get("footShadowImage"):
                    patch["footShadowImage"] = str(payload["footShadowImage"]).replace("\\", "/")
                meta = save_foot_shadow_to_disk(str(scene_id), hotspot_index, patch)
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "sceneId": scene_id,
                        "hotspotIndex": hotspot_index,
                        "hotspot": meta["hotspot"],
                        "dataJsPath": meta["dataJsPath"],
                        "savedAt": meta["savedAt"],
                    },
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if parsed.path == "/api/upload-hi-res-peek-shadow-image":
            try:
                scene_id = payload.get("sceneId")
                data_b64 = payload.get("dataBase64") or payload.get("imageData")
                filename = payload.get("filename")
                if not scene_id or not data_b64:
                    raise ValueError("sceneId と dataBase64 が必要です")
                rel = save_foot_shadow_image(str(scene_id), str(data_b64), filename, kind="eos")
                self._send_json(
                    200,
                    {"ok": True, "sceneId": scene_id, "footShadowImage": rel},
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if parsed.path == "/api/save-hi-res-peek-shadow":
            try:
                scene_id = payload.get("sceneId")
                if not scene_id:
                    raise ValueError("sceneId が必要です")
                patch = {
                    "footShadow": payload.get("footShadow", True),
                    "footShadowConfig": payload.get("footShadowConfig") or {},
                }
                if payload.get("footShadowImage"):
                    patch["footShadowImage"] = str(payload["footShadowImage"]).replace("\\", "/")
                meta = save_hi_res_peek_shadow_to_disk(str(scene_id), patch)
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "sceneId": scene_id,
                        "hiResPeek": meta["hiResPeek"],
                        "dataJsPath": meta["dataJsPath"],
                        "savedAt": meta["savedAt"],
                    },
                )
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if parsed.path != "/api/save-hotspot":
            self.send_error(404)
            return
        try:
            scene_id = payload.get("sceneId")
            hotspot = payload.get("hotspot")
            hotspot_index = int(payload.get("hotspotIndex") or 0)
            if hotspot_index < 0:
                hotspot_index = 0
            if not scene_id or not hotspot:
                raise ValueError("sceneId と hotspot が必要です")
            meta = save_hotspot_to_disk(str(scene_id), hotspot, hotspot_index)
            self._send_json(
                200,
                {
                    "ok": True,
                    "sceneId": scene_id,
                    "hotspotIndex": hotspot_index,
                    "hotspot": meta["hotspot"],
                    "dataJsPath": meta["dataJsPath"],
                    "savedAt": meta["savedAt"],
                },
            )
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})


def wait_until_ready(timeout: float = 12.0) -> bool:
    """ポートが受け付け可能かだけ確認（同一プロセスから HTTP すると不安定なため）"""
    import socket

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1.0):
                return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


def running_headless() -> bool:
    return Path(sys.executable).name.lower() in ("pythonw.exe", "pythonw")


def main():
    log_path = KIT / "placer_server_error.log"
    root_log = KIT / "placer_server_root.log"
    try:
        kill_listeners_on_port(PORT)
        time.sleep(0.35)
        if not placer_html_path():
            raise FileNotFoundError("モデル貼り付け用.html が見つかりません: " + str(KIT))
        root_log.write_text(
            "ROOT=%s\nVR_PROJECT_ROOT=%s\nKIT=%s\n"
            % (ROOT, os.environ.get("VR_PROJECT_ROOT", ""), KIT),
            encoding="utf-8",
        )
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        if running_headless():
            # VBS 起動: メインスレッドで待ち受け（pythonw での二重スレッドは不安定）
            server.serve_forever()
        else:
            print("万年山 VR動画配置: %s" % PLACER_URL)
            print("終了: この窓を閉じるか Ctrl+C")
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            if wait_until_ready(10.0):
                webbrowser.open(PLACER_URL)
            else:
                print("警告: サーバー準備タイムアウト。ブラウザで %s を開いてください。" % PLACER_URL)
            try:
                while worker.is_alive():
                    worker.join(timeout=1.0)
            except KeyboardInterrupt:
                pass
            server.shutdown()
    except KeyboardInterrupt:
        print("\n終了しました。")
    except Exception:
        log_path.write_text(traceback.format_exc(), encoding="utf-8")
        print("起動失敗。詳細: %s" % log_path)
        raise


if __name__ == "__main__":
    main()
