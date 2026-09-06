"""A report is handed over as a PDF, or says why it could not be."""

import sys
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rocketopt import pdf as pdf_mod
from rocketopt.report_style import CSS, PRINT_CSS


SAMPLE = """<title>T</title><style>%s</style>
<div class="wrap"><header><h1>A Report</h1>
<p class="byline">Created by Someone</p></header>
<section><h2>Numbers</h2>
<div class="scroll"><table><thead><tr><th>a</th><th class="n">b</th></tr></thead>
<tbody><tr><td>x</td><td class="n">1</td></tr></tbody></table></div>
</section></div>"""


def test_the_stylesheet_carries_print_rules():
    """Without these the PDF comes out with the screen's grey ground."""
    assert "@media print" in CSS
    assert "@page" in CSS
    assert PRINT_CSS in CSS
    # Paper has no dark mode, so the light palette has to be pinned.
    assert '--ground:#ffffff' in PRINT_CSS
    # A figure that overruns the sheet is the classic print bug.
    assert "break-inside:avoid" in PRINT_CSS


def test_windows_looks_where_browsers_are_actually_installed(monkeypatch):
    """Windows puts none of these on PATH, so names alone never find them.

    Missing this meant every report on Windows quietly came out as HTML: the
    renderer looked for "chrome" on PATH, found nothing, and fell back.
    """
    monkeypatch.setenv("ProgramFiles", r"C:\Program Files")
    monkeypatch.setenv("ProgramFiles(x86)", r"C:\Program Files (x86)")
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\someone\AppData\Local")
    found = pdf_mod._windows_candidates()

    joined = "\n".join(found)
    assert "chrome.exe" in joined and "msedge.exe" in joined
    # Chrome installs per-user when the installer has no admin rights, which on
    # a school or work machine is the normal case, not the exception.
    assert any("AppData" in path and "chrome.exe" in path for path in found)
    assert any("Program Files (x86)" in path for path in found)
    # Built with os.path.join, so every entry is one path, not a split string.
    assert all(part not in found for part in ("G", "o", "e"))


def test_every_platform_has_somewhere_to_look():
    assert pdf_mod.candidates(), "no candidate paths for this platform"


def test_no_browser_is_a_clear_failure_not_a_crash(tmp_path):
    source = tmp_path / "r.html"
    source.write_text(SAMPLE % CSS)
    with mock.patch.object(pdf_mod, "candidates", lambda: []), \
         mock.patch.object(pdf_mod, "BROWSER_NAMES", []):
        assert pdf_mod.find_browser() is None
        with pytest.raises(pdf_mod.NoBrowser) as caught:
            pdf_mod.html_to_pdf(source, tmp_path / "r.pdf")
    # The message has to say the HTML is still there, or it reads as data loss.
    assert "HTML" in str(caught.value)


@pytest.mark.skipif(pdf_mod.find_browser() is None,
                    reason="needs a Chromium-family browser to render with")
def test_a_report_renders_to_a_real_pdf(tmp_path):
    source = tmp_path / "r.html"
    source.write_text(SAMPLE % CSS)
    out = pdf_mod.html_to_pdf(source, tmp_path / "r.pdf")
    assert out.exists()
    data = out.read_bytes()
    assert data[:5] == b"%PDF-"
    assert len(data) > 1000

    fitz = pytest.importorskip("fitz")
    with fitz.open(out) as doc:
        assert doc.page_count >= 1
        text = doc[0].get_text()
        assert "Report" in text and "Numbers" in text
