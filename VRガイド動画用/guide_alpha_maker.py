from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageFilter

from vr_project import project_root

try:
    from rembg import remove as rembg_remove
except Exception:  # pragma: no cover
    rembg_remove = None


def which_or_local(exe_name: str) -> str:
    here = Path(__file__).resolve().parent
    local = here / f"{exe_name}.exe"
    if local.exists():
        return str(local)
    w = shutil.which(exe_name)
    if w:
        return w
    raise RuntimeError(
        f"{exe_name} が見つかりません。\n"
        "PATH に追加するか、このフォルダに {exe_name}.exe を置いてください:\n"
        f"  {here}"
    )


def run_cmd(cmd: list[str], log=print) -> None:
    log("[実行] " + " ".join(str(c) for c in cmd[:8]) + (" ..." if len(cmd) > 8 else ""))
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        out = (p.stdout or b"").decode("utf-8", errors="replace")
        raise RuntimeError("コマンド失敗:\n" + " ".join(cmd) + "\n\n" + out)


def extract_preview_png(
    video: Path,
    out_png: Path,
    *,
    t_sec: float = 0.35,
    log=print,
) -> Path | None:
    """プレビュー用に1コマ画像を書き出す。"""
    if not video.is_file():
        return None
    ensure_dir(out_png.parent)
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-ss",
        str(max(0, t_sec)),
        "-i",
        str(video),
        "-vframes",
        "1",
        "-update",
        "1",
        str(out_png),
    ]
    try:
        run_cmd(cmd, log=log)
        if out_png.is_file():
            return out_png
    except Exception as e:
        log(f"[プレビュー] 画像化スキップ: {e}")
    return None


def vr_guide_path() -> Path:
    return project_root() / "video" / "guide_alpha.webm"


def copy_to_vr_folder(src: Path, log=print) -> Path:
    dest = vr_guide_path()
    ensure_dir(dest.parent)
    shutil.copy2(src, dest)
    log(f"[VR用] コピー完了 → {dest}")
    return dest


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def clear_png_prefix(dir_path: Path, prefix: str, *, log=print) -> int:
    """前回の切り出しPNGを消す（枚数が減ったとき末尾に別動画のコマが残るのを防ぐ）。"""
    if not dir_path.is_dir():
        return 0
    removed = 0
    for f in dir_path.glob(f"{prefix}_*.png"):
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass
    if removed:
        log(f"[整理] {dir_path.name}/{prefix}_*.png を {removed} 枚削除しました")
    return removed


def probe_duration(video: Path) -> float:
    cmd = [
        which_or_local("ffprobe"),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        str(video),
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffprobe 失敗: " + (p.stderr or b"").decode("utf-8", errors="replace"))
    meta = json.loads((p.stdout or b"{}").decode("utf-8", errors="replace"))
    dur = float(meta.get("format", {}).get("duration", 0) or 0)
    if dur <= 0:
        raise RuntimeError("動画の長さを読み取れませんでした。")
    return dur


def write_source_meta(
    work_dir: Path,
    video: Path,
    frame_count: int,
    duration: float,
    *,
    native_fps: float | None = None,
) -> None:
    ensure_dir(work_dir)
    meta = {
        "source": str(video),
        "duration": duration,
        "frame_count": frame_count,
        "native_fps": native_fps,
    }
    (work_dir / "source_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_source_meta(work_dir: Path) -> dict | None:
    p = work_dir / "source_meta.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def extract_frames_count(
    video: Path,
    out_dir: Path,
    frame_count: int,
    prefix: str = "frame",
    *,
    work_dir: Path | None = None,
    log=print,
) -> int:
    """動画全体から、指定枚数だけ均等にPNGを切り出す。"""
    if frame_count < 1:
        raise ValueError("コマ数は1以上にしてください。")
    ensure_dir(out_dir)
    clear_png_prefix(out_dir, prefix, log=log)
    dur = probe_duration(video)
    # 均等サンプリング: fps = 枚数 / 秒
    fps = max(0.1, frame_count / dur)
    out_pattern = out_dir / f"{prefix}_%06d.png"
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(video),
        "-vf",
        f"fps={fps}",
        "-frames:v",
        str(frame_count),
        str(out_pattern),
    ]
    log(f"[切り出し] {frame_count}枚 / 約{dur:.2f}秒 (fps={fps:.3f})")
    run_cmd(cmd)
    files = sorted(out_dir.glob(f"{prefix}_*.png"))
    log(f"[切り出し] 完了: {len(files)}枚 → {out_dir}")
    if work_dir is not None:
        write_source_meta(work_dir, video, len(files), dur)
        log(f"[切り出し] 元の長さ: {dur:.2f}秒（動画化時に同じ秒数で書き出します）")
    return len(files)


