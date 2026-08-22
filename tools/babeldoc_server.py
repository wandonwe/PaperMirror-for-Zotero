#!/usr/bin/env python3
"""
PaperMirror 本地完整 PDF 翻译桥接服务 (BabelDOC / pdf2zh)

用途
    PaperMirror Zotero 插件把整篇 PDF 交给本服务做版面级翻译(段落识别、
    公式保护、自适应重排、重新生成 PDF)。本脚本只是一个薄桥:接收插件的
    请求,调用本机安装的 BabelDOC(优先)或 pdf2zh,把生成的 纯译文/双语
    PDF 返回给插件。

安装与启动
    pip install --upgrade babeldoc        # 或: pip install pdf2zh
    python babeldoc_server.py             # 默认监听 127.0.0.1:11017

隐私
    仅监听 127.0.0.1。请求中携带的 API Key 只用于当次调用你配置的翻译
    服务商,不落盘、不记日志。

协议 (与插件 src/translation/pdfService.ts 对应)
    POST /translate   JSON {filename, pdf_base64, lang_in, lang_out,
                            mono, dual, glossary?, provider?}
                      -> {"task_id": "..."}
    GET  /status?id=X -> {"state": "queued|running|done|error",
                          "progress": 0-100, "message": "..."}
    GET  /result?id=X&kind=mono|dual -> {"pdf_base64": "..."}
"""

import base64
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
PORT = int(os.environ.get("PAPERMIRROR_BRIDGE_PORT", "11017"))

TASKS = {}  # id -> {state, progress, message, mono, dual, dir}
LOCK = threading.Lock()


def which_engine():
    if shutil.which("babeldoc"):
        return "babeldoc"
    if shutil.which("pdf2zh"):
        return "pdf2zh"
    return None


def build_command(engine, pdf_path, out_dir, req):
    lang_in = req.get("lang_in") or "en"
    lang_out = req.get("lang_out") or "zh"
    provider = req.get("provider") or None
    if engine == "babeldoc":
        cmd = ["babeldoc", "--files", pdf_path,
               "--lang-in", lang_in, "--lang-out", lang_out,
               "--output", out_dir]
        if not req.get("dual", True):
            cmd.append("--no-dual")
        if not req.get("mono", True):
            cmd.append("--no-mono")
        env = {}
        if provider:
            cmd += ["--openai",
                    "--openai-model", provider.get("model") or "gpt-4o-mini",
                    "--openai-base-url", provider.get("baseURL") or "https://api.openai.com/v1"]
            # 密钥经环境变量而非命令行 (2.0.10, 审核 P3): argv 对同机所有用户
            # 经 ps / /proc/<pid>/cmdline 可见,整个导出任务期间(数分钟)持续
            # 暴露。openai SDK 默认读 OPENAI_API_KEY,babeldoc 未显式传参时
            # 走该回退;与 pdf2zh 分支同一纪律。
            env = {"OPENAI_API_KEY": provider.get("apiKey") or ""}
        return cmd, env
    # pdf2zh
    cmd = ["pdf2zh", pdf_path, "-li", lang_in, "-lo", lang_out, "-o", out_dir]
    env = {}
    if provider:
        cmd += ["-s", "openai"]
        env = {"OPENAI_BASE_URL": provider.get("baseURL") or "",
               "OPENAI_API_KEY": provider.get("apiKey") or "",
               "OPENAI_MODEL": provider.get("model") or ""}
    return cmd, env


def newest(pattern_list, out_dir):
    hits = []
    for pattern in pattern_list:
        hits += glob.glob(os.path.join(out_dir, "**", pattern), recursive=True)
    if not hits:
        return None
    return max(hits, key=os.path.getmtime)


