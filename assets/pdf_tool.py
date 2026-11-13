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
# 中日韩文字与全角标点：行尾断行时直接拼接，不插空格（中文没有词间空格）
CJK_RE = re.compile(r"[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]")
FIGURE_MIN_SIDE = 60.0          # 宽或高小于 60pt 的图按 logo/图标丢弃
FIGURE_MIN_AREA_RATIO = 0.015   # 面积小于页面 1.5% 的图同样丢弃
FIGURE_CAPTION_RE = re.compile(r"^(?:图|圖|figure|fig\.?)\s*([0-9]+|[ivxlcdm]+)", re.IGNORECASE)
_ROMAN_VALUES = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
# 宽度 ≥ 页宽这个比例的块算「全宽块」（标题/摘要/表格），用来把双栏页面切成带
WIDE_BLOCK_RATIO = 0.6


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


def _join_lines(lines):
    """把同一块里的多行拼成一段。

    PDF 在行尾断词，用空格硬拼会得到 `text- only` / `lin- guistic` 这种夹空格的写法。
    行尾是连字符时去掉空格、保留连字符：`text-only` 正好是对的，`lin-guistic` 虽然还
    差一个字母，但一眼还能认出是 linguistic（去掉连字符会得到 `textonly`，更糟）。
    """
    out = ""
    for line in lines:
        if not out:
            out = line
            continue
        if out.endswith("-") and re.match(r"[A-Za-z0-9]", line):
            out = out + line
        elif CJK_RE.match(out[-1]) and CJK_RE.match(line[0]):
            out = out + line           # 中文换行不插空格（"本文\n提出" -> "本文提出"）
        else:
            out = out + " " + line
    return out


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
    text = _join_lines(lines).strip()       # 行与行之间用空格拼成一段（行尾断词先合上）
    if not text or not any(ch.isalnum() for ch in text):  # 后者：纯线条/符号装饰块
        return None
    x, y, x2, y2 = (round(float(v), 2) for v in block.get("bbox") or (0, 0, 0, 0))
    size = round(statistics.median(char_sizes), 2) if char_sizes else 0.0
    return {"x": x, "y": y, "x2": x2, "y2": y2, "size": size,
            "bold": bold, "text": text}


def _roman_to_int(token):
    """图注里的罗马数字（Figure IV）转阿拉伯数字；非法返回 None。"""
    total, previous = 0, 0
    for char in reversed(str(token).lower()):
        value = _ROMAN_VALUES.get(char)
        if value is None:
            return None
        if value < previous:
            total -= value
        else:
            total += value
            previous = value
    return total or None


def _figure_label(text):
    """'图 3' / 'Figure IV' / 'Fig. 3: …' → 3 / 4 / 3；不是图注行返回 None。"""
    match = FIGURE_CAPTION_RE.match(text)
    if not match:
        return None
    token = match.group(1)
    return int(token) if token.isdigit() else _roman_to_int(token)


def _text_lines(page):
    """取该页所有文本行 [(文本, bbox)]；图注匹配只需要行级数据。"""
    lines = []
    for block in page.get_text("dict").get("blocks") or []:
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines") or []:
            text = " ".join(str(span.get("text") or "")
                            for span in line.get("spans") or []).strip()
            text = re.sub(r"\s+", " ", text)
            if text:
                lines.append((text, fitz.Rect(line.get("bbox") or (0, 0, 0, 0))))
    return lines


def _rect_gap(first, second):
    """两个矩形的最近距离平方；相交时为 0。"""
    dx = max(0.0, max(first.x0 - second.x1, second.x0 - first.x1))
    dy = max(0.0, max(first.y0 - second.y1, second.y0 - first.y1))
    return dx * dx + dy * dy


