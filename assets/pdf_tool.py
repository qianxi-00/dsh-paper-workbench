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
FIGURE_CAPTION_RE = re.compile(
    r"^(?:图|圖|表|figure|fig\.?|table|algorithm|算法)\s*([0-9]+[a-z]?|[ivxlcdm]+)\b",
    re.IGNORECASE)
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



# ---------------------------------------------------------------- 版面辅助

CAPTION_START_RE = re.compile(
    r"^(?:图|圖|表|figure|fig\.?|table|algorithm|算法)\s*([0-9]+[a-z]?|[ivxlcdm]+)\b", re.IGNORECASE)
BULLET_RE = re.compile(r"^(?:[•●▪▸►◦‣·\-–—*]\s+|\d{1,2}[.)]\s+|\([a-z0-9]{1,3}\)\s+)", re.IGNORECASE)
SENTENCE_END = (".", "!", "?", ":", "。", "！", "？", "：", ";", "；")


def _clean_inline(text):
    """压掉行内多余空白，全角空格留一个普通空格。"""
    return re.sub(r"\s+", " ", str(text or "").replace("\u00a0", " ")).strip()


def _native_size(page):
    """页面在 PDF 原生（未旋转）坐标系里的宽高。"""
    rect = page.rect
    if getattr(page, "rotation", 0) in (90, 270):
        return float(rect.height), float(rect.width)
    return float(rect.width), float(rect.height)


def _page_matrix(page):
    """旋转页的坐标变换：get_text 给的是未旋转坐标，渲染/裁剪用的是旋转后坐标。"""
    return page.rotation_matrix if getattr(page, "rotation", 0) else None


def _line_records(block):
    """把一个文本块的每一行拆成 {text, rect, size, bold}（PDF 原生坐标，未旋转）。"""
    out = []
    for line in block.get("lines") or []:
        pieces, char_sizes, bold = [], [], False
        for span in line.get("spans") or []:
            raw = str(span.get("text") or "")
            font = str(span.get("font") or "").lower()
            size = float(span.get("size") or 0)
            if raw.strip():
                pieces.append(raw)
                bold = bold or any(mark in font for mark in BOLD_MARKS)
                if size > 0:
                    char_sizes.extend([size] * len(raw.strip()))
        text = _clean_inline("".join(pieces))
        if not text:
            continue
        rect = fitz.Rect(line.get("bbox") or (0, 0, 0, 0))
        out.append({
            "text": text,
            "rect": rect,
            "size": round(statistics.median(char_sizes), 2) if char_sizes else 0.0,
            "bold": bold,
        })
    return out


def _page_body_size(info, fallback):
    """该页自己的正文字号：附录/参考文献页往往比正文小一档，用全篇字号会把它们全判成脚注。"""
    chars = []
    for line in info["lines"]:
        size = line["size"]
        if 3.0 <= size <= 40.0 and len(line["text"]) >= 20:
            chars.extend([size] * len(line["text"]))
    size = round(statistics.median(chars), 2) if chars else 0.0
    return size or fallback


def _doc_body_size(pages):
    """全篇正文字号：按字符数投票的中位数（跨页统计，避免被某一页的表格带偏）。"""
    chars = []
    for page in pages:
        for line in page["lines"]:
            size = line["size"]
            if 3.0 <= size <= 40.0 and len(line["text"]) >= 20:
                chars.extend([size] * len(line["text"]))
    return round(statistics.median(chars), 2) if chars else 10.0


def _caption_lines(page):
    """行首是「图 N / Figure N / Table N」的图注行。"""
    found = []
    for line in page["lines"]:
        if not _is_caption_line(line["text"]):
            continue
        lowered = line["text"][:8].lower().lstrip()
        kind = "table" if lowered.startswith(("table", "表")) else "figure"
        found.append({"line": line, "label": _figure_label(line["text"]), "kind": kind})
    return found


def _drawing_clusters(page):
    """矢量图区域：PyMuPDF 的 cluster_drawings() 把相邻绘图合成矩形。

    页眉那条分隔横线也会被合成一个又扁又宽的簇，留着它会让裁出来的图上多一条页眉：
    宽度接近整页、高度不到 8pt 的细条直接丢掉。
    """
    try:
        clusters = [fitz.Rect(rect) for rect in page.cluster_drawings()]
    except Exception:
        return []
    width = _native_size(page)[0]
    kept = []
    for rect in clusters:
        if rect.height < 3 or rect.width < 3:
            continue
        if rect.height < 8 and rect.width > width * 0.6:
            continue
        kept.append(rect)
    return kept


