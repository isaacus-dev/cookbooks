# Regenerate with Python ftfy==6.3.1. No Python dependency is needed at runtime.
import re
import json

from pathlib import Path

import ftfy

from ftfy import badness, chardata

assert ftfy.__version__ == "6.3.1"


def pattern(regex):
    source = regex.pattern
    if isinstance(source, bytes):
        return source.decode("latin1")

    # JavaScript has no verbose-regex flag. Preserve escapes and character classes.
    tokens = re.findall(r"\\.|\[(?:\\.|[^\]\\])*\]|#[^\n]*|\s+|.", source)
    source = "".join(t for t in tokens if not t.startswith("#") and not t.isspace())

    return source.replace(r"\w", r"[\p{L}\p{N}_]").replace(r"\s", r"[\u0009-\u000d\u001c-\u0020\u0085\p{Z}]")


data = {
    "htmlEntities": chardata.HTML_ENTITIES,
    "encodings": {name: bytes(range(256)).decode(name) for name in chardata.CHARMAP_ENCODINGS},
    "badness": pattern(badness.BADNESS_RE),
    "utf8Detector": pattern(chardata.UTF8_DETECTOR_RE),
    "alteredUtf8": pattern(chardata.ALTERED_UTF8_RE),
    "lossyUtf8": pattern(chardata.LOSSY_UTF8_RE),
}
root = Path(__file__).resolve().parents[1]
(root / "ftfy-data.js").write_text(
    "// Generated from ftfy 6.3.1 by helpers/scripts/generate-ftfy-data.py.\n"
    "// Copyright 2023 Robyn Speer. Apache-2.0; see ftfy-LICENSE.txt.\n"
    "export default " + json.dumps(data, ensure_ascii=True, indent=2) + ";\n"
)