def extract_frames_native(
    video: Path,
    out_dir: Path,
    fps: int = 30,
    prefix: str = "frame",
    *,
    work_dir: Path | None = None,
    log=print,
) -> int:
    """元動画を fps=30 などで全コマ切り出し（滑らかさ優先）。"""
    ensure_dir(out_dir)
    clear_png_prefix(out_dir, prefix, log=log)
    dur = probe_duration(video)
    out_pattern = out_dir / f"{prefix}_%06d.png"
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(video),
        "-vf",
        f"fps={fps}",
        str(out_pattern),
    ]
    log(f"[切り出し・滑らか] {fps}fps で全コマ（約{dur:.1f}秒 → 約{int(dur * fps)}枚）")
    run_cmd(cmd)
    files = sorted(out_dir.glob(f"{prefix}_*.png"))
    log(f"[切り出し・滑らか] 完了: {len(files)}枚")
    if work_dir is not None:
        write_source_meta(work_dir, video, len(files), dur, native_fps=float(fps))
    return len(files)


def crop_bottom_video(
    video: Path,
    out_video: Path,
    bottom_px: int,
    *,
    log=print,
) -> None:
    """下端を指定ピクセル分カット（Kling ロゴなど）。"""
    bottom_px = max(0, int(bottom_px))
    ensure_dir(out_video.parent)
    if bottom_px <= 0:
        if video.resolve() != out_video.resolve():
            import shutil

            shutil.copy2(video, out_video)
        return
    vf = f"crop=iw:ih-{bottom_px}:0:0,scale=trunc(iw/2)*2:trunc(ih/2)*2"
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(video),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "fast",
        "-an",
        str(out_video),
    ]
    log(f"[下端カット] 下 {bottom_px}px 除去 → {out_video.name}")
    run_cmd(cmd)
    log(f"[下端カット] 完了: {out_video}")


def prepare_video_for_alpha(
    video: Path,
    out_video: Path,
    *,
    bottom_crop_px: int = 0,
    log=print,
) -> Path:
    """下端ロゴ除去 → 黒帯があれば除去。Kling のグレー動画は黒帯なしでスキップ可。"""
    import shutil

    ensure_dir(out_video.parent)
    src = video
    if bottom_crop_px > 0:
        trimmed = out_video.parent / f"{video.stem}_trimmed.mp4"
        crop_bottom_video(video, trimmed, bottom_crop_px, log=log)
        src = trimmed
    try:
        crop_letterbox_video(src, out_video, log=log)
    except RuntimeError as exc:
        log(f"[黒帯カット] スキップ（黒帯なし）: {exc}")
        if src.resolve() != out_video.resolve():
            shutil.copy2(src, out_video)
        else:
            shutil.copy2(video, out_video)
    return out_video


def detect_letterbox_crop(video: Path, *, log=print) -> str:
    """上下（または左右）の黒帯を cropdetect で検出。戻り値は ffmpeg の crop= 文字列。"""
    cmd = [
        which_or_local("ffmpeg"),
        "-hide_banner",
        "-i",
        str(video),
        "-vf",
        "cropdetect=limit=20:round=2",
        "-frames:v",
        "45",
        "-f",
        "null",
        "-",
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = (p.stdout or b"").decode("utf-8", errors="replace")
    crop = None
    for line in out.splitlines():
        if "crop=" in line:
            idx = line.rfind("crop=")
            crop = line[idx:].strip().split()[0]
    if not crop or crop == "crop=iw:ih:0:0":
        raise RuntimeError("黒帯の自動検出に失敗しました。手動で crop= を指定してください。")
    log(f"[黒帯カット] 検出: {crop}")
    return crop


def crop_letterbox_video(
    video: Path,
    out_video: Path,
    *,
    crop: str | None = None,
    log=print,
) -> str:
    """レターボックス（上下の黒帯）を除去した MP4 を出力。"""
    ensure_dir(out_video.parent)
    crop_filter = crop or detect_letterbox_crop(video, log=log)
    vf = f"{crop_filter},scale=trunc(iw/2)*2:trunc(ih/2)*2"
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(video),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-an",
        str(out_video),
    ]
    log(f"[黒帯カット] → {out_video.name}")
    run_cmd(cmd)
    log(f"[黒帯カット] 完了: {out_video}")
    return crop_filter