def _image_boxes(page):
    """页面上的位图 bbox（旋转页换成渲染坐标系），已过滤图标。"""
    boxes = []
    try:
        infos = page.get_image_info() or []
    except Exception:
        return boxes
    page_area = max(1.0, float(page.rect.width) * float(page.rect.height))
    native = fitz.Rect(0, 0, _native_size(page)[0], _native_size(page)[1])
    for info in infos:
        try:
            rect = fitz.Rect(info.get("bbox")) & native
        except Exception:
            continue
        if rect.width < FIGURE_MIN_SIDE or rect.height < FIGURE_MIN_SIDE:
            continue
        if rect.width * rect.height / page_area < FIGURE_MIN_AREA_RATIO:
            continue
        boxes.append(rect)
    return boxes


def _merge_rects(rects):
    """把相交/相邻的矩形并成一块（图里常有好几个绘图簇）。"""
    out = []
    for rect in rects:
        merged = fitz.Rect(rect)
        rest = []
        for other in out:
            if (merged & other).get_area() > 0 or _rect_touch(merged, other, 8.0):
                merged |= other
            else:
                rest.append(other)
        rest.append(merged)
        out = rest
    return out


def _rect_touch(first, second, gap):
    dx = max(0.0, max(first.x0 - second.x1, second.x0 - first.x1))
    dy = max(0.0, max(first.y0 - second.y1, second.y0 - first.y1))
    return dx <= gap and dy <= gap


def _page_info(page):
    """把一页压成后面各步都要用的小结构（文本行 + 配图区域）。"""
    rect = page.rect
    rotated = getattr(page, "rotation", 0) in (90, 270)
    native_w, native_h = (float(rect.height), float(rect.width)) if rotated else (float(rect.width), float(rect.height))
    return {
        "page": page,
        "h": float(page.rect.height),
        "wn": native_w,
        "hn": native_h,
        "matrix": _page_matrix(page),
        "lines": [line for block in (page.get_text("dict").get("blocks") or [])
                  if block.get("type", 0) == 0
                  for line in _line_records(block)],
    }


