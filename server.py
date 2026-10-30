#!/usr/bin/env python3
"""拾光 TODO 本地服务。

职责：
1. 提供 index.html / css / js 等静态文件；
2. 记住数据文件夹的绝对路径，并代理应用对它的全部读写；
3. 调用系统文件管理器打开文件夹、定位文件。

只监听本机，校验请求来源；所有文件路径都限制在数据根目录内。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = Path(__file__).resolve().parent
CONFIG_FILE = APP_DIR / "config.json"
DATA_ROOT: Optional[Path] = None

MAX_TEXT_BYTES = 32 * 1024 * 1024       # 单个 Markdown 文件上限
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 单个附件上限 2 GB


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# ---------------------------------------------------------------- 配置


def load_config() -> None:
    global DATA_ROOT
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        DATA_ROOT = None
        return
    value = str(raw.get("dataRoot") or "").strip()
    if not value:
        DATA_ROOT = None
        return
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = APP_DIR / path
    DATA_ROOT = path.resolve()


def save_config(path: Path) -> None:
    payload = json.dumps({"dataRoot": str(path)}, ensure_ascii=False, indent=2) + "\n"
    tmp = CONFIG_FILE.with_name(f".{CONFIG_FILE.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)


def status_payload() -> dict:
    configured = DATA_ROOT is not None
    exists = bool(configured and DATA_ROOT.is_dir())
    return {
        "ok": True,
        "configured": configured,
        "exists": exists,
        "dataRoot": str(DATA_ROOT) if configured else "",
        "dirName": DATA_ROOT.name if configured else "",
    }


# ---------------------------------------------------------------- 路径


def root() -> Path:
    if DATA_ROOT is None:
        raise ApiError(409, "no-directory", "尚未选择数据文件夹")
    return DATA_ROOT


def query_one(parsed, name: str) -> str:
    # parse_qs 已按 UTF-8 解码百分号转义，这里不再二次 unquote
    params = parse_qs(parsed.query)
    return (params.get(name) or [""])[0]


def query_flag(parsed, name: str) -> bool:
    return query_one(parsed, name) == "1"


def safe_path(relative: str, *, allow_root: bool = False) -> Path:
    """把相对路径解析到数据根目录内，拒绝绝对路径、.. 和符号链接逃逸。"""
    base = root()
    rel = (relative or "").strip().replace("\\", "/").strip("/")
    if not rel:
        if allow_root:
            return base
        raise ApiError(400, "invalid-path", "缺少路径")
    if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
        raise ApiError(400, "invalid-path", "只接受相对路径")
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ApiError(400, "invalid-path", "路径不能包含 ..")
    target = (base / Path(*parts)).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise ApiError(400, "invalid-path", "路径越界")
    return target


def mtime_ms(path: Path) -> int:
    return int(path.stat().st_mtime_ns // 1_000_000)


def prune_empty(path: Path) -> None:
    """删除后向上清理空目录，但不越过月份目录。"""
    base = root()
    while path != base and path.is_dir() and not re.fullmatch(r"\d{4}-\d{2}", path.name):
        try:
            if any(path.iterdir()):
                break
            path.rmdir()
        except OSError:
            break
        path = path.parent


# ---------------------------------------------------------------- 目录选择


PICKER_SCRIPT = r"""
import ctypes
import sys