def crop_white_to_alpha_webm(
    video: Path,
    out_video: Path,
    *,
    cropped_mp4: Path | None = None,
    bottom_crop_px: int = 0,
    bg_color: str = "0xE0E0E0",
    similarity: float = 0.12,
    blend: float = 0.07,
    log=print,
    progress=None,
) -> Path:
    """下端ロゴ除去 → 黒帯(あれば)除去 → 均一背景透過 WebM。"""
    def prog(pct: int, msg: str) -> None:
        if progress:
            progress(pct, msg)

    work = out_video.parent
    if cropped_mp4 is None:
        cropped_mp4 = work / f"{video.stem}_cropped.mp4"
    prog(8, "準備中…")
    cache_key = f"{video.stat().st_mtime}_{bottom_crop_px}"
    stamp_file = work / ".crop_stamp.txt"
    need_crop = True
    if cropped_mp4.is_file() and stamp_file.is_file():
        if stamp_file.read_text(encoding="utf-8").strip() == cache_key:
            need_crop = False
    if need_crop:
        prog(18, "下端ロゴ除去・黒帯カット中…")
        prepare_video_for_alpha(
            video, cropped_mp4, bottom_crop_px=bottom_crop_px, log=log
        )
        stamp_file.write_text(cache_key, encoding="utf-8")
        extract_preview_png(cropped_mp4, work / "preview_cropped.png", log=log)
    else:
        log("[カット] キャッシュを使用（既存の cropped.mp4）")
    prog(52, "背景を透過 WebM に変換中…（1〜3分）")
    white_bg_to_alpha_webm(
        cropped_mp4,
        out_video,
        similarity=similarity,
        blend=blend,
        bg_color=bg_color,
        log=log,
    )
    prog(88, "プレビュー画像を作成…")
    extract_preview_png(out_video, work / "preview_output.png", log=log)
    return cropped_mp4