def _figure_regions(info, body_size=0.0, repeated=None):
    """本页的配图区域：图注上/下方那一整条「没有正文」的带子。

    只看绘图簇不够：图里的文字标签（"SRAM: 19 TB/s"、"Outer Loop"…）往往落在簇与簇之间，
    按簇判定会漏掉它们、于是被当成正文段落塞进对照视图（真机上就是这么坏的）。
    这里改为：以图注为界，往上/往下找到最近的正文行，中间那块就是图。
    返回 [{rect, caption, label, kind}]。
    """
    page = info["page"]
    lines = info["lines"]
    height = info.get("hn") or info["h"] or float(page.rect.height)
    width = info.get("wn") or float(page.rect.width)
    captions = _caption_lines(info)
    if not captions:
        return []
    # 找「最近的正文行」时要用真·正文字号：图里的坐标轴标签往往只小一档（8.9 vs 10.8），
    # 用 0.82 会把它们当成正文，于是带子被切得只剩几 pt，整张图落空（RETRO 第 29 页 Figure 7）。
    threshold = (body_size or 10.0) * 0.95
    margin = height * 0.06
    skip = repeated or set()
    body_lines = [line for line in lines
                  if (line["size"] or 0) >= threshold and not _is_caption_line(line["text"])
                  and _repeat_key(line["text"]) not in skip
                  and line["rect"].y0 > margin and line["rect"].y1 < height - margin]
    clusters = list(_drawing_clusters(page)) + _image_boxes(page)
    def band_ink(y0, y1):
        if y1 - y0 < 36:
            return []
        found = [rect for rect in clusters if rect.y0 < y1 and rect.y1 > y0]
        # 只算「图里的字」：正文大小的行不可能真在图里，多半是页眉/页脚（arxiv 论文每页都印标题），
        # 把它算进 ink 会让裁出来的图顶上多一条页眉。
        found += [item["rect"] for item in lines
                  if item["rect"].y0 < y1 and item["rect"].y1 > y0
                  and not _is_caption_line(item["text"])
                  and _repeat_key(item["text"]) not in skip
                  and (item["size"] or 0) < (body_size or 10.0) * 0.95]
        return found

    regions = []
    for caption in captions:
        line = caption["line"]
        above = [item for item in body_lines if item["rect"].y1 <= line["rect"].y0 + 1]
        bottom = max((item["rect"].y1 for item in above), default=height * 0.05) + 3
        below = [item for item in body_lines if item["rect"].y0 >= line["rect"].y1 - 1]
        top2 = line["rect"].y1 + 3
        bottom2 = min((item["rect"].y0 for item in below), default=height * 0.95) - 3
        # 图注可能在图下方（图在上）、也可能在表格上方（表在下）：两条带都试，取真有东西的那条。
        # 只看「上方带」会让页顶的大表整页丢区域（Table 14 就是把 173 个单元格塞成了 footnote）。
        candidates = []
        for y0, y1 in ((bottom, line["rect"].y0 - 3), (top2, bottom2)):
            inside = band_ink(y0, y1)
            if not inside:
                continue
            ink_area = sum(max(1.0, rect.get_area()) for rect in inside)
            candidates.append((ink_area, y1 - y0, y0, y1, inside))
        if not candidates:
            continue
        candidates.sort(key=lambda item: (-item[0], -item[1]))
        _area, _tall, y0, y1, inside = candidates[0]
        ink = fitz.Rect(inside[0])
        for rect in inside[1:]:
            ink |= rect
        ink.y0 = max(y0, ink.y0 - 4)
        ink.y1 = min(y1, ink.y1 + 4)
        left = max(24.0, ink.x0 - 12)
        right = min(width - 24, ink.x1 + 12)
        rect = fitz.Rect(left, ink.y0, right, ink.y1) & fitz.Rect(0, 0, width, height)
        if rect.width < 60 or rect.height < 24:
            continue
        regions.append({"rect": _to_rendered(info, rect), "caption": line["text"],
                        "label": caption["label"], "kind": caption["kind"]})
    return regions


def _table_regions(info, body_size=0.0, repeated=None):
    """整页/半页的表格：一簇字号明显小于正文、列很多的紧密行。

    这类内容按正文段落输出会变成几百个「单元格就是一段」的垃圾（RETRO 的 Table 14 就是这样：
    173 个 8.5pt 单元格被当成 173 段落）。这里按「小字密簇」整体框出来，交给配图管线裁成一张图。
    """
    page = info["page"]
    height = info.get("hn") or info["h"] or float(page.rect.height)
    width = info.get("wn") or float(page.rect.width)
    threshold = (body_size or 10.0) * 0.95
    margin = height * 0.05
    skip = repeated or set()
    small = [line for line in info["lines"]
             if len(line["text"]) >= 1 and (line["size"] or 0) < threshold
             and not _is_caption_line(line["text"]) and _repeat_key(line["text"]) not in skip
             and line["rect"].y0 > margin and line["rect"].y1 < height - margin]
    small.sort(key=lambda line: (line["rect"].y0, line["rect"].x0))
    groups, current = [], []
    for line in small:
        if current and line["rect"].y0 - current[-1]["rect"].y1 > max(2.0, (line["size"] or 8.0) * 1.1):
            groups.append(current)
            current = []
        current.append(line)
    if current:
        groups.append(current)
    captions = _caption_lines(info)
    regions = []
    for group in groups:
        if len(group) < 8:
            continue
        rect = fitz.Rect(group[0]["rect"])
        for line in group[1:]:
            rect |= line["rect"]
        if rect.height < 40 or rect.width < width * 0.45:
            continue
        columns = len({round(line["rect"].x0 / 6.0) for line in group})
        if columns < 3:
            continue
        caption, label, kind = None, None, "table"
        if captions:
            best = min(captions, key=lambda item: _rect_gap(rect, item["line"]["rect"]))
            if _rect_gap(rect, best["line"]["rect"]) <= 72:
                caption, label, kind = best["line"]["text"], best["label"], best["kind"]
                cap_rect = best["line"]["rect"]
                # 别把图注本身裁进图里：前端会在图下面单独显示图注，裁进去就会出现两遍。
                if cap_rect.y1 <= rect.y0:
                    rect = fitz.Rect(rect.x0, max(rect.y0, cap_rect.y1 + 2), rect.x1, rect.y1)
                elif cap_rect.y0 >= rect.y1:
                    rect = fitz.Rect(rect.x0, rect.y0, rect.x1, min(rect.y1, cap_rect.y0 - 2))
        rect = fitz.Rect(max(24.0, rect.x0 - 10), max(12.0, rect.y0 - 4),
                         min(width - 20, rect.x1 + 10), min(height - 12, rect.y1 + 4)) & fitz.Rect(0, 0, width, height)
        regions.append({"rect": _to_rendered(info, rect), "caption": caption,
                        "label": label, "kind": kind})
    return regions


