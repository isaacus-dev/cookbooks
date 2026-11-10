# Regenerate with Python ftfy==6.3.1. Expected outputs come from the Python reference.
import json

from pathlib import Path

import ftfy

from ftfy import chardata

assert ftfy.__version__ == "6.3.1"

cases = [
    "",
    "café â€™ 中文",
    "voilÃ le travail",
    "Ã la mode",
    "â€œquotedâ€�",
    "âœ” No problems",
    "ÃƒÂ©",
    "Â ",
    "a\x85b",
    "&lt;b&gt;&amp; test",
    "<b>&amp;</b>\n&amp;",
    "\ud800x\udfff",
    "ï»¿BOM",
    "\ufeffx\ufeff",
    "Ｕﾀｰﾝ",
    "Ĳ ŉ ﬅ",
    "\x1b[31mred\x1b[0m",
]
cases += list(chardata.HTML_ENTITIES)
cases += [
    f"&#{code};"
    for code in [0, 1, 8, 9, 11, 12, 13, 31, 127, 128, 129, 133, 159, 0xFDD0, 0xFFFF, 0x1FFFE, 0xD800, 0x110000]
]
for text in [
    "café déjà vu",
    "“Contract”—§ 2 © 2026",
    "Ελληνικά",
    "Русский",
    "العربية",
    "中文 日本語",
    "😀💩",
    "à la mode",
    "schön",
    "✓ ✔",
    "English text",
    "åäö ÅÄÖ",
    "İstanbul",
    "Āā Ķķ",
]:
    cases.append(text)
    for encoding in chardata.CHARMAP_ENCODINGS:
        broken = text.encode().decode(encoding)
        cases.extend(
            [
                broken,
                "中文 " + broken + " café",
                broken + " – valid",
                broken.encode().decode(encoding),
            ]
        )

cases = list(dict.fromkeys(cases))
fixtures = [{"input": text, "expected": ftfy.fix_text(text)} for text in cases]
root = Path(__file__).resolve().parents[2]
(root / "test/ftfy-fixtures.json").write_text(json.dumps(fixtures, ensure_ascii=True, indent=2) + "\n")
print(f"Generated {len(fixtures)} reference cases with ftfy {ftfy.__version__}")