def white_bg_to_alpha_webm(
    video: Path,
    out_video: Path,
    *,
    similarity: float = 0.12,
    blend: float = 0.07,
    bg_color: str = "0xE0E0E0",
    crop_first: str | None = None,
    log=print,
) -> None:
    """均一背景（薄グレー/白）動画を一括で透過WebMに（コマ切り出し不要・滑らか）。"""
    ensure_dir(out_video.parent)
    parts = []
    if crop_first:
        parts.append(crop_first)
        parts.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
    parts.append(f"colorkey={bg_color}:{similarity}:{blend}")
    parts.append("format=yuva420p")
    log(
        f"[背景透過] colorkey {bg_color} similarity={similarity} blend={blend} "
        "※グレー背景＋ベージュ服は体が透けて見える→ rembg 推奨"
    )
    vf = ",".join(parts)
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(video),
        "-vf",
        vf,
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-b:v",
        "0",
        "-crf",
        "30",
        str(out_video),
    ]
    log(f"[背景透過] 一括処理（滑らか）→ {out_video.name}")
    run_cmd(cmd)
    log(f"[背景透過] 完了: {out_video}")
    try:
        probe = subprocess.run(
            [
                which_or_local("ffprobe"),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=pix_fmt",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(out_video),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        pix = (probe.stdout or b"").decode("utf-8", errors="replace").strip()
        log(f"[白背景透過] pix_fmt={pix}（yuva420p なら透過OK）")
        if pix and "yuva" not in pix:
            log("[警告] 透過チャンネルがありません。別のブラウザか再エンコードを試してください。")
    except Exception:
        pass


def _black_bg_to_alpha_rgba(
    img: Image.Image,
    *,
    threshold: int = 34,
    erode_px: int = 2,
    blur_px: float = 0.9,
) -> Image.Image:
    """不透明WebMの黒背景を透過にする（VRで黒い囲み・暗い画面の主因を修復）。"""
    img = img.convert("RGBA")
    r, g, b, _old_a = img.split()
    try:
        import numpy as np

        rgb = np.array(Image.merge("RGB", (r, g, b)), dtype=np.int16)
        mx = rgb.max(axis=2)
        alpha = np.where(mx > threshold, 255, 0).astype(np.uint8)
        edge = (alpha > 0) & (mx <= threshold + 55)
        if edge.any():
            alpha[edge] = np.clip(
                ((mx[edge] - threshold) * 4).astype(np.int16), 0, 255
            ).astype(np.uint8)
        h = alpha.shape[0]
        foot = slice(int(h * 0.62), h)
        foot_mask = alpha[foot] > 0
        if foot_mask.any():
            alpha[foot][foot_mask] = np.clip(
                alpha[foot][foot_mask].astype(np.int16) + 40, 0, 255
            ).astype(np.uint8)
        a = Image.fromarray(alpha, mode="L")
    except Exception:
        px = img.load()
        w, h = img.size
        a = Image.new("L", (w, h), 0)
        ap = a.load()
        for y in range(h):
            for x in range(w):
                pr, pg, pb, _ = px[x, y]
                mx = max(pr, pg, pb)
                if mx > threshold:
                    ap[x, y] = 255
                elif mx > threshold - 20:
                    ap[x, y] = min(255, (mx - threshold + 20) * 8)
    if erode_px > 0:
        k = max(3, erode_px * 2 + 1)
        a = a.filter(ImageFilter.MinFilter(size=k))
    if blur_px > 0:
        a = a.filter(ImageFilter.GaussianBlur(radius=float(blur_px)))
    return Image.merge("RGBA", (r, g, b, a))


def verify_webm_has_alpha(webm: Path, log=print) -> bool:
    """1コマ抽出してアルファに中間値があるか確認。"""
    import tempfile

    tmp = Path(tempfile.gettempdir()) / "guide_alpha_verify.png"
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-i",
        str(webm),
        "-vf",
        "format=rgba",
        "-frames:v",
        "1",
        "-update",
        "1",
        str(tmp),
    ]
    try:
        run_cmd(cmd, log=lambda _m: None)
        if not tmp.is_file():
            return False
        import numpy as np

        a = np.array(Image.open(tmp).convert("RGBA").split()[3])
        partial = int(((a > 0) & (a < 255)).sum())
        log(f"[確認] 半透明ピクセル: {partial} （0なら透過なし＝VRで黒背景）")
        return partial > 100
    except Exception as e:
        log(f"[確認] スキップ: {e}")
        return False
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def repair_opaque_webm_alpha(
    in_webm: Path,
    out_webm: Path,
    *,
    work_dir: Path | None = None,
    threshold: int = 34,
    log=print,
) -> Path:
    """黒背景の不透明WebMを、本当に透過付きWebMへ作り直す。"""
    if not in_webm.is_file():
        raise RuntimeError(f"入力がありません: {in_webm}")
    work = work_dir or (in_webm.parent / "_repair_alpha_work")
    frames_in = work / "frames_in"
    frames_out = work / "frames_out"
    if frames_in.exists():
        shutil.rmtree(frames_in, ignore_errors=True)
    if frames_out.exists():
        shutil.rmtree(frames_out, ignore_errors=True)
    ensure_dir(frames_in)
    ensure_dir(frames_out)

    log(f"[修復] フレーム抽出: {in_webm.name}")
    run_cmd(
        [
            which_or_local("ffmpeg"),
            "-y",
            "-i",
            str(in_webm),
            str(frames_in / "frame_%04d.png"),
        ],
        log=log,
    )
    files = sorted(frames_in.glob("frame_*.png"))
    if not files:
        raise RuntimeError("フレーム抽出に失敗しました。")
    log(f"[修復] 黒背景→透過 {len(files)}枚 (threshold={threshold})")
    for idx, fp in enumerate(files, start=1):
        out = _black_bg_to_alpha_rgba(Image.open(fp), threshold=threshold, erode_px=2, blur_px=0.9)
        out.save(frames_out / fp.name)
        if idx == 1 or idx % 10 == 0 or idx == len(files):
            log(f"[修復] 透過化 {idx}/{len(files)}")

    meta = probe_duration(in_webm)
    dur = float(meta) if meta else None
    n = len(files)
    fps = (n / dur) if dur and dur > 0 else 30.0
    ensure_dir(out_webm.parent)
    tmp_out = out_webm.with_suffix(".repair.webm")
    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-framerate",
        f"{fps:.6f}",
        "-i",
        str(frames_out / "frame_%04d.png"),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-b:v",
        "0",
        "-crf",
        "28",
        str(tmp_out),
    ]
    run_cmd(cmd, log=log)
    if not verify_webm_has_alpha(tmp_out, log=log):
        log("[警告] 透過確認できませんでした。ブラウザで再確認してください。")
    shutil.copy2(tmp_out, out_webm)
    log(f"[修復] 完了 → {out_webm}")
    return out_webm


