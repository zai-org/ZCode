"""真实插件验收的输入、结果与进程证据；不替换插件实现。"""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import zipfile

ROOT = Path(__file__).parent
DOCS = ROOT / "中文 空格"


def emit(name, value):
    (ROOT / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf8")


def prepare():
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = 2, 3
    sheet["C1"], sheet["D1"] = "=SUM(A1:B1)", "=1/0"
    workbook.save(DOCS / "公式 样例.xlsx")
    document = Document()
    paragraph = document.add_paragraph()
    for kind in ["begin", "separate", "end"]:
        run = paragraph.add_run()._r
        field = OxmlElement("w:fldChar")
        field.set(qn("w:fldCharType"), kind)
        run.append(field)
        if kind == "begin":
            instruction = OxmlElement("w:instrText")
            instruction.text = ' TOC \\o "1-3" \\h \\z \\u '
            paragraph.add_run()._r.append(instruction)
    document.add_heading("验收目录 第一章", 1)
    document.add_paragraph("完整文档内容")
    document.add_heading("验收目录 第二节", 2)
    document.save(DOCS / "目录.docx")
    # 无缓存输入必须独立证明，不能把历史重算结果当成本轮宏的成功。
    with zipfile.ZipFile(DOCS / "公式 样例.xlsx") as archive:
        text = archive.read("xl/worksheets/sheet1.xml").decode()
        assert '<f>SUM(A1:B1)</f><v></v>' in text
        assert '<f>1/0</f><v></v>' in text
    package = "zcode_full_chain_probe"
    dist = package + "-1.0.dist-info"
    files = {package + "/__init__.py": "value = 'overlay-only'\n", dist + "/METADATA": "Metadata-Version: 2.1\nName: zcode-full-chain-probe\nVersion: 1.0\n", dist + "/WHEEL": "Wheel-Version: 1.0\nGenerator: acceptance\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
    files[dist + "/RECORD"] = "".join(name + ",,\n" for name in [*files, dist + "/RECORD"])
    with zipfile.ZipFile(DOCS / (package + "-1.0-py3-none-any.whl"), "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    emit("prepared-inputs", {"formulasInitiallyUncached": True})


def invoke():
    label, script, *arguments = sys.argv[2:]
    events = []
    startup_policy = {"dontWriteBytecode": sys.dont_write_bytecode, "pycachePrefix": sys.pycache_prefix}
    def audit(event, args):
        if event == "subprocess.Popen":
            executable, argv, cwd, env = args
            # 根因：Windows 的 subprocess 在审计前已用 list2cmdline 把 argv 拼成命令行字符串，且 executable 为 None；
            # POSIX 分支则先把 executable 填成 args[0]。原写法 list(argv) 把字符串拆成单个字符、executable 记成 "None"，
            # pdftoppm 入口断言在 Windows 上永远找不到记录。这里按命令行首个参数取程序名，argv 保留原始命令行。
            if executable is None and isinstance(argv, str):
                executable = argv[1:argv.index('"', 1)] if argv.startswith('"') else argv.split(" ", 1)[0]
            environment = env if env is not None else os.environ
            events.append({"executable": str(executable), "argv": argv if isinstance(argv, str) else list(argv), "resolved": shutil.which(str(executable), path=environment.get("PATH")), "cwd": str(cwd)})
    sys.addaudithook(audit)
    sys.path.insert(0, str(Path(script).parent))
    sys.argv = [script, *arguments]
    try:
        runpy.run_path(script, run_name="__main__")
    finally:
        modules = {name: str(module.__file__) for name in ["docx", "reportlab", "openpyxl", "pptx", "pdf2image", "pypdf"] if (module := sys.modules.get(name)) and getattr(module, "__file__", None)}
        emit("runtime-" + label, {"executable": sys.executable, "prefix": sys.prefix, "startupPolicy": startup_policy, "dontWriteBytecode": sys.dont_write_bytecode, "pycachePrefix": sys.pycache_prefix, "modules": modules, "subprocesses": events, "script": script, "scriptSha256": hashlib.sha256(Path(script).read_bytes()).hexdigest()})


def report():
    from reportlab.lib.colors import HexColor
    from reportlab.pdfgen.canvas import Canvas
    # palette.json 由 Node 按 UTF-8 写出；Windows 默认代码页不是 UTF-8，必须显式指定。
    palette = json.loads((ROOT / "palette.json").read_text(encoding="utf8"))
    canvas = Canvas(str(DOCS / "reportlab 主流程.pdf"))
    canvas.setFillColor(HexColor(palette["text"]))
    canvas.drawString(72, 760, "Distributed PDF plugin / ReportLab acceptance")
    canvas.drawString(72, 735, "Pinned Python packages render this page.")
    canvas.save()
    emit("reportlab-result", {"executable": sys.executable, "reportlab": __import__("reportlab").__file__})


def check():
    from openpyxl import load_workbook
    from pypdf import PdfReader
    from pptx import Presentation
    from docx import Document
    workbook = load_workbook(DOCS / "公式 样例.xlsx", data_only=True)
    formulas = {key: workbook.active[key].value for key in ["C1", "D1"]}
    workbook.close()
    assert formulas == {"C1": 5, "D1": "#DIV/0!"}
    with zipfile.ZipFile(DOCS / "目录.docx") as archive:
        xml = archive.read("word/document.xml").decode()
        assert xml.count("验收目录 第一章") == 2
        assert xml.count("验收目录 第二节") == 2
    presentation = Presentation(DOCS / "中文 字体验收.pptx")
    boxes = []
    for slide in presentation.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            assert shape.left >= 0 and shape.top >= 0
            assert shape.left + shape.width <= presentation.slide_width
            assert shape.top + shape.height <= presentation.slide_height
            boxes.append(shape.text)
    assert any("文档转换与中文显示" in text for text in boxes)
    assert "文档转换与中文显示" in "\n".join(p.text for p in Document(DOCS / "旧文档/中文 字体验收.docx").paragraphs)
    pdfs = {}
    for name in ["word", "slides", "office", "reportlab"]:
        path = DOCS / {"word": "Word PDF/中文 字体验收.pdf", "slides": "PPT PDF/中文 字体验收.pdf", "office": "Office PDF.pdf", "reportlab": "reportlab 主流程.pdf"}[name]
        reader = PdfReader(path)
        text = "\n".join(page.extract_text() for page in reader.pages)
        assert len(reader.pages) == 1
        if name != "reportlab":
            assert "文档转换与中文显示" in text
            assert "保留已有成果" in text
        fonts = []
        for page in reader.pages:
            for font in page["/Resources"].get("/Font", {}).values():
                fonts.append(str(font.get_object().get("/BaseFont")))
        pdfs[name] = {"pages": len(reader.pages), "text": text, "fonts": fonts}
    # PingFang 是 macOS 系统字体；随包的 Noto CJK 在所有平台都应出现。其他平台记录实际字体，不按 macOS 断言。
    if sys.platform == "darwin":
        assert any("PingFang" in name for name in pdfs["word"]["fonts"]), pdfs["word"]["fonts"]
    assert any("NotoSerifCJKsc" in name for name in pdfs["word"]["fonts"]), pdfs["word"]["fonts"]
    emit("document-results", {"formulas": formulas, "pptxTextBoxes": len(boxes), "pptxExecutable": sys.executable, "pptxModule": __import__("pptx").__file__, "pdfs": pdfs})


if __name__ == "__main__":
    {"prepare": prepare, "run": invoke, "report": report, "check": check}[sys.argv[1]]()