def enable_dpi_awareness():
    # Windows 默认把非 DPI 感知进程的窗口位图拉伸，导致高缩放屏上发虚
    if sys.platform != "win32":
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        set_context = user32.SetProcessDpiAwarenessContext
        set_context.argtypes = [ctypes.c_void_p]
        set_context.restype = ctypes.c_bool
        if set_context(ctypes.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
            return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# 必须在创建任何窗口之前调用
enable_dpi_awareness()

import tkinter as tk
from tkinter import filedialog

initial = sys.argv[1] if len(sys.argv) > 1 else ""
root = tk.Tk()
root.withdraw()
try:
    root.attributes("-topmost", True)
    root.update_idletasks()
    path = filedialog.askdirectory(
        parent=root,
        initialdir=initial or None,
        title="选择拾光 TODO 数据文件夹",
        mustexist=True,
    )
finally:
    root.destroy()
sys.stdout.write(path or "")
"""


def pick_folder(initial: str) -> str:
    try:
        proc = subprocess.run(
            [sys.executable, "-X", "utf8", "-c", PICKER_SCRIPT, initial],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        raise ApiError(500, "picker-timeout", "目录选择框超时，请重试")
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        reason = detail[-1] if detail else "未知错误"
        raise ApiError(500, "picker-failed", f"无法打开系统目录选择框：{reason}")
    return (proc.stdout or "").strip()


def choose_folder() -> dict:
    global DATA_ROOT
    initial = str(DATA_ROOT) if DATA_ROOT and DATA_ROOT.is_dir() else str(Path.home())
    chosen = pick_folder(initial)
    if not chosen:
        return {"ok": True, "canceled": True, **status_payload()}

    path = Path(chosen).expanduser()
    if not path.is_absolute():
        raise ApiError(400, "invalid-path", "请选择绝对路径")
    path = path.resolve()
    if not path.is_dir():
        raise ApiError(400, "invalid-path", "选择的不是文件夹")

    probe = path / f".shiguang-write-test-{uuid.uuid4().hex[:8]}"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise ApiError(403, "not-writable", f"该文件夹不可写：{exc}")

    DATA_ROOT = path
    save_config(path)
    return {"ok": True, "canceled": False, **status_payload()}


# ---------------------------------------------------------------- HTTP


class Handler(SimpleHTTPRequestHandler):
    server_version = "ShiguangTodo/2.0"

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(
            *args,
            directory=str(APP_DIR if directory is None else directory),
            **kwargs,
        )

    # ---------------- 基础响应 ----------------

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, err: ApiError) -> None:
        self.send_json(err.status, {"ok": False, "code": err.code, "error": err.message})

    def log_message(self, fmt, *args):
        # 静态资源日志太吵，只记录 API 与 4xx/5xx
        if self.path.startswith("/api/") or (len(args) > 1 and str(args[1]).startswith(("4", "5"))):
            super().log_message(fmt, *args)

    def allowed_origin(self) -> bool:
        """只允许本机页面调用，降低其他网页误触发的风险。"""
        origin = self.headers.get("Origin") or ""
        referer = self.headers.get("Referer") or ""
        port = self.server.server_port
        allowed = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}

        if origin:
            return origin in allowed
        if referer:
            return any(referer == base or referer.startswith(base + "/") for base in allowed)
        return True

    def read_body(self, limit: int) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(411, "length-required", "缺少 Content-Length")
        try:
            length = int(raw_length)
        except ValueError:
            raise ApiError(400, "bad-request", "Content-Length 无效")
        if length < 0 or length > limit:
            raise ApiError(413, "too-large", "内容过大")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ApiError(400, "bad-request", "请求体不完整")
        return data

    # ---------------- 路由 ----------------

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            # 配置里含本机绝对路径，不通过静态服务暴露
            try:
                requested = (APP_DIR / unquote(parsed.path).lstrip("/")).resolve()
            except (OSError, ValueError):
                requested = None
            if requested == CONFIG_FILE:
                self.send_error(404)
                return
            super().do_GET()
            return
        if not self.allowed_origin():
            self.fail(ApiError(403, "forbidden-origin", "仅允许本机页面调用"))
            return
        try:
            if parsed.path == "/api/health":
                self.send_json(200, {"ok": True, "version": self.server_version})
            elif parsed.path == "/api/status":
                self.send_json(200, status_payload())
            elif parsed.path == "/api/list":
                self.api_list(parsed)
            elif parsed.path == "/api/stat":
                self.api_stat(parsed)
            elif parsed.path == "/api/read":
                self.api_read(parsed)
            elif parsed.path == "/api/file":
                self.api_file(parsed)
            elif parsed.path == "/api/reveal":
                self.api_reveal(parsed)
            else:
                self.fail(ApiError(404, "not-found", "未知接口"))
        except ApiError as err:
            self.fail(err)
        except Exception as exc:  # noqa: BLE001
            self.fail(ApiError(500, "server-error", str(exc)))

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(405)
            return
        if not self.allowed_origin():
            self.fail(ApiError(403, "forbidden-origin", "仅允许本机页面调用"))
            return
        try:
            if parsed.path == "/api/select-folder":
                self.send_json(200, choose_folder())
            elif parsed.path == "/api/mkdir":
                target = safe_path(query_one(parsed, "path"))
                target.mkdir(parents=True, exist_ok=True)
                self.send_json(200, {"ok": True})
            elif parsed.path == "/api/upload":
                self.api_upload(parsed)
            elif parsed.path == "/api/copy-dir":
                self.api_copy_dir(parsed)
            else:
                self.fail(ApiError(404, "not-found", "未知接口"))
        except ApiError as err:
            self.fail(err)
        except Exception as exc:  # noqa: BLE001
            self.fail(ApiError(500, "server-error", str(exc)))

    def do_PUT(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/write":
            self.fail(ApiError(404, "not-found", "未知接口"))
            return
        if not self.allowed_origin():
            self.fail(ApiError(403, "forbidden-origin", "仅允许本机页面调用"))
            return
        try:
            self.api_write(parsed)
        except ApiError as err:
            self.fail(err)
        except Exception as exc:  # noqa: BLE001
            self.fail(ApiError(500, "server-error", str(exc)))

    def do_DELETE(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/entry":
            self.fail(ApiError(404, "not-found", "未知接口"))
            return
        if not self.allowed_origin():
            self.fail(ApiError(403, "forbidden-origin", "仅允许本机页面调用"))
            return
        try:
            self.api_delete(parsed)
        except ApiError as err:
            self.fail(err)
        except Exception as exc:  # noqa: BLE001
            self.fail(ApiError(500, "server-error", str(exc)))

    # ---------------- 文件操作 ----------------

    def api_list(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"), allow_root=True)
        if not target.is_dir():
            raise ApiError(404, "not-found", "目录不存在")
        entries = []
        for entry in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            try:
                kind = "directory" if entry.is_dir() else "file"
            except OSError:
                continue
            entries.append({"name": entry.name, "kind": kind})
        self.send_json(200, {"ok": True, "entries": entries})

    def api_stat(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        if not target.exists():
            self.send_json(200, {"ok": True, "exists": False})
            return
        kind = "directory" if target.is_dir() else "file"
        self.send_json(200, {
            "ok": True,
            "exists": True,
            "kind": kind,
            "mtime": mtime_ms(target),
            "size": target.stat().st_size,
        })

    def api_read(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        if not target.is_file():
            raise ApiError(404, "not-found", "文件不存在")
        raw = target.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(422, "not-text", "文件不是 UTF-8 文本")
        self.send_json(200, {"ok": True, "text": text, "mtime": mtime_ms(target)})

    def api_write(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        expect = self._query_optional(parsed, "expect")
        raw = self.read_body(MAX_TEXT_BYTES)
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(422, "not-text", "内容不是 UTF-8 文本")

        if expect is not None:
            exists = target.exists()
            if expect == "absent":
                if exists:
                    raise ApiError(409, "conflict", "文件已被外部创建")
            else:
                if not exists:
                    raise ApiError(409, "conflict", "文件已被外部删除")
                try:
                    expected = int(expect)
                except ValueError:
                    raise ApiError(400, "bad-request", "expect 参数无效")
                if mtime_ms(target) != expected:
                    raise ApiError(409, "conflict", "文件已被外部修改")

        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.tmp")
        try:
            tmp.write_bytes(raw)
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

        self.send_json(200, {"ok": True, "mtime": mtime_ms(target)})

    def api_upload(self, parsed) -> None:
        directory = safe_path(query_one(parsed, "dir"))
        original = query_one(parsed, "name") or "attachment"
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise ApiError(411, "length-required", "缺少 Content-Length")
        try:
            length = int(raw_length)
        except ValueError:
            raise ApiError(400, "bad-request", "Content-Length 无效")
        if length < 0 or length > MAX_UPLOAD_BYTES:
            raise ApiError(413, "too-large", "文件过大")

        directory.mkdir(parents=True, exist_ok=True)
        name = sanitize_filename(original)
        final = unique_path(directory, name)
        tmp = directory / f".upload-{uuid.uuid4().hex[:8]}.tmp"

        remaining = length
        try:
            with tmp.open("wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ApiError(400, "bad-request", "上传中断")
                    out.write(chunk)
                    remaining -= len(chunk)
            os.replace(tmp, final)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

        self.send_json(200, {"ok": True, "name": final.name})

    def api_file(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        if not target.is_file():
            raise ApiError(404, "not-found", "文件不存在")
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        size = target.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with target.open("rb") as src:
            shutil.copyfileobj(src, self.wfile)

    def api_copy_dir(self, parsed) -> None:
        source = safe_path(query_one(parsed, "from"))
        target = safe_path(query_one(parsed, "to"))
        if not source.is_dir():
            raise ApiError(404, "not-found", "源文件夹不存在")
        if source == target:
            self.send_json(200, {"ok": True, "targetExisted": True, "targetCreated": False})
            return
        existed = target.exists()
        if existed and not target.is_dir():
            raise ApiError(409, "conflict", "目标路径已被文件占用")
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copytree(source, target, dirs_exist_ok=True)
        except Exception:
            if not existed:
                shutil.rmtree(target, ignore_errors=True)
            raise
        self.send_json(200, {"ok": True, "targetExisted": existed, "targetCreated": not existed})

    def api_delete(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        if target == root():
            raise ApiError(400, "invalid-path", "不能删除数据根目录")
        if target.exists():
            if target.is_dir():
                if not query_flag(parsed, "recursive"):
                    raise ApiError(400, "bad-request", "删除目录需要 recursive=1")
                shutil.rmtree(target)
            else:
                target.unlink()
        if query_flag(parsed, "prune"):
            prune_empty(target.parent)
        self.send_json(200, {"ok": True})

    def api_reveal(self, parsed) -> None:
        target = safe_path(query_one(parsed, "path"))
        select = query_flag(parsed, "select")
        if not target.exists():
            raise ApiError(404, "not-found", f"路径不存在：{target}")
        open_in_file_manager(target, select)
        self.send_json(200, {"ok": True, "path": str(target)})

    @staticmethod
    def _query_optional(parsed, name: str) -> Optional[str]:
        params = parse_qs(parsed.query)
        values = params.get(name)
        if not values:
            return None
        return values[0]


# ---------------------------------------------------------------- 工具


def sanitize_filename(name: str) -> str:
    name = os.path.basename(str(name or "attachment"))
    name = re.sub(r"[<>:\"/\\|?*()\s\u0000-\u001f]", "_", name)
    name = re.sub(r"^_+|_+$", "", name)
    name = re.sub(r"[.\s]+$", "", name)
    if len(name) > 90:
        dot = name.rfind(".")
        if dot > 0:
            name = name[: max(1, 90 - len(name[dot:]))] + name[dot:]
        else:
            name = name[:90]
    return name or "attachment"


def unique_path(directory: Path, name: str) -> Path:
    candidate = directory / name
    if not candidate.exists():
        return candidate
    dot = name.rfind(".")
    base = name[:dot] if dot > 0 else name
    ext = name[dot:] if dot > 0 else ""
    index = 2
    while True:
        candidate = directory / f"{base}-{index}{ext}"
        if not candidate.exists():
            return candidate
        index += 1


def open_in_file_manager(path: Path, select: bool) -> None:
    if os.name == "nt":
        if path.is_dir():
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif select:
            # /select, 后不能有空格，必须和路径拼成一个参数
            subprocess.Popen(["explorer", f"/select,{path}"])
        else:
            os.startfile(str(path.parent))  # type: ignore[attr-defined]
        return

    target = path.parent if path.is_file() else path
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])


# ---------------------------------------------------------------- 入口


def main() -> None:
    parser = argparse.ArgumentParser(description="拾光 TODO 本地服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="端口，默认 8000")
    parser.add_argument("--data", help="直接指定数据文件夹，跳过界面选择")
    args = parser.parse_args()

    global DATA_ROOT
    load_config()
    if args.data:
        path = Path(args.data).expanduser().resolve()
        if not path.is_dir():
            parser.error(f"数据文件夹不存在：{path}")
        DATA_ROOT = path
        save_config(path)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"拾光 TODO: http://localhost:{args.port}")
    if DATA_ROOT and DATA_ROOT.is_dir():
        print(f"数据文件夹: {DATA_ROOT}")
    else:
        print("首次使用：在页面里点击「选择数据文件夹」。")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