def run_task(task_id, req):
    with LOCK:
        task = TASKS[task_id]
        task["state"] = "running"
        task["progress"] = 5
    try:
        engine = which_engine()
        if not engine:
            raise RuntimeError("未找到 babeldoc 或 pdf2zh,请先 pip install babeldoc")
        work = task["dir"]
        pdf_path = os.path.join(work, req.get("filename") or "input.pdf")
        with open(pdf_path, "wb") as f:
            f.write(base64.b64decode(req["pdf_base64"]))
        out_dir = os.path.join(work, "out")
        os.makedirs(out_dir, exist_ok=True)

        cmd, extra_env = build_command(engine, pdf_path, out_dir, req)
        env = dict(os.environ)
        env.update({k: v for k, v in extra_env.items() if v})
        with LOCK:
            task["progress"] = 15
            task["message"] = f"运行 {engine} …"
        # 注意:不把命令行(可能含密钥)打印到日志
        proc = subprocess.run(cmd, env=env, cwd=work,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=60 * 40)
        if proc.returncode != 0:
            # 只回传退出码 + 末行摘要 (2.0.10, 审核 P3): 完整 stdout 尾部可能
            # 含引擎回显的论文文本,经 task.message 进插件日志会违反「原文不
            # 进日志」的不变量。末行截 200 字符。
            lines = proc.stdout.decode("utf-8", "replace").strip().splitlines()
            last = (lines[-1] if lines else "")[:200]
            raise RuntimeError(f"{engine} 退出码 {proc.returncode}: {last}")

        mono = newest(["*mono*.pdf"], out_dir) or newest(["*mono*.pdf"], work)
        dual = newest(["*dual*.pdf"], out_dir) or newest(["*dual*.pdf"], work)
        if not mono and not dual:
            # 某些版本直接以 <name>.<lang>.pdf 输出
            any_pdf = newest(["*.pdf"], out_dir)
            if any_pdf and os.path.abspath(any_pdf) != os.path.abspath(pdf_path):
                mono = any_pdf
        if not mono and not dual:
            raise RuntimeError("引擎运行完成但未找到输出 PDF")
        with LOCK:
            task["mono"] = mono
            task["dual"] = dual
            task["progress"] = 100
            task["state"] = "done"
            task["message"] = "完成"
    except Exception as exc:  # noqa: BLE001
        with LOCK:
            task["state"] = "error"
            task["message"] = str(exc)[:2000]
    finally:
        with LOCK:
            task["finished_at"] = time.time()


REAP_TTL_SECONDS = 30 * 60


def reap_stale_tasks():
    # 临时目录回收 (2.0.10, 审核 P3): mkdtemp 的原文/译文 PDF 此前永不清理,
    # 论文长期落盘。终态 30 分钟后连目录带登记一并删除。
    while True:
        time.sleep(600)
        now = time.time()
        with LOCK:
            stale = [tid for tid, t in TASKS.items()
                     if t.get("finished_at") and now - t["finished_at"] > REAP_TTL_SECONDS]
            entries = [(tid, TASKS[tid].get("dir")) for tid in stale]
            for tid in stale:
                TASKS.pop(tid, None)
        for _tid, work in entries:
            if work:
                shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # 静默默认访问日志(路径含任务 id 即可)
        sys.stderr.write("[bridge] %s\n" % (fmt % args))

    def do_POST(self):
        if urlparse(self.path).path != "/translate":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length).decode("utf-8"))
            task_id = uuid.uuid4().hex
            work = tempfile.mkdtemp(prefix="papermirror-")
            with LOCK:
                TASKS[task_id] = {"state": "queued", "progress": 0,
                                  "message": "", "mono": None, "dual": None,
                                  "dir": work}
            threading.Thread(target=run_task, args=(task_id, req),
                             daemon=True).start()
            return self._json(200, {"task_id": task_id})
        except Exception as exc:  # noqa: BLE001
            return self._json(400, {"error": str(exc)})

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        task_id = (query.get("id") or [""])[0]
        with LOCK:
            task = TASKS.get(task_id)
        if parsed.path == "/status":
            if not task:
                return self._json(404, {"error": "unknown task"})
            return self._json(200, {"state": task["state"],
                                    "progress": task["progress"],
                                    "message": task["message"]})
        if parsed.path == "/result":
            if not task or task["state"] != "done":
                return self._json(404, {"error": "not ready"})
            kind = (query.get("kind") or ["mono"])[0]
            path = task.get(kind)
            if not path or not os.path.exists(path):
                return self._json(404, {"error": f"no {kind} result"})
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return self._json(200, {"pdf_base64": b64})
        return self._json(404, {"error": "not found"})


def main():
    engine = which_engine()
    print(f"PaperMirror 桥接服务  http://{HOST}:{PORT}")
    print(f"翻译引擎: {engine or '未安装!  pip install babeldoc'}")
    threading.Thread(target=reap_stale_tasks, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