def cmd_figures(args):
    """取每页图片 bbox（get_image_info），过滤 logo/小图，就近匹配图注。

    图注只认行首的 图/圖/Figure/Fig.；取与图片矩形最近的一行（距离相同优先下方），
    label 规范化成阿拉伯数字。index 是该页按 (y,x) 排序后的序号，从 1 开始。
    """
    doc = open_doc(args)
    try:
        figures = []
        for index in range(int(doc.page_count)):
            page = doc.load_page(index)
            try:
                infos = page.get_image_info() or []
            except Exception:
                infos = []                 # 个别页图片信息坏了不影响其它页
            page_area = max(1.0, float(page.rect.width) * float(page.rect.height))
            captions = [(text, rect, _figure_label(text))
                        for text, rect in _text_lines(page)
                        if FIGURE_CAPTION_RE.match(text)]
            found, seen = [], set()
            # get_image_info 的 bbox 在「未旋转」坐标系里，而 page.rect / 渲染 clip
            # 用的是旋转后的坐标系；不转过来的话 /Rotate 90 的页面会裁出全白区域。
            rotation = getattr(page, "rotation_matrix", None)
            for info in infos:
                try:
                    rect = fitz.Rect(info.get("bbox"))
                    if rotation is not None and getattr(page, "rotation", 0):
                        rect = rect * rotation
                    rect = rect & page.rect
                except Exception:
                    continue
                if rect.width < FIGURE_MIN_SIDE or rect.height < FIGURE_MIN_SIDE:
                    continue               # 小图标/logo
                if rect.width * rect.height / page_area < FIGURE_MIN_AREA_RATIO:
                    continue
                key = (round(rect.x0, 1), round(rect.y0, 1),
                       round(rect.x1, 1), round(rect.y1, 1))
                if key in seen:            # 同一张图被多个对象引用时只留一条
                    continue
                seen.add(key)
                caption, label = None, None
                if captions:               # 最近的图注行；等距时优先图片下方那行
                    best = min(captions, key=lambda item: (
                        _rect_gap(rect, item[1]),
                        0 if item[1].y0 >= rect.y1 - 1 else 1,
                        item[1].y0))
                    caption, label = best[0], best[2]
                found.append((rect, caption, label))
            found.sort(key=lambda item: (item[0].y0, item[0].x0))
            for position, (rect, caption, label) in enumerate(found):
                figures.append({
                    "page": index + 1,
                    "x": round(rect.x0, 2), "y": round(rect.y0, 2),
                    "x2": round(rect.x1, 2), "y2": round(rect.y1, 2),
                    "width": round(rect.width, 2), "height": round(rect.height, 2),
                    "index": position + 1,
                    "caption": caption, "label": label,
                })
        return {"ok": True, "figures": figures}
    finally:
        doc.close()


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


def _y_span(items):
    return (min(item["y"] for item in items), max(item["y2"] for item in items))


def _is_two_column(left, right):
    """左右两簇块的纵向范围重叠够多才算真双栏（表格单元格也会落在左右两侧）。"""
    if len(left) < 2 or len(right) < 2:
        return False
    la, lb = _y_span(left)
    ra, rb = _y_span(right)
    overlap = min(lb, rb) - max(la, ra)
    span = max(lb, rb) - min(la, ra)
    return overlap > 0 and span > 0 and overlap >= 0.5 * span


def order_blocks(blocks, page_width):
    """按阅读顺序排块：全宽块切带，带内先左栏后右栏、各自按 y。

    只按 (y, x) 排会让双栏论文左右交错（左右栏的行基线并不对齐），而 doc.js 的
    段落合并、翻译、搜索都按数组顺序消费，顺序错了整篇都错。
    单栏页面几乎全是全宽块（宽度 ≥ 60% 页宽），行为与原来的 (y, x) 排序一致；
    表格那种左右都有窄块的情况会因为纵向不重叠而退回 (y, x)。
    """
    if not blocks:
        return blocks
    mid = page_width / 2.0
    wide = [item for item in blocks if (item["x2"] - item["x"]) >= page_width * WIDE_BLOCK_RATIO]
    narrow = [item for item in blocks if (item["x2"] - item["x"]) < page_width * WIDE_BLOCK_RATIO]
    if not wide or not narrow:
        return sorted(blocks, key=lambda item: (item["y"], item["x"]))
    left = [item for item in narrow if (item["x"] + item["x2"]) / 2 < mid]
    right = [item for item in narrow if (item["x"] + item["x2"]) / 2 >= mid]
    if not _is_two_column(left, right):
        return sorted(blocks, key=lambda item: (item["y"], item["x"]))
    wide.sort(key=lambda item: item["y"])
    order = lambda item: (0 if (item["x"] + item["x2"]) / 2 < mid else 1, item["y"], item["x"])
    narrow.sort(key=order)
    bands = [[] for _ in range(len(wide) + 1)]
    for block in narrow:  # 归属到它上方最近的全宽块之后
        index = 0
        for position, anchor in enumerate(wide):
            if anchor["y"] <= block["y"]:
                index = position + 1
            else:
                break
        bands[index].append(block)
    ordered = []
    for position, anchor in enumerate(wide):
        ordered.extend(bands[position])
        ordered.append(anchor)
    ordered.extend(bands[len(wide)])
    return ordered


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
            blocks = order_blocks(blocks, float(rect.width))  # 双栏页按栏排阅读顺序
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
        page = doc.load_page(number - 1)
        clip_rect = None
        clip_raw = args.get("clip")
        if clip_raw is not None:            # 可选：只渲染页面坐标系里的这块区域
            try:
                x, y, width, height = (float(value) for value in clip_raw)
            except (TypeError, ValueError):
                raise ArgsError("clip 参数不合法（需要 [x, y, w, h]）") from None
            if width <= 0 or height <= 0:
                raise ArgsError("clip 参数不合法（宽高必须大于 0）")
            clip_rect = fitz.Rect(x, y, x + width, y + height) & page.rect
            if clip_rect.width < 1 or clip_rect.height < 1:
                raise ArgsError("clip 区域不在页面范围内")
        out_raw = args.get("out")
        if not isinstance(out_raw, str) or not out_raw.strip():
            raise ArgsError("缺少 out 参数")
        out_path = Path(out_raw).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False,
                              clip=clip_rect)
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


