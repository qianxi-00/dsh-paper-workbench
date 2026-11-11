#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH 论文工作台 · Python 侧 PDF 工具（单文件）。
宿主以子进程调用（python assets/pdf_tool.py <command>，参数走 stdin JSON），
stdout 只写一行 JSON；失败也尽量 exit 0。输入 PDF 只读，依赖标准库 + PyMuPDF。"""
import json, os, re, statistics, sys, tempfile, time, traceback
from pathlib import Path
try:
    import fitz  # PyMuPDF
except Exception:
    fitz = None

BOLD_MARKS = ("bold", "black", "heavy", "semibold")
NUMERIC_PAGE_RE = re.compile(r"^[\W_]*\d{1,4}[\W_]*$")
CHINESE_PAGE_RE = re.compile(r"^第\s*\d+\s*页(?:\s*[/／]\s*共?\s*\d+\s*页)?$")
ROMAN_PAGE_RE = re.compile(r"^[ivxlcdm]{1,7}$", re.IGNORECASE)
SAMPLE_PDF = Path(r"G:\笔记\LLM知识体系论文\高效微调\Prompt Tuning.pdf")
HEURISTIC_RATIO, MAX_TITLE_LEN, SIZE_TOLERANCE, MAX_LEVELS = 1.12, 120, 0.94, 3


class ArgsError(Exception):
    """输入/参数错误，统一转成 {"ok":false,"error":...}。"""


def fail(message):
    return {"ok": False, "error": message}


def read_args():
    """读 stdin 的 JSON；读不到 / 非法 / 不是对象都报契约里的固定错误。"""
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b""
    for encoding in ("utf-8-sig", "gbk"):  # 兼容个别本地终端重定向出来的 GBK
        try:
            args = json.loads(raw.decode(encoding))
        except (UnicodeDecodeError, ValueError):
            continue
        if isinstance(args, dict):
            return args
    raise ArgsError("参数不是合法 JSON")


def open_doc(args):
    """只读打开 PDF；需要口令的加密文档按契约报错。"""
    if fitz is None:
        raise ArgsError("缺少 PyMuPDF(fitz)，请先安装：python -m pip install PyMuPDF")
    raw = args.get("path")
    path = Path(raw).expanduser() if isinstance(raw, str) and raw.strip() else None
    if path is None:
        raise ArgsError("缺少 path 参数")
    if not path.is_file():
        raise ArgsError(f"文件不存在：{path}")
    try:
        doc = fitz.open(str(path))
    except Exception as exc:
        raise ArgsError(f"打开 PDF 失败：{exc}") from exc
    if getattr(doc, "needs_pass", False):
        doc.close()
        raise ArgsError("PDF 已加密，无法读取")
    return doc


def _span_meta(span):
    """返回 (原始文本, 字号, 小写字体名)。"""
    return (str(span.get("text") or "").replace("\u00a0", " "),
            float(span.get("size") or 0), str(span.get("font") or "").lower())


def _block_record(block):
    """把 get_text("dict") 的一个文本块压成契约行；空块/纯装饰块返回 None。"""
    if block.get("type", 0) != 0:
        return None
    lines, char_sizes, bold = [], [], False
    for line in block.get("lines") or []:
        pieces = []
        for raw, size, font in map(_span_meta, line.get("spans") or []):
            if not raw.strip():
                continue
            pieces.append(raw)              # 行内 span 直接拼接，保留原始空格
            bold = bold or any(mark in font for mark in BOLD_MARKS)
            if size > 0:                    # 按字符数重复字号，中位数才是字符中位数
                char_sizes.extend([size] * len(raw.strip()))
        text = re.sub(r"\s+", " ", "".join(pieces)).strip()
        if text:
            lines.append(text)
    text = " ".join(lines).strip()          # 行与行之间用空格拼成一段
    if not text or not any(ch.isalnum() for ch in text):  # 后者：纯线条/符号装饰块
        return None
    x, y, x2, y2 = (round(float(v), 2) for v in block.get("bbox") or (0, 0, 0, 0))
    size = round(statistics.median(char_sizes), 2) if char_sizes else 0.0
    return {"x": x, "y": y, "x2": x2, "y2": y2, "size": size,
            "bold": bold, "text": text}


def cmd_info(args):
    doc = open_doc(args)
    try:
        pages = int(doc.page_count)
        has_text = False
        for index in range(min(3, pages)):  # 前 3 页至少一页有 >= 50 个非空白字符
            try:
                text = doc.load_page(index).get_text("text") or ""
            except Exception:
                continue
            if len(re.sub(r"\s+", "", text)) >= 50:
                has_text = True
                break
        try:
            entries = doc.get_toc() or []
            toc = [{"level": max(1, int(entry[0])),
                    "title": " ".join(str(entry[1] or "").split()),
                    "page": max(1, int(entry[2]))} for entry in entries]
            toc = [item for item in toc if item["title"]]
        except (TypeError, ValueError, IndexError):
            toc = []
        return {"ok": True, "pages": pages, "hasText": has_text, "toc": toc,
                "encrypted": bool(getattr(doc, "is_encrypted", False))}
    finally:
        doc.close()


def cmd_text(args):
    doc = open_doc(args)
    try:
        page_count = int(doc.page_count)
        raw = args.get("pages", "all")
        if raw is None or (isinstance(raw, str) and raw.strip().lower() == "all"):
            numbers = list(range(1, page_count + 1))
        elif isinstance(raw, list):
            try:  # 去重但保留请求顺序
                numbers = list(dict.fromkeys(int(value) for value in raw))
            except (TypeError, ValueError):
                raise ArgsError("pages 参数不合法") from None
        else:
            raise ArgsError("pages 参数不合法")
        pages, missing = [], []
        for number in numbers:
            if number < 1 or number > page_count:
                missing.append(number)      # 页不存在：跳过并记录
                continue
            page = doc.load_page(number - 1)
            rect = page.rect
            blocks = [record for record in
                      map(_block_record, page.get_text("dict").get("blocks") or []) if record]
            blocks.sort(key=lambda item: (item["y"], item["x"]))  # 契约：按 (y,x) 排序
            pages.append({"n": number, "w": round(float(rect.width), 2),
                          "h": round(float(rect.height), 2), "blocks": blocks})
        result = {"ok": True, "pages": pages}
        if missing:
            result["missing"] = missing
        return result
    finally:
        doc.close()


def _clustered_body_size(size_chars):
    """取正文字号：size_chars = {字号: 字符数}。

    PDF 里同一视觉字号常因缩放抖动被拆成多个值（样例正文散在 10.8~11.02），
    取单个字号众数会选偏小的值、把正文全判成标题。故按 ±6% 相对容差聚簇，
    取字符总量最大的簇（正文占字符最多），簇内最大字号作 body_size。"""
    clusters = []  # [簇代表字号, 字符数]
    for size in sorted(size_chars, reverse=True):
        if clusters and size >= clusters[-1][0] * SIZE_TOLERANCE:
            clusters[-1][1] += size_chars[size]
        else:
            clusters.append([size, size_chars[size]])
    return max(clusters, key=lambda item: item[1])[0] if clusters else 0.0


def _heuristic_outline(doc):
    """无书签时的字号启发式，返回 (items, True)。

    1. 扫所有页的 span 按字符数统计字号，聚簇后取字符量最大的字号作 body_size；
    2. 字号 >= body_size*1.12、长度 <= 120、非纯数字/页码的行是候选，
       同一行的多个 span（编号常和标题拆开）合并成一条；
    3. 候选字号从大到小聚簇，依次定为 1/2/3 级，最多 3 级；
    4. 同页同标题去重，按页序稳定输出（页内保留抽取顺序，对双栏更接近阅读顺序）。
    """
    size_chars, rows = {}, []
    for index in range(int(doc.page_count)):
        for block in doc.load_page(index).get_text("dict").get("blocks") or []:
            if block.get("type", 0) != 0:
                continue
            for line in block.get("lines") or []:
                pieces, size = [], 0.0
                for raw, span_size, _font in map(_span_meta, line.get("spans") or []):
                    if not raw.strip() or span_size <= 0:
                        continue
                    pieces.append(raw)
                    size = max(size, span_size)
                    size_chars[span_size] = size_chars.get(span_size, 0) + len(raw.strip())
                text = re.sub(r"\s+", " ", "".join(pieces)).strip()
                if text:
                    rows.append((index + 1, round(size, 1), text))
    if not size_chars:
        return [], True  # 扫描件没有文字层，大纲只能为空
    threshold = _clustered_body_size(size_chars) * HEURISTIC_RATIO
    candidates = [row for row in rows if row[1] >= threshold and len(row[2]) <= MAX_TITLE_LEN
                  and not (NUMERIC_PAGE_RE.match(row[2]) or CHINESE_PAGE_RE.match(row[2])
                           or ROMAN_PAGE_RE.match(row[2]))]
    reps = []
    for size in sorted({row[1] for row in candidates}, reverse=True):
        if not reps or size < reps[-1] * SIZE_TOLERANCE:
            reps.append(size)
    items, seen = [], set()
    for page, size, text in sorted(candidates, key=lambda row: row[0]):
        if (page, text) in seen:            # 同页同标题只留一个
            continue
        seen.add((page, text))
        level = next((i + 1 for i, rep in enumerate(reps)
                      if size >= rep * SIZE_TOLERANCE), MAX_LEVELS)
        items.append({"level": min(level, MAX_LEVELS), "title": text, "page": page})
    return items, True


def cmd_outline(args):
    doc = open_doc(args)
    try:
        try:
            entries = doc.get_toc() or []
        except Exception:
            entries = []
        if entries:  # 有原生书签就用它，页码从 1 开始
            items = []
            for entry in entries:
                try:
                    level, title, page = (int(entry[0]),
                                          " ".join(str(entry[1] or "").split()),
                                          int(entry[2]))
                except (TypeError, ValueError, IndexError):
                    continue
                if title:
                    items.append({"level": max(1, level), "title": title,
                                  "page": max(1, page)})
            return {"ok": True, "items": items}
        items, heuristic = _heuristic_outline(doc)
        return {"ok": True, "items": items, "heuristic": heuristic}
    finally:
        doc.close()


def cmd_render(args):
    doc = open_doc(args)
    try:
        page_count = int(doc.page_count)
        try:
            number, scale = int(args.get("page", 1)), float(args.get("scale", 2.0))
        except (TypeError, ValueError):
            raise ArgsError("page/scale 参数不合法") from None
        if number < 1 or number > page_count:
            raise ArgsError(f"页码超出范围：{number}（共 {page_count} 页）")
        scale = max(0.5, min(4.0, scale))   # 契约：限制在 [0.5, 4]
        out_raw = args.get("out")
        if not isinstance(out_raw, str) or not out_raw.strip():
            raise ArgsError("缺少 out 参数")
        out_path = Path(out_raw).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pix = doc.load_page(number - 1).get_pixmap(
            matrix=fitz.Matrix(scale, scale), alpha=False)
        data = pix.tobytes("png")
        tmp_path = out_path.with_name(out_path.name + ".tmp")
        try:
            with open(tmp_path, "wb") as handle:  # 先写 <out>.tmp，再原子替换
                handle.write(data)
                handle.flush()
            os.replace(tmp_path, out_path)
        except OSError as exc:
            raise ArgsError(f"写入 PNG 失败：{exc}") from exc
        return {"ok": True, "path": str(out_path), "bytes": len(data),
                "width": pix.width, "height": pix.height}
    finally:
        doc.close()


def self_test():
    started = time.perf_counter()
    if fitz is None:
        return fail("缺少 PyMuPDF(fitz)，请先安装")
    if not SAMPLE_PDF.is_file():  # 约定样例；自检产物只写 %TEMP%，不进仓库
        return fail(f"找不到自检样例 PDF：{SAMPLE_PDF}")
    info = cmd_info({"path": str(SAMPLE_PDF)})
    pages = info.get("pages") if info.get("ok") else 0
    if not isinstance(pages, int) or pages <= 0:
        return fail(f"info 检查失败：{info.get('error') or 'pages 不大于 0'}")
    text = cmd_text({"path": str(SAMPLE_PDF), "pages": [1]})
    blocks = (text.get("pages") or [{}])[0].get("blocks") or []
    if not text.get("ok") or not blocks:
        return fail(f"text 检查失败：{text.get('error') or '第 1 页没有文本块'}")
    png = Path(tempfile.gettempdir()) / "pb-selftest-page1.png"
    render = cmd_render({"path": str(SAMPLE_PDF), "page": 1, "scale": 1.5, "out": str(png)})
    data = png.read_bytes() if render.get("ok") else b""
    if not render.get("ok") or len(data) <= 1000:
        return fail(f"render 检查失败：{render.get('error') or f'产物过小 {len(data)} 字节'}")
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or render["bytes"] != len(data):
        return fail("render 产物不是有效 PNG（magic 或字节数不符）")
    outline = cmd_outline({"path": str(SAMPLE_PDF)})
    if not outline.get("ok") or not isinstance(outline.get("items"), list):
        return fail(f"outline 检查失败：{outline.get('error')}")
    checks = [f"info: pages={pages} hasText={info['hasText']} toc={len(info['toc'])}",
              f"text: page1 blocks={len(blocks)}",
              f"render: bytes={len(data)} {render['width']}x{render['height']}",
              f"outline: items={len(outline['items'])} outlineOk",
              f"sample={SAMPLE_PDF}"]
    return {"ok": True, "checks": checks, "ms": int((time.perf_counter() - started) * 1000)}


HANDLERS = {"info": cmd_info, "text": cmd_text, "outline": cmd_outline, "render": cmd_render}


def main(argv):
    command = argv[1].lower() if len(argv) > 1 else ""
    try:
        if "--self-test" in argv[1:]:
            payload = self_test()
        elif not command:
            payload = fail("缺少命令（info | text | outline | render）")
        elif command not in HANDLERS:
            payload = fail(f"未知命令：{command}")
        else:
            payload = HANDLERS[command](read_args())
    except ArgsError as exc:
        payload = fail(str(exc))
    except Exception as exc:  # 兜底：意外错误也输出一行 JSON，栈写 stderr
        traceback.print_exc(file=sys.stderr)
        payload = fail(f"处理失败：{exc}")
    # stdout 只写一行 UTF-8 JSON；Windows 管道下 print 会用本地编码，不能用
    sys.stdout.buffer.write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