def _to_rendered(info, rect):
    """未旋转坐标 → 渲染坐标系（旋转页 bbox 必须换过来，render clip 才裁得对）。"""
    matrix = info.get("matrix")
    page = info["page"]
    if matrix is None:
        return fitz.Rect(rect) & page.rect
    return (fitz.Rect(rect) * matrix) & page.rect


def _to_native(page, rect):
    """渲染坐标 → 未旋转坐标（对齐 get_text/get_textbox 的坐标系）。"""
    value = fitz.Rect(rect)
    if getattr(page, "rotation", 0):
        value = value * page.derotation_matrix
    return value & page.rect


def _inside(rect, regions, ratio=0.55):
    """rect 是否大部分落在某个配图区域里。"""
    area = max(1.0, rect.get_area())
    for region in regions:
        covered = (rect & region["rect"]).get_area()
        if covered / area >= ratio:
            return True
    return False


CJK_HEAD_RE = re.compile(r"[\u3400-\u9fff\uff00-\uffef]")
CAPTION_SEP_RE = re.compile(r"^\s*(?:[|:：.—–\-)\]}」』]|$)")


def _is_caption_line(text):
    """像图注的行：以 Figure/Fig./Table/图/表/算法 开头，且标签后面接分隔符而不是一句话。

    「Fig. 4 shows the relative improvement …」「Algorithm 1 and in Fig. 2. We next …」这类
    正文句首也会命中前缀，一旦当成图注就会凭空造出一个配图区域、把下面的正文吞掉。
    """
    match = CAPTION_START_RE.match(text)
    if not match:
        return False
    rest = text[match.end():]
    if not rest.strip():
        return True
    if CAPTION_SEP_RE.match(rest):
        return True
    head = rest.lstrip()
    return bool(head) and (head[0].isupper() or head[0].isdigit() or CJK_HEAD_RE.match(head))


DATE_RE = re.compile(r"^(?:[A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2} [A-Z][a-z]+ \d{4})$")


def _looks_like_title(text, numbered=False):
    """像标题的短行：不句末标点、不是列表项、不是作者/单位行、不是邮箱/URL、不是日期。"""
    if len(text) > MAX_TITLE_LEN or text.endswith(SENTENCE_END):
        return False
    if DATE_RE.match(text) or "@" in text or "http" in text.lower():
        return False
    if not numbered and BULLET_RE.match(text):
        return False
    if "†" in text or "‡" in text:
        return False
    if text.count(",") >= 3:          # "Tri Dao†, Daniel Y. Fu†, Stefano Ermon†, …"
        return False
    return True


def _paragraph_kind(text, size, body_size, rect, page_h, bold=False):
    if _is_caption_line(text):
        return "caption"
    if size and body_size and size < body_size * 0.82:
        return "footnote"
    # 小节标题在不少论文里和正文同字号，只是加粗（subsection* 之类）；这种一定带编号，
    # 或者整行就是编号（"2.1"，标题在同一个块的下一段/下一块里）。
    big = bool(size and body_size and size >= body_size * 1.12)
    numbered = bool(re.match(r"^\d+(?:\.\d+)*\.?$", text)) or bool(re.match(r"^\d+(?:\.\d+)*\.?\s+\S", text))
    if _looks_like_title(text, numbered) and (big or (bold and numbered)):
        return "heading"
    if BULLET_RE.match(text):
        return "list"
    return "body"