def _boost_cutout_alpha(img: Image.Image) -> Image.Image:
    """rembg後の半透明（靴・服）をやや不透明に。"""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    r, g, b, a = img.split()
    a = a.point(lambda v: min(255, int(v * 1.6 + 50)) if v > 0 else 0)
    try:
        import numpy as np

        arr = np.array(a)
        h = arr.shape[0]
        foot = arr[int(h * 0.6) :, :]
        foot[foot > 0] = np.clip(foot[foot > 0].astype(np.int16) + 35, 0, 255).astype(np.uint8)
        arr[int(h * 0.6) :, :] = foot
        a = Image.fromarray(arr, mode="L")
    except Exception:
        pass
    return Image.merge("RGBA", (r, g, b, a))


def _refine_cutout_alpha(img: Image.Image, erode_px: int = 2, blur_px: int = 1) -> Image.Image:
    """白縁・ギザギザを抑える（アルファを少し縮めてぼかす）。"""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    r, g, b, a = img.split()
    if erode_px > 0:
        k = max(3, erode_px * 2 + 1)
        a = a.filter(ImageFilter.MinFilter(size=k))
    if blur_px > 0:
        a = a.filter(ImageFilter.GaussianBlur(radius=float(blur_px)))
    return Image.merge("RGBA", (r, g, b, a))


def iter_frames(dir_path: Path, prefix: str) -> list[Path]:
    files = sorted(dir_path.glob(f"{prefix}_*.png"))
    if not files:
        raise RuntimeError(f"PNGがありません: {dir_path}\\{prefix}_*.png")
    return files


def png_sequence_pattern(dir_path: Path, prefix: str) -> str:
    """cutout_0001.png / cutout_000001.png など実ファイルに合わせた ffmpeg パターン。"""
    files = iter_frames(dir_path, prefix)
    sample = files[0].name
    stem = sample[len(prefix) + 1 : -4]
    if stem.isdigit():
        return f"{prefix}_%0{len(stem)}d.png"
    return f"{prefix}_%06d.png"


def cutout_frames(
    in_dir: Path,
    in_prefix: str,
    out_dir: Path,
    out_prefix: str = "cutout",
    *,
    log=print,
    progress=None,
) -> int:
    if rembg_remove is None:
        raise RuntimeError("rembg がありません。  pip install rembg pillow")
    ensure_dir(out_dir)
    clear_png_prefix(out_dir, out_prefix, log=log)
    frames = iter_frames(in_dir, in_prefix)
    total = len(frames)
    for idx, fp in enumerate(frames, start=1):
        img = Image.open(fp).convert("RGBA")
        out = rembg_remove(img)
        if isinstance(out, (bytes, bytearray)):
            from io import BytesIO

            out_img = Image.open(BytesIO(out)).convert("RGBA")
        else:
            out_img = out.convert("RGBA")
        out_img = _boost_cutout_alpha(out_img)
        out_img = _refine_cutout_alpha(out_img, erode_px=2, blur_px=1)
        num = fp.stem.split("_")[-1]
        out_path = out_dir / f"{out_prefix}_{num}.png"
        out_img.save(out_path)
        if idx == 1 or idx % 5 == 0 or idx == total:
            log(f"[透過] {idx}/{total}")
        if progress and (idx == 1 or idx % 3 == 0 or idx == total):
            pct = 20 + int(55 * idx / max(1, total))
            progress(pct, f"AI透過 {idx} / {total}")
    log(f"[透過] 完了 → {out_dir}")
    first = out_dir / f"{out_prefix}_{frames[0].stem.split('_')[-1]}.png"
    if first.is_file():
        try:
            shutil.copy2(first, out_dir.parent / "preview_output.png")
        except Exception:
            pass
    return total


