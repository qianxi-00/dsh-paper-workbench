#!/usr/bin/env python
"""Generated PDFs and hand-written gold expectations at the JSON command boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz

TOOL = Path(__file__).resolve().parents[1] / "assets" / "pdf_tool.py"


class PdfQuality(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pb-pdf-quality-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "DSH_PAPER_WORKBENCH_DATA": str(self.root / "data"),
                    "PB_DB_PATH": str(self.root / "test.db"), "PADDLE_OCR_TOKEN": "",
                    "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

    def command(self, command, pdf, **args):
        result = subprocess.run([sys.executable, str(TOOL), command],
                                input=json.dumps({"path": str(pdf), **args}),
                                capture_output=True, text=True, encoding="utf-8",
                                env=self.env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload.get("ok"), payload)
        return payload

    def document(self, name, entries):
        target = self.root / (name + ".pdf")
        with fitz.open() as doc:
            page = doc.new_page(width=600, height=800)
            for x, y, text in entries:
                page.insert_text((x, y), text, fontsize=10, lineheight=1.4)
            doc.save(target)
        return target

    def tokens(self, pdf):
        pages = self.command("text", pdf, pages=[1])["pages"]
        return [block["text"].split()[0] for block in pages[0]["blocks"]]

    def test_columns_without_wide_anchor(self):
        # Sorting by y interleaves these two independent prose columns.
        pdf = self.document("columns", [
            (50, 100, "L1 Left prose fills the column width.\nIts continuation belongs to the same paragraph."),
            (330, 110, "R1 Right prose fills the column width.\nIts continuation belongs to the same paragraph."),
            (50, 210, "L2 Left prose continues below here.\nIts continuation belongs to the same paragraph."),
            (330, 220, "R2 Right prose continues below here.\nIts continuation belongs to the same paragraph."),
        ])
        self.assertEqual(self.tokens(pdf), ["L1", "L2", "R1", "R2"])

    def test_wide_anchor_separates_column_bands(self):
        pdf = self.document("bands", [
            (50, 100, "L1 Left paragraph above the anchor.\nIts continuation belongs to this paragraph."),
            (330, 110, "R1 Right paragraph above the anchor.\nIts continuation belongs to this paragraph."),
            (50, 180, "L2 Another left paragraph above.\nIts continuation belongs to this paragraph."),
            (330, 190, "R2 Another right paragraph above.\nIts continuation belongs to this paragraph."),
            (50, 300, "ANCHOR A full width heading separates the two independent column bands across this page"),
            (50, 400, "L3 Left paragraph below the anchor.\nIts continuation belongs to this paragraph."),
            (330, 410, "R3 Right paragraph below the anchor.\nIts continuation belongs to this paragraph."),
            (50, 480, "L4 Another left paragraph below.\nIts continuation belongs to this paragraph."),
            (330, 490, "R4 Another right paragraph below.\nIts continuation belongs to this paragraph."),
        ])
        self.assertEqual(self.tokens(pdf), ["L1", "L2", "R1", "R2", "ANCHOR", "L3", "L4", "R3", "R4"])

    def test_one_paragraph_per_column_in_each_band(self):
        pdf = self.document("one-per-band", [
            (50, 110, "L1 Left prose occupies most of its column.\nIts continuation belongs to this paragraph."),
            (330, 100, "R1 Right prose occupies most of its column.\nIts continuation belongs to this paragraph."),
            (50, 240, "ANCHOR This full width heading separates the independent column bands on the page."),
            (50, 360, "L2 Left prose occupies most of its column.\nIts continuation belongs to this paragraph."),
            (330, 350, "R2 Right prose occupies most of its column.\nIts continuation belongs to this paragraph."),
        ])
        self.assertEqual(self.tokens(pdf), ["L1", "R1", "ANCHOR", "L2", "R2"])

    def test_table_cells_stay_in_row_order(self):
        # A wide heading must not turn the two columns of short cells into prose.
        pdf = self.document("table", [
            (50, 100, "HEADER This full width line introduces the tabular values underneath it on this page."),
            (50, 200, "A1 Value"), (330, 200, "B1 Score"),
            (50, 260, "A2 Value"), (330, 260, "B2 Score"),
            (50, 320, "A3 Value"), (330, 320, "B3 Score"),
        ])
        self.assertEqual(self.tokens(pdf), ["HEADER", "A1", "B1", "A2", "B2", "A3", "B3"])

    def test_table_without_wide_anchor_keeps_row_order(self):
        # 单栏页里的无表头宽表格：没有全宽标题可当 anchor，也不能按两列读。
        pdf = self.document("table-no-anchor", [
            (50, 100, "A1 Value with a fairly wide cell"), (330, 100, "B1 Score with a fairly wide cell"),
            (50, 160, "A2 Value with a fairly wide cell"), (330, 160, "B2 Score with a fairly wide cell"),
            (50, 220, "A3 Value with a fairly wide cell"), (330, 220, "B3 Score with a fairly wide cell"),
        ])
        self.assertEqual(self.tokens(pdf), ["A1", "B1", "A2", "B2", "A3", "B3"])

    def test_table_band_does_not_inherit_prose_column_order(self):
        pdf = self.document("mixed-bands", [
            (50, 100, "L1 Left prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (330, 110, "R1 Right prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (50, 180, "L2 Left prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (330, 190, "R2 Right prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (50, 260, "L3 Left prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (330, 270, "R3 Right prose paragraph occupies this column.\nAnother line continues the same paragraph."),
            (50, 390, "HEADER This full width heading introduces the tabular values underneath it on the page."),
            (50, 470, "A1 Value"), (330, 470, "B1 Score"),
            (50, 530, "A2 Value"), (330, 530, "B2 Score"),
        ])
        self.assertEqual(self.tokens(pdf), ["L1", "L2", "L3", "R1", "R2", "R3", "HEADER", "A1", "B1", "A2", "B2"])

    def test_overlapping_indented_blocks_are_not_columns(self):
        pdf = self.document("indents", [
            (100, 100, "S1 A paragraph with a moderately long line of prose."),
            (230, 140, "S2 An indented paragraph with an overlapping line."),
            (100, 300, "S3 A paragraph with a moderately long line of prose."),
            (230, 340, "S4 An indented paragraph with an overlapping line."),
        ])
        self.assertEqual(self.tokens(pdf), ["S1", "S2", "S3", "S4"])

    def test_rendered_coordinates_rotation_and_crop(self):
        # Hand-transformed rectangle coordinates, independent of production helpers.
        cases = [
            (False, 0, (640, 840), (100, 160, 220, 200)),
            (False, 90, (840, 640), (640, 100, 680, 220)),
            (False, 180, (640, 840), (420, 640, 540, 680)),
            (False, 270, (840, 640), (160, 420, 200, 540)),
            (True, 0, (560, 740), (60, 100, 180, 140)),
            (True, 90, (740, 560), (600, 60, 640, 180)),
            (True, 180, (560, 740), (380, 600, 500, 640)),
            (True, 270, (740, 560), (100, 380, 140, 500)),
        ]
        for cropped, rotation, size, box in cases:
            with self.subTest(cropped=cropped, rotation=rotation):
                pdf = self.root / f"coordinates-{cropped}-{rotation}.pdf"
                with fitz.open() as doc:
                    page = doc.new_page(width=640, height=840)
                    page.draw_rect(fitz.Rect(100, 160, 220, 200), color=None, fill=(1, 0, 0))
                    page.insert_text((110, 180), "TARGET fixed text.", fontsize=10)
                    page.insert_text((350, 500), "CONTROL elsewhere.", fontsize=10)
                    if cropped:
                        page.set_cropbox(fitz.Rect(40, 60, 600, 800))
                    page.set_rotation(rotation)
                    doc.save(pdf)
                lines = self.command("page_lines", pdf, page=1)
                self.assertEqual((lines["width"], lines["height"]), size)
                line = next(row for row in lines["lines"] if row["text"] == "TARGET fixed text.")
                text_page = self.command("text", pdf, pages=[1])["pages"][0]
                self.assertEqual((text_page["w"], text_page["h"]), size)
                block = next(row for row in text_page["blocks"] if row["text"] == "TARGET fixed text.")
                for key in ("x", "y", "x2", "y2"):
                    self.assertAlmostEqual(line[key], block[key], places=2)
                self.assertTrue(box[0] <= line["x"] < line["x2"] <= box[2], line)
                self.assertTrue(box[1] <= line["y"] < line["y2"] <= box[3], line)
                clipped = self.command("clip_text", pdf, page=1, rects=[box])
                self.assertEqual(clipped["texts"], ["TARGET fixed text."])
                image = self.root / "clip.png"
                rendered = self.command("render", pdf, page=1, scale=1,
                                        clip=[box[0], box[1], box[2] - box[0], box[3] - box[1]], out=str(image))
                self.assertEqual((rendered["width"], rendered["height"]),
                                 (box[2] - box[0], box[3] - box[1]))
                pix = fitz.Pixmap(str(image))
                self.assertEqual(pix.pixel(3, 3), (255, 0, 0))
                pixels = pix.samples
                red = sum(pixels[i] > 245 and pixels[i + 1] < 10 and pixels[i + 2] < 10
                          for i in range(0, len(pixels), pix.n))
                self.assertGreater(red / (pix.width * pix.height), 0.8)

    def test_single_column_preserves_vertical_order(self):
        pdf = self.document("single", [
            (60, 110, "S1 A short single column paragraph."),
            (75, 180, "S2 An indented paragraph follows."),
            (60, 250, "S3 Another short paragraph ends the page."),
        ])
        self.assertEqual(self.tokens(pdf), ["S1", "S2", "S3"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