def _build_sample_pdf(path):
    """现场生成一张自检用 PDF：标题 + 正文 + 一张图 + 图注 + 书签。"""
    doc = fitz.open()
    page = doc.new_page(width=400, height=360)
    page.insert_text((72, 80), "Self Test Title", fontsize=20)
    page.insert_text((72, 110), "Abstract", fontsize=11)
    page.insert_text((72, 130), "Generated sample for pdf_tool self test.",
                     fontsize=10)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 120), 0)
    pix.set_rect(pix.irect, (40, 120, 200))
    page.insert_image(fitz.Rect(72, 150, 272, 270), stream=pix.tobytes("png"))
    page.insert_text((72, 290), "Figure 1: sample image", fontsize=10)
    doc.set_toc([[1, "Introduction", 1]])
    tmp = Path(str(path) + ".tmp")
    doc.save(str(tmp))
    doc.close()
    tmp.replace(path)
    return path


def _png_bytes(path):
    try:
        return Path(path).read_bytes()
    except OSError:
        return b""


def self_test():
    started = time.perf_counter()
    if fitz is None:
        return fail("缺少 PyMuPDF(fitz)，请先安装：python -m pip install PyMuPDF")
    base = Path(tempfile.gettempdir())
    sample = base / "pb-selftest-sample.pdf"
    try:
        _build_sample_pdf(sample)
    except Exception as exc:
        return fail(f"生成自检样例失败：{exc}")
    info = cmd_info({"path": str(sample)})
    pages = info.get("pages") if info.get("ok") else 0
    if not isinstance(pages, int) or pages <= 0:
        return fail(f"info 检查失败：{info.get('error') or 'pages 不大于 0'}")
    if not info.get("hasText"):
        return fail("info 检查失败：自检样例应当有文字层")
    text = cmd_text({"path": str(sample), "pages": [1]})
    blocks = (text.get("pages") or [{}])[0].get("blocks") or []
    if not text.get("ok") or len(blocks) < 3:
        return fail(f"text 检查失败：{text.get('error') or f'第 1 页只有 {len(blocks)} 个文本块'}")
    joined = " ".join(item.get("text") or "" for item in blocks)
    if "Self Test Title" not in joined:
        return fail("text 检查失败：没有取到样例标题")
    png = base / "pb-selftest-page1.png"
    render = cmd_render({"path": str(sample), "page": 1, "scale": 1.5, "out": str(png)})
    data = _png_bytes(png)
    if not render.get("ok") or not data:
        return fail(f"render 检查失败：{render.get('error') or '没有生成 PNG'}")
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or render["bytes"] != len(data):
        return fail("render 产物不是有效 PNG（magic 或字节数不符）")
    if (render["width"], render["height"]) != (600, 540):
        return fail(f"render 尺寸不对：{render['width']}x{render['height']}（期望 600x540）")
    outline = cmd_outline({"path": str(sample)})
    titles = [item.get("title") for item in (outline.get("items") or [])]
    if not outline.get("ok") or "Introduction" not in titles:
        return fail(f"outline 检查失败：{outline.get('error') or titles}")
    figures = cmd_figures({"path": str(sample)})
    items = figures.get("figures") if figures.get("ok") else None
    if not isinstance(items, list) or len(items) != 1:
        return fail(f"figures 检查失败：{figures.get('error') or f'期望 1 张图，实际 {len(items or [])}'}")
    if items[0].get("label") != 1 or "sample image" not in (items[0].get("caption") or ""):
        return fail(f"figures 检查失败：图注/编号不对 {items[0].get('label')} {items[0].get('caption')!r}")
    clip_png = base / "pb-selftest-clip.png"
    clip = cmd_render({"path": str(sample), "page": 1, "scale": 1.0,
                       "clip": [72, 150, 200, 120], "out": str(clip_png)})
    clip_data = _png_bytes(clip_png)
    if not clip.get("ok") or not clip_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return fail(f"render clip 检查失败：{clip.get('error') or '不是有效 PNG'}")
    if (clip["width"], clip["height"]) != (200, 120):
        return fail(f"render clip 尺寸不对：{clip['width']}x{clip['height']}（期望 200x120）")
    rotated = base / "pb-selftest-rotated.pdf"
    try:
        _build_sample_pdf(rotated)
        rot_doc = fitz.open(str(rotated))
        rot_doc.load_page(0).set_rotation(90)
        rot_doc.save(str(rotated) + ".r")
        rot_doc.close()
        Path(str(rotated) + ".r").replace(rotated)
    except Exception as exc:
        return fail(f"生成旋转页样例失败：{exc}")
    rot_figures = cmd_figures({"path": str(rotated)})
    rot_items = rot_figures.get("figures") if rot_figures.get("ok") else None
    if not isinstance(rot_items, list) or len(rot_items) != 1:
        return fail(f"旋转页 figures 检查失败：{rot_figures.get('error') or '没取到图（坐标没跟着旋转）'}")
    if abs(rot_items[0].get("x", 0) - 90) > 3 or abs(rot_items[0].get("x2", 0) - 210) > 3:
        return fail("旋转页 figures 检查失败：bbox 还是未旋转坐标")
    two_column = [
        {"x": 10, "y": 20, "x2": 270, "y2": 32, "text": "header"},
        {"x": 10, "y": 60, "x2": 130, "y2": 72, "text": "L1"},
        {"x": 150, "y": 60, "x2": 270, "y2": 72, "text": "R1"},
        {"x": 10, "y": 100, "x2": 130, "y2": 112, "text": "L2"},
        {"x": 150, "y": 100, "x2": 270, "y2": 112, "text": "R2"},
        {"x": 10, "y": 200, "x2": 270, "y2": 212, "text": "footer"},
    ]
    ordered = [item["text"] for item in order_blocks(two_column, 280)]
    expect = ["header", "L1", "L2", "R1", "R2", "footer"]
    if ordered != expect:
        return fail(f"order_blocks 检查失败：{ordered}（期望先左栏后右栏 {expect}）")
    checks = [f"info: pages={pages} hasText={info['hasText']} toc={len(info['toc'])}",
              f"text: page1 blocks={len(blocks)}",
              f"render: bytes={len(data)} {render['width']}x{render['height']}",
              f"outline: items={len(outline['items'])}",
              f"figures: {len(items)} items label={items[0].get('label')}",
              f"render clip: bytes={len(clip_data)} {clip['width']}x{clip['height']}",
              f"rotated figures: {len(rot_items)} items page={rot_items[0].get('page')}",
              f"sample={sample}"]
    return {"ok": True, "checks": checks, "ms": int((time.perf_counter() - started) * 1000)}


HANDLERS = {"info": cmd_info, "text": cmd_text, "outline": cmd_outline,
            "render": cmd_render, "figures": cmd_figures}


def main(argv):
    command = argv[1].lower() if len(argv) > 1 else ""
    try:
        if "--self-test" in argv[1:]:
            payload = self_test()
        elif not command:
            payload = fail("缺少命令（info | text | outline | render | figures）")
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