def _split_paragraphs(lines, body_size):
    """把一个块的行按「段间距 / 缩进 / 字号跳变 / 列表符号」切成真正的段落。"""
    groups, current = [], []
    for line in lines:
        if not current:
            current = [line]
            continue
        prev = current[-1]
        size = max(line["size"], prev["size"], body_size or 10.0, 1.0)
        gap = line["rect"].y0 - prev["rect"].y1
        indent = line["rect"].x0 - prev["rect"].x0
        # 只在字号变大时切段：行内公式/上下标的字号会比正文小，那不是新段落
        size_jump = (line["size"] or 0) > (prev["size"] or 0) * 1.15 + 0.3
        bullet_start = bool(BULLET_RE.match(line["text"])) or _is_caption_line(line["text"])
        # 段间距：正常的行距约 0.1~0.35×字号，超过 0.55×字号基本是新段落
        # 段首缩进是 LaTeX 最可靠的段落信号（行距常常一样）：缩进约 1.5em，
        # 判定阈值取 1.1 倍字号，正文里的两端对齐抖动只有 1pt 左右。
        new_para = (
            gap > size * 0.55
            or size_jump
            or indent > size * 1.1
            or bullet_start
            or (prev["text"].endswith(SENTENCE_END) and gap > size * 0.32)
        )
        if new_para and current:
            groups.append(current)
            current = [line]
        else:
            current.append(line)
    if current:
        groups.append(current)
    return groups


def _repeat_key(text):
    return re.sub(r"\d+", "#", text.lower()).strip()


def _repeated_keys(pages, page_h_default):
    """跨页重复出现的短行（页眉/页脚/期刊名）：返回需要丢弃的规范化文本集合。"""
    counts = {}
    total = max(1, len(pages))
    for page in pages:
        height = page.get("hn") or page["h"] or page_h_default
        seen = set()
        for line in page["lines"]:
            y_center = (line["rect"].y0 + line["rect"].y1) / 2
            if 0.10 * height < y_center < 0.92 * height:
                continue
            key = re.sub(r"\d+", "#", line["text"].lower()).strip()
            if len(key) < 6 or key in seen:
                continue
            seen.add(key)
            counts[key] = counts.get(key, 0) + 1
    threshold = max(3, int(total * 0.25))
    return {key for key, count in counts.items() if count >= threshold}


def _drop_header_footer(line, repeated, height, body_size):
    """页眉/页脚/页码：跨页重复的短行、页面最上/最下且字号小于正文的行、页码样式行。"""
    text = line["text"]
    # arXiv/DOI 水印（首页右上，字号往往比标题还大，不能当标题）
    if re.match(r"^(?:arxiv|doi|https?://|www\.)", text, re.IGNORECASE):
        return True
    y_center = (line["rect"].y0 + line["rect"].y1) / 2
    key = re.sub(r"\d+", "#", text.lower()).strip()
    if key in repeated:
        return True
    numeric = bool(NUMERIC_PAGE_RE.match(text) or CHINESE_PAGE_RE.match(text) or ROMAN_PAGE_RE.match(text))
    small = not body_size or line["size"] < body_size * 0.95
    if numeric and (y_center < 0.12 * height or y_center > 0.88 * height):
        return True
    if small and len(text) <= 120 and (y_center < 0.08 * height or y_center > 0.92 * height):
        return True
    return False