def assemble_alpha_webm(
    in_dir: Path,
    prefix: str,
    out_video: Path,
    *,
    work_dir: Path | None = None,
    duration_sec: float | None = None,
    fps_override: int | None = None,
    log=print,
) -> None:
    ensure_dir(out_video.parent)
    files = sorted(in_dir.glob(f"{prefix}_*.png"))
    meta = read_source_meta(work_dir) if work_dir else None
    expected = int(meta.get("frame_count", 0)) if meta and meta.get("frame_count") else 0
    if expected > 0 and len(files) > expected:
        stale = files[expected:]
        for f in stale:
            try:
                f.unlink()
            except OSError:
                pass
        log(f"[動画化] 古い末尾コマ {len(stale)} 枚を除外しました（前の動画の残り）")
        files = files[:expected]
    n = len(files)
    if n < 1:
        raise RuntimeError("透過PNGがありません。")
    in_pattern = in_dir / png_sequence_pattern(in_dir, prefix)

    dur = duration_sec
    if dur is None and meta:
        dur = float(meta.get("duration") or 0)

    native_fps = None
    if meta:
        native_fps = meta.get("native_fps")

    if native_fps and float(native_fps) > 0:
        out_fps = float(native_fps)
        log(f"[動画化] {n}枚 @ {out_fps:.0f}fps（30fps相当・滑らか）")
    elif dur and dur > 0:
        out_fps = n / dur
        log(f"[動画化] {n}枚 / {dur:.2f}秒 → {out_fps:.2f}fps（枚数が少ないとカクつきます）")
    elif fps_override and fps_override > 0:
        out_fps = float(fps_override)
        log(f"[動画化] {n}枚 @ {fps_override}fps（約{n / out_fps:.2f}秒）")
    else:
        out_fps = 24.0
        log(f"[動画化] {n}枚 @ 24fps（約{n / 24:.2f}秒）※元の長さ情報なし")

    cmd = [
        which_or_local("ffmpeg"),
        "-y",
        "-framerate",
        f"{out_fps:.6f}",
        "-i",
        str(in_pattern),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-b:v",
        "0",
        "-crf",
        "30",
        str(out_video),
    ]
    run_cmd(cmd)
    verify_webm_has_alpha(out_video, log=log)
    log(f"[動画化] 完了: {out_video}")


def run_all(
    video: Path,
    work_dir: Path,
    frame_count: int,
    out_fps: int,
    out_webm: Path | None = None,
    *,
    log=print,
) -> Path:
    frames_dir = work_dir / "frames"
    cutout_dir = work_dir / "cutout"
    if out_webm is None:
        out_webm = work_dir / "guide_alpha.webm"
    dur = probe_duration(video)
    extract_frames_count(
        video, frames_dir, frame_count, work_dir=work_dir, log=log
    )
    cutout_frames(frames_dir, "frame", cutout_dir, "cutout", log=log)
    assemble_alpha_webm(
        cutout_dir,
        "cutout",
        out_webm,
        work_dir=work_dir,
        duration_sec=dur,
        fps_override=out_fps if out_fps > 0 else None,
        log=log,
    )
    return out_webm


def main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="切り出し→透過→透過WebM（VR貼り付け用）")
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--work-dir", type=Path, required=True)
    ap.add_argument("--frames", type=int, default=40, help="切り出し枚数（30〜50推奨）")
    ap.add_argument(
        "--fps",
        type=int,
        default=0,
        help="固定fps（0=元動画と同じ秒数で自動）",
    )
    ap.add_argument("--out", type=Path, default=None, help="出力WebM（省略時 work-dir/guide_alpha.webm）")
    args = ap.parse_args(argv)
    try:
        run_all(
            args.video,
            args.work_dir,
            args.frames,
            args.fps if args.fps > 0 else 0,
            args.out,
        )
        return 0
    except Exception as e:
        print("[error]", e)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
