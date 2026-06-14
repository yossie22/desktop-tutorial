from __future__ import annotations

import os
import shutil
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageTk

from vr_project import project_root

from guide_alpha_maker import (
    assemble_alpha_webm,
    copy_to_vr_folder,
    crop_white_to_alpha_webm,
    cutout_frames,
    extract_frames_count,
    extract_frames_native,
    extract_preview_png,
    probe_duration,
    vr_guide_path,
    white_bg_to_alpha_webm,
)

ROOT = project_root()


class GuideAlphaMakerUI(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("1_透過を作る（VRガイド用）")
        self.geometry("960x680")
        self.minsize(820, 600)

        self.video_path: Path | None = None
        self.work_dir = ROOT / "work" / "alpha"
        self._photo: ImageTk.PhotoImage | None = None

        self.var_frames = tk.IntVar(value=30)
        self.var_bottom_crop = tk.IntVar(value=0)
        self.var_status = tk.StringVar(value="①動画を選ぶ → ②下の表でボタンを押す")
        self.var_progress = tk.DoubleVar(value=0.0)
        self.var_vr_ok = tk.StringVar(value="VR用ファイル: 未作成")

        self._build()
        self._busy = False
        self._refresh_vr_status()

    def _hint(self, parent: tk.Widget, text: str, **kw) -> tk.Label:
        opts = {"justify": tk.LEFT, "wraplength": 700}
        opts.update(kw)
        lbl = tk.Label(parent, text=text, **opts)
        lbl.pack(anchor=tk.W, pady=(0, 4))
        return lbl

    def _build(self) -> None:
        outer = ttk.Frame(self, padding=8)
        outer.pack(fill=tk.BOTH, expand=True)

        guide = ttk.LabelFrame(outer, text="今日やること（この順番）", padding=6)
        guide.pack(fill=tk.X, pady=(0, 6))
        self._hint(
            guide,
            "① 動画を選ぶ（人物は縦長9:16がよい）\n"
            "② 服の色に合わせて下のボタンを押す\n"
            "③ できた webm を video フォルダへ（女性=guide_alpha.webm 将校=海軍.webm）\n"
            "※ 別の動画に作り直すときは「rembg全部実行」を押す（古いコマが末尾に残ると一瞬別人が出ます）",
        )
        pick_help = ttk.LabelFrame(outer, text="② 服の色 → 押すボタン", padding=6)
        pick_help.pack(fill=tk.X, pady=(0, 6))
        self._hint(
            pick_help,
            "白っぽい服・普通の服 … ★速い透過\n"
            "AIで緑背景にした … rembg全部実行\n"
            "白い制服＋黒い帽子 … rembg全部実行",
            fg="#033",
        )

        top = ttk.Frame(outer)
        top.pack(fill=tk.X, pady=(0, 6))
        ttk.Button(top, text="① 動画を選ぶ", command=self.pick_video).pack(side=tk.LEFT)
        ttk.Button(top, text="VR用フォルダを開く", command=self.open_vr_video).pack(
            side=tk.LEFT, padx=6
        )
        ttk.Button(top, text="作業フォルダを開く", command=self.open_work).pack(side=tk.LEFT)

        self.lbl_video = tk.Label(outer, text="（未選択）", fg="#444", wraplength=700, justify=tk.LEFT)
        self.lbl_video.pack(anchor=tk.W)
        self.lbl_out = tk.Label(
            outer, text="出力先: （動画を選ぶと表示）", fg="#066", wraplength=700, justify=tk.LEFT
        )
        self.lbl_out.pack(anchor=tk.W, pady=(2, 4))

        status_row = ttk.LabelFrame(outer, text="進捗", padding=6)
        status_row.pack(fill=tk.X, pady=(0, 6))
        self.lbl_status = tk.Label(status_row, textvariable=self.var_status, wraplength=680, justify=tk.LEFT)
        self.lbl_status.pack(anchor=tk.W)
        self.progress = ttk.Progressbar(
            status_row, variable=self.var_progress, maximum=100, mode="determinate"
        )
        self.progress.pack(fill=tk.X, pady=(4, 0))
        tk.Label(status_row, textvariable=self.var_vr_ok, fg="#393").pack(anchor=tk.W, pady=(4, 0))

        body = ttk.PanedWindow(outer, orient=tk.HORIZONTAL)
        body.pack(fill=tk.BOTH, expand=True)

        left = ttk.Frame(body, padding=(0, 0, 6, 0))
        body.add(left, weight=1)

        rec = ttk.LabelFrame(left, text="おすすめ（白背景のKling動画）", padding=6)
        rec.pack(fill=tk.X, pady=(0, 6))
        self.btn_star = ttk.Button(
            rec,
            text="★ 速い透過（colorkey・グレー背景向け）",
            command=lambda: self._run_step("crop_white"),
        )
        self.btn_star.pack(fill=tk.X, pady=(0, 4))
        self._hint(rec, "体が透ける→下の「rembg全部実行」", fg="#633", wraplength=360)
        crop_row = ttk.Frame(rec)
        crop_row.pack(fill=tk.X, pady=(0, 4))
        tk.Label(crop_row, text="下端カット(px)", width=14).pack(side=tk.LEFT)
        ttk.Spinbox(
            crop_row,
            from_=0,
            to=200,
            textvariable=self.var_bottom_crop,
            width=6,
        ).pack(side=tk.LEFT)
        tk.Label(crop_row, text="Avidemuxで切ったら0", fg="#666").pack(side=tk.LEFT, padx=4)
        ttk.Button(
            rec,
            text="背景透過のみ（カットなし）",
            command=lambda: self._run_step("white"),
        ).pack(fill=tk.X)

        cfg = ttk.LabelFrame(left, text="rembg方式（髪重視・時間かかる）", padding=6)
        cfg.pack(fill=tk.X, pady=(0, 6))

        r1 = ttk.Frame(cfg)
        r1.pack(fill=tk.X, pady=2)
        tk.Label(r1, text="切り出し枚数", width=14).pack(side=tk.LEFT)
        ttk.Scale(r1, from_=30, to=300, variable=self.var_frames, orient=tk.HORIZONTAL).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        tk.Label(r1, textvariable=self.var_frames, width=5).pack(side=tk.LEFT)

        bf = ttk.Frame(cfg)
        bf.pack(fill=tk.X, pady=2)
        ttk.Button(
            bf, text="30fpsで全コマ", command=lambda: self._run_step("smooth_all")
        ).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(bf, text="rembg全部実行", command=lambda: self._run_step("all")).pack(
            side=tk.LEFT
        )

        btns = ttk.Frame(left)
        btns.pack(fill=tk.X, pady=2)
        for label, step in [
            ("② 切り出し", "extract"),
            ("③ 透過", "cutout"),
            ("④ 動画化", "assemble"),
        ]:
            ttk.Button(btns, text=label, command=lambda s=step: self._run_step(s)).pack(
                side=tk.LEFT, padx=(0, 4)
            )

        logf = ttk.LabelFrame(left, text="ログ", padding=4)
        logf.pack(fill=tk.BOTH, expand=True)
        self.txt = tk.Text(logf, height=8, wrap=tk.WORD, state=tk.DISABLED)
        self.txt.pack(fill=tk.BOTH, expand=True)

        right = ttk.LabelFrame(body, text="プレビュー（完成イメージ）", padding=6)
        body.add(right, weight=0)
        self.lbl_preview = tk.Label(
            right,
            text="処理前: 元動画の1コマ\n処理後: 透過WebMの1コマ",
            anchor=tk.CENTER,
            justify=tk.CENTER,
        )
        self.lbl_preview.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)
        ttk.Button(right, text="プレビュー更新", command=self.refresh_preview).pack(fill=tk.X)

    def _set_progress(self, pct: float, msg: str) -> None:
        def ui() -> None:
            self.var_progress.set(max(0, min(100, pct)))
            self.var_status.set(msg)

        self.after(0, ui)

    def log(self, msg: str) -> None:
        def ui() -> None:
            self.txt.configure(state=tk.NORMAL)
            self.txt.insert(tk.END, msg + "\n")
            self.txt.see(tk.END)
            self.txt.configure(state=tk.DISABLED)
            if msg.strip():
                self.var_status.set(msg.strip()[:120])

        self.after(0, ui)

    def _progress_cb(self, pct: int, msg: str) -> None:
        self._set_progress(float(pct), msg)
        self.log(msg)

    def _refresh_vr_status(self) -> None:
        p = vr_guide_path()
        if p.is_file():
            mb = p.stat().st_size / (1024 * 1024)
            self.var_vr_ok.set(f"VR用ファイル: あり ✓  {p.name} ({mb:.1f} MB)")
        else:
            self.var_vr_ok.set("VR用ファイル: まだありません（★ 実行後に作成）")

    def _show_preview_file(self, path: Path | None, caption: str) -> None:
        if not path or not path.is_file():
            return
        try:
            im = Image.open(path).convert("RGBA")
            w, h = im.size
            checker = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            tile = Image.new("RGBA", (16, 16), (200, 200, 200, 255))
            tile2 = Image.new("RGBA", (16, 16), (140, 140, 140, 255))
            for y in range(0, h, 16):
                for x in range(0, w, 16):
                    checker.paste(tile if (x // 16 + y // 16) % 2 == 0 else tile2, (x, y))
            if im.mode == "RGBA":
                checker = Image.alpha_composite(checker, im)
            else:
                checker = im.convert("RGB")
            preview = checker.copy()
            preview.thumbnail((240, 360), Image.Resampling.LANCZOS)
            self._photo = ImageTk.PhotoImage(preview)
            self.lbl_preview.configure(image=self._photo, text=caption, compound=tk.TOP)
        except Exception as e:
            self.log(f"[プレビュー] 表示失敗: {e}")

    def refresh_preview(self) -> None:
        out_png = self.work_dir / "preview_output.png"
        in_png = self.work_dir / "preview_input.png"
        if out_png.is_file():
            self._show_preview_file(out_png, "完成 WebM の1コマ（透過）")
        elif in_png.is_file():
            self._show_preview_file(in_png, "元動画の1コマ")
        else:
            vr = vr_guide_path()
            if vr.is_file():
                extract_preview_png(vr, out_png, log=self.log)
                self._show_preview_file(out_png, "VR用 guide_alpha.webm")

    def pick_video(self) -> None:
        initial = str(Path.home() / "Desktop")
        p = filedialog.askopenfilename(
            title="動画",
            initialdir=initial if os.path.isdir(initial) else None,
            filetypes=[("動画", "*.mp4;*.mov;*.mkv;*.webm"), ("すべて", "*.*")],
        )
        if not p:
            return
        self.video_path = Path(p)
        self.lbl_video.config(text=str(self.video_path))
        stem = self.video_path.stem
        self.work_dir = ROOT / "work" / f"alpha_{stem}"
        out = self.work_dir / "guide_alpha.webm"
        self.lbl_out.config(text=f"作業: {out}\nVR用: {vr_guide_path()}")
        self.work_dir.mkdir(parents=True, exist_ok=True)
        try:
            d = probe_duration(self.video_path)
            est = int(d * 30)
            self.var_frames.set(min(300, max(30, est)))
            self.log(
                f"選択: {self.video_path.name}\n"
                f"長さ: {d:.1f}秒（30fps全コマ≈{est}枚）\n"
                f"次: ★ を押してください"
            )
        except Exception:
            self.log(f"選択: {self.video_path}")
        preview_in = self.work_dir / "preview_input.png"
        extract_preview_png(self.video_path, preview_in, log=self.log)
        self._show_preview_file(preview_in, "元動画の1コマ")
        self._set_progress(0, "準備OK — ★ を押して透過処理を開始")

    def open_work(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(str(self.work_dir))

    def open_vr_video(self) -> None:
        p = vr_guide_path().parent
        p.mkdir(parents=True, exist_ok=True)
        os.startfile(str(p))

    def _lock_ui(self, busy: bool) -> None:
        state = tk.DISABLED if busy else tk.NORMAL
        self.btn_star.configure(state=state)

    def _finish_ok(self, out: Path, step: str) -> None:
        dest = None
        if out.is_file():
            if step in ("crop_white", "white", "smooth_all", "all", "assemble"):
                try:
                    dest = copy_to_vr_folder(out, log=self.log)
                except Exception as e:
                    self.log(f"[VR用] コピー失敗: {e}")
            else:
                self.log(f"保存: {out}（VR用は ④ のあと手動コピー）")
        self.refresh_preview()
        self._refresh_vr_status()
        self._set_progress(100, "完了")
        msg = "処理が完了しました。"
        if dest and dest.is_file():
            msg += f"\n\nVR用:\n{dest}\n\n次: ガイドVR貼り付け_起動.vbs で位置調整"
        elif out.is_file():
            msg += f"\n\n出力:\n{out}"
        else:
            msg += "\n\n（出力ファイルなし — ログを確認）"
        messagebox.showinfo("完了", msg)

    def _run_step(self, step: str) -> None:
        if self._busy:
            return
        need_video = step not in ("cutout", "assemble")
        if need_video and not self.video_path:
            messagebox.showwarning("未選択", "先に動画を選んでください。")
            return
        self._busy = True
        self._lock_ui(True)
        self._set_progress(2, f"開始: {step} …")

        frames = int(self.var_frames.get())
        video = self.video_path
        work = self.work_dir
        out = work / "guide_alpha.webm"

        def job() -> None:
            try:
                work.mkdir(parents=True, exist_ok=True)
                if step == "crop_white" and video:
                    cropped = work / f"{video.stem}_cropped.mp4"
                    crop_white_to_alpha_webm(
                        video,
                        out,
                        cropped_mp4=cropped,
                        bottom_crop_px=int(self.var_bottom_crop.get()),
                        log=self.log,
                        progress=self._progress_cb,
                    )
                    if out.is_file():
                        copy_to_vr_folder(out, log=self.log)
                elif step == "white" and video:
                    self._progress_cb(30, "白背景透過中…")
                    white_bg_to_alpha_webm(video, out, log=self.log)
                    extract_preview_png(out, work / "preview_output.png", log=self.log)
                    if out.is_file():
                        copy_to_vr_folder(out, log=self.log)
                elif step == "smooth_all" and video:
                    self._progress_cb(10, "全コマ切り出し中…")
                    extract_frames_native(
                        video, work / "frames", fps=30, work_dir=work, log=self.log
                    )
                    cutout_frames(
                        work / "frames",
                        "frame",
                        work / "cutout",
                        log=self.log,
                        progress=self._progress_cb,
                    )
                    self._progress_cb(82, "WebM に組み立て中…")
                    assemble_alpha_webm(
                        work / "cutout", "cutout", out, work_dir=work, log=self.log
                    )
                    if out.is_file():
                        copy_to_vr_folder(out, log=self.log)
                elif step == "extract" and video:
                    self._progress_cb(15, "切り出し中…")
                    extract_frames_count(
                        video, work / "frames", frames, work_dir=work, log=self.log
                    )
                    self._progress_cb(100, "切り出し完了 → ③ 透過へ")
                elif step == "cutout":
                    cutout_frames(
                        work / "frames",
                        "frame",
                        work / "cutout",
                        log=self.log,
                        progress=self._progress_cb,
                    )
                    self._progress_cb(100, "透過完了 → ④ 動画化へ")
                elif step == "assemble":
                    self._progress_cb(70, "動画化中…")
                    assemble_alpha_webm(
                        work / "cutout", "cutout", out, work_dir=work, log=self.log
                    )
                    if out.is_file():
                        copy_to_vr_folder(out, log=self.log)
                elif step == "all" and video:
                    self._progress_cb(8, "切り出し中…")
                    extract_frames_count(
                        video, work / "frames", frames, work_dir=work, log=self.log
                    )
                    cutout_frames(
                        work / "frames",
                        "frame",
                        work / "cutout",
                        log=self.log,
                        progress=self._progress_cb,
                    )
                    self._progress_cb(85, "動画化中…")
                    assemble_alpha_webm(
                        work / "cutout", "cutout", out, work_dir=work, log=self.log
                    )
                    if out.is_file():
                        copy_to_vr_folder(out, log=self.log)

                self.after(0, lambda: self._finish_ok(out, step))
            except Exception as e:
                err = str(e)
                self.log("[エラー] " + err)
                self.after(0, lambda: self._set_progress(0, "エラーで停止"))
                self.after(0, lambda: messagebox.showerror("エラー", err))
            finally:
                self.after(0, self._unlock)

        threading.Thread(target=job, daemon=True).start()

    def _unlock(self) -> None:
        self._busy = False
        self._lock_ui(False)


if __name__ == "__main__":
    try:
        GuideAlphaMakerUI().mainloop()
    except Exception as exc:
        import traceback

        try:
            _r = tk.Tk()
            _r.withdraw()
            messagebox.showerror(
                "1_透過を作る（起動エラー）",
                str(exc) + "\n\n" + traceback.format_exc()[-600:],
            )
            _r.destroy()
        except Exception:
            pass
        raise