def cmd_figures(args):
    """抽取配图区域：位图 bbox + 图注相邻的矢量绘图簇（Figure 2 这类矢量图也能裁出来）。

    返回的 {x,y,x2,y2} 是 PDF 坐标（渲染坐标系），figurePath 直接用它 render clip。
    caption 取图注首行，label 规范化成阿拉伯数字。
    """
    doc = open_doc(args)
    try:
        figures = []
        infos = [_page_info(doc.load_page(index)) for index in range(int(doc.page_count))]
        body_size = _doc_body_size(infos)
        repeated = _repeated_keys(infos, 842.0)
        for index, info in enumerate(infos):
            page = info["page"]
            page_h = float(page.rect.height)
            regions = (_figure_regions(info, body_size, repeated)
                       + _table_regions(info, body_size, repeated))
            # 同一页上重复/相交的区域合并，避免一张图出好几条
            entries, seen = [], set()
            for region in regions:
                rect = fitz.Rect(region["rect"]) & page.rect
                if rect.width < 40 or rect.height < 25:
                    continue
                key = (round(rect.x0), round(rect.y0), round(rect.x1), round(rect.y1))
                if key in seen:
                    continue
                seen.add(key)
                entries.append((rect, region))
            # 位图套在绘图簇里时只留外框那条
            entries.sort(key=lambda item: (-item[0].get_area(), item[0].y0, item[0].x0))
            kept, kept_rects = [], []
            for rect, region in entries:
                if any((rect & other).get_area() / max(1.0, rect.get_area()) > 0.85 for other in kept_rects):
                    continue
                kept.append((rect, region))
                kept_rects.append(rect)
            kept.sort(key=lambda item: (item[0].y0, item[0].x0))
            for position, (rect, region) in enumerate(kept):
                caption = region.get("caption") or None
                if caption is None:
                    # 位图没配到图注时就近找一行
                    captions = _caption_lines(info)
                    if captions:
                        best = min(captions, key=lambda item: _rect_gap(rect, item["line"]["rect"]))
                        if _rect_gap(rect, best["line"]["rect"]) < page_h * 0.25:
                            caption = best["line"]["text"]
                            region = {**region, "label": best["label"], "kind": best["kind"]}
                figures.append({
                    "page": index + 1,
                    "x": round(rect.x0, 2), "y": round(rect.y0, 2),
                    "x2": round(rect.x1, 2), "y2": round(rect.y1, 2),
                    "width": round(rect.width, 2), "height": round(rect.height, 2),
                    "index": position + 1,
                    "caption": caption, "label": region.get("label"),
                    "kind": region.get("kind") or "figure",
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
        sizes = []
        for index in range(pages):
            try:
                rect = doc.load_page(index).rect
                sizes.append({"n": index + 1, "w": round(float(rect.width), 2),
                              "h": round(float(rect.height), 2)})
            except Exception:
                sizes.append({"n": index + 1, "w": 0.0, "h": 0.0})
        return {"ok": True, "pages": pages, "hasText": has_text, "toc": toc,
                "sizes": sizes,
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
    """按页面返回**段落级**文本块（不是「一栏一段」也不是「图里的标签」）。

    做的几件事（对应参考项目里 agent/MinerU 负责的版面工作，这里用 PyMuPDF 规则实现）：
      1. 跨页统计正文字号，丢掉页眉/页脚（重复出现的短行、页码、期刊名）；
      2. 用图注 + 矢量绘图簇认出配图区域，区域内的文字（Figure 2 里的 Encoder/Retrieval 等
         标签）不算正文，避免它们被塞进对照视图；
      3. 把 PDF 的文本块按段间距/缩进/字号/列表符号重新切成段落（LaTeX 单栏常把整节塞进
         一个 block，直接拼会得到几万字一段）；
      4. 给每块标 kind（heading/body/list/caption/footnote），前端据此渲染结构。
    """
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

        prepared, missing = [], []
        for number in numbers:
            if number < 1 or number > page_count:
                missing.append(number)
                continue
            page = doc.load_page(number - 1)
            rect = page.rect
            info = _page_info(page)
            prepared.append({
                "n": number,
                "w": round(float(rect.width), 2),
                "h": round(float(rect.height), 2),
                "page": page,
                "lines": info["lines"],
            })

        body_size = _doc_body_size(prepared)
        repeated = _repeated_keys(prepared, 842.0)
        for item in prepared:
            item["regions"] = (_figure_regions(item, body_size, repeated)
                               + _table_regions(item, body_size, repeated))

        pages = []
        for item in prepared:
            page, height = item["page"], item.get("hn") or item["h"] or 842.0
            regions = item["regions"]
            page_body = _page_body_size(item, body_size)
            blocks = []
            for block in page.get_text("dict").get("blocks") or []:
                if block.get("type", 0) != 0:
                    continue
                lines = _line_records(block)
                if not lines:
                    continue
                lines = [line for line in lines
                         if not _drop_header_footer(line, repeated, height, body_size)]
                if not lines:
                    continue
                for group in _split_paragraphs(lines, body_size):
                    text = _join_lines([line["text"] for line in group]).strip()
                    if not text or not any(ch.isalnum() for ch in text):
                        continue
                    rect = fitz.Rect(group[0]["rect"])
                    for line in group[1:]:
                        rect |= line["rect"]
                    kind = _paragraph_kind(text, group[0]["size"], page_body, rect, height,
                                           bold=any(line["bold"] for line in group))
                    # 图里的文字（标签/刻度）不是正文：图注本身留着
                    if kind != "caption" and _inside(rect, regions, 0.5):
                        continue
                    char_sizes = []
                    for line in group:
                        if line["size"] > 0:
                            char_sizes.extend([line["size"]] * len(line["text"]))
                    shown = _to_rendered(item, rect)
                    blocks.append({
                        "x": round(float(shown.x0), 2), "y": round(float(shown.y0), 2),
                        "x2": round(float(shown.x1), 2), "y2": round(float(shown.y1), 2),
                        "size": round(statistics.median(char_sizes), 2) if char_sizes else round(body_size, 2),
                        "bold": any(line["bold"] for line in group),
                        "kind": kind,
                        "text": text,
                    })
            blocks = order_blocks(blocks, float(item["w"]))
            pages.append({"n": item["n"], "w": item["w"], "h": item["h"], "blocks": blocks})

        result = {"ok": True, "pages": pages, "bodySize": body_size}
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


def _rect_text(page, rect):
    """一个 bbox 内的文本层文字：按行去空白后用 _join_lines 合回一段。"""
    try:
        raw = page.get_text("text", clip=rect, sort=True) or ""
    except Exception:
        return ""
    lines = [re.sub(r"\s+", " ", line).strip() for line in raw.splitlines()]
    lines = [line for line in lines if line]
    return _join_lines(lines).strip()


def cmd_page_lines(args):
    """整页的文本行（带 bbox）：版面模型只给块的框，按行回填文字才不会把词从中间切断。"""
    doc = open_doc(args)
    try:
        try:
            number = int(args.get("page") or 1)
        except (TypeError, ValueError):
            raise ArgsError("page 必须是整数") from None
        if number < 1 or number > doc.page_count:
            raise ArgsError(f"页码超出范围：{number}（共 {doc.page_count} 页）")
        info = _page_info(doc.load_page(number - 1))
        lines = []
        for line in info["lines"]:
            rect = line["rect"]
            lines.append({"x": round(float(rect.x0), 2), "y": round(float(rect.y0), 2),
                          "x2": round(float(rect.x1), 2), "y2": round(float(rect.y1), 2),
                          "size": line["size"], "bold": line["bold"], "text": line["text"]})
        return {"ok": True, "page": number, "width": info["wn"], "height": info["hn"],
                "lines": lines}
    finally:
        doc.close()


def cmd_clip_text(args):
    """按 bbox 取文本层（版面模型只给结构，正文文字仍以 PDF 文本层为准）。

    为什么不用服务端 OCR 文本：PP-StructureV3 认字有错（tokns / ReTRo[OF]），
    数字原生 PDF 的文本层是准的，拿它才不把错字带进对照视图和翻译。
    """
    doc = open_doc(args)
    try:
        try:
            number = int(args.get("page") or 1)
        except (TypeError, ValueError):
            raise ArgsError("page 必须是整数") from None
        if number < 1 or number > doc.page_count:
            raise ArgsError(f"页码超出范围：{number}（共 {doc.page_count} 页）")
        rects = args.get("rects")
        if not isinstance(rects, list) or not rects:
            raise ArgsError("rects 参数不合法（需要 [[x0,y0,x1,y1], …]）")
        page = doc.load_page(number - 1)
        texts = []
        for index, raw in enumerate(rects):
            if not isinstance(raw, (list, tuple)) or len(raw) != 4:
                raise ArgsError(f"第 {index + 1} 个 rect 不合法（需要 4 个数字）")
            try:
                x0, y0, x1, y1 = (float(value) for value in raw)
            except (TypeError, ValueError):
                raise ArgsError(f"第 {index + 1} 个 rect 不是数字") from None
            rect = fitz.Rect(x0, y0, x1, y1)
            if rect.width <= 0 or rect.height <= 0:
                raise ArgsError(f"第 {index + 1} 个 rect 面积为 0")
            texts.append(_rect_text(page, _to_native(page, rect)))
        return {"ok": True, "page": number, "texts": texts}
    finally:
        doc.close()


def cmd_split(args):
    """切出 [from, to] 页写成新 PDF（版面模型分片上传用，页号 1 基、含两端）。"""
    doc = open_doc(args)
    try:
        total = int(doc.page_count)
        try:
            first = int(args.get("from") or 1)
            last = int(args.get("to") or total)
        except (TypeError, ValueError):
            raise ArgsError("from/to 必须是整数") from None
        if first < 1 or last > total or first > last:
            raise ArgsError(f"页范围不合法：{first}-{last}（共 {total} 页）")
        out = str(args.get("out") or "").strip()
        if out == "":
            raise ArgsError("缺少 out 参数")
        target = Path(out)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        part = fitz.open()
        try:
            part.insert_pdf(doc, from_page=first - 1, to_page=last - 1)
            part.save(str(tmp))
        except Exception as exc:  # 写盘失败要带中文原因，别让调用方看见裸 OSError
            raise ArgsError(f"保存切片失败：{exc}") from exc
        finally:
            part.close()
        try:
            os.replace(tmp, target)
        except OSError as exc:
            raise ArgsError(f"写入切片失败：{exc}") from exc
        return {"ok": True, "path": str(target), "pages": last - first + 1,
                "from": first, "to": last}
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
    # 旋转后图片的渲染框宽 ≈ 原图高（120）加两侧留白；未转换的话宽会是 200
    rot_w = float(rot_items[0].get("width") or 0)
    if abs(rot_items[0].get("x", 0) - 90) > 8 or abs(rot_items[0].get("x2", 0) - 210) > 8 or rot_w > 140:
        return fail(f"旋转页 figures 检查失败：bbox 还是未旋转坐标（{rot_items[0].get('x')}→{rot_items[0].get('x2')} w={rot_w}）")
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
    clip_text = cmd_clip_text({"path": str(sample), "page": 1,
                               "rects": [[70, 58, 320, 88], [70, 278, 320, 300]]})
    clip_texts = clip_text.get("texts") if clip_text.get("ok") else None
    if not isinstance(clip_texts, list) or len(clip_texts) != 2:
        return fail(f"clip_text 检查失败：{clip_text.get('error') or '返回条数不对'}")
    if "Self Test Title" not in (clip_texts[0] or ""):
        return fail(f"clip_text 检查失败：标题框取到 {clip_texts[0]!r}")
    if "sample image" not in (clip_texts[1] or ""):
        return fail(f"clip_text 检查失败：图注框没取到文字 {clip_texts[1]!r}")
    lines = cmd_page_lines({"path": str(sample), "page": 1})
    line_items = lines.get("lines") if lines.get("ok") else None
    if not isinstance(line_items, list) or len(line_items) < 3:
        return fail(f"page_lines 检查失败：{lines.get('error') or '行数不对'}")
    if lines.get("width") != 400 or lines.get("height") != 360:
        return fail(f"page_lines 检查失败：页尺寸 {lines.get('width')}x{lines.get('height')}（期望 400x360）")
    cut = base / "pb-selftest-split.pdf"
    split = cmd_split({"path": str(sample), "from": 1, "to": 1, "out": str(cut)})
    if not split.get("ok") or split.get("pages") != 1 or not cut.is_file():
        return fail(f"split 检查失败：{split.get('error') or '没有生成切片'}")
    checks = [f"info: pages={pages} hasText={info['hasText']} toc={len(info['toc'])}",
              f"text: page1 blocks={len(blocks)}",
              f"render: bytes={len(data)} {render['width']}x{render['height']}",
              f"outline: items={len(outline['items'])}",
              f"figures: {len(items)} items label={items[0].get('label')}",
              f"render clip: bytes={len(clip_data)} {clip['width']}x{clip['height']}",
              f"rotated figures: {len(rot_items)} items page={rot_items[0].get('page')}",
              f"clip_text: {len(clip_texts)} rects title={clip_texts[0][:24]!r}",
              f"page_lines: {len(line_items)} lines {lines['width']}x{lines['height']}",
              f"split: pages={split['pages']} bytes={cut.stat().st_size}",
              f"sample={sample}"]
    return {"ok": True, "checks": checks, "ms": int((time.perf_counter() - started) * 1000)}


HANDLERS = {"info": cmd_info, "text": cmd_text, "outline": cmd_outline,
            "render": cmd_render, "figures": cmd_figures,
            "clip_text": cmd_clip_text, "page_lines": cmd_page_lines, "split": cmd_split}


def main(argv):
    command = argv[1].lower() if len(argv) > 1 else ""
    try:
        if "--self-test" in argv[1:]:
            payload = self_test()
        elif not command:
            payload = fail("缺少命令（info | text | outline | render | figures | clip_text | page_lines | split）")
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
