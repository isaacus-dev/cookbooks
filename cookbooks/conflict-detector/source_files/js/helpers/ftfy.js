// Default text fixes adapted from Python ftfy 6.3.1 (Apache-2.0).
// Copyright 2023 Robyn Speer. See ftfy-LICENSE.txt.
import data from "./ftfy-data.js";

const HTML_ENTITIES = data.htmlEntities;
const BADNESS_RE = new RegExp(data.badness, "u");
const ALTERED_UTF8_RE = new RegExp(data.alteredUtf8, "g");
const LOSSY_UTF8_RE = new RegExp(data.lossyUtf8, "g");
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODINGS = Object.entries(data.encodings).map(([name, chars]) => ({
  name,
  bytes: new Map([...chars].map((c, n) => [c, n])),
}));

const CP1252 = "€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ";

const LIGATURES = {
  "Ĳ": "IJ", "ĳ": "ij", "ŉ": "ʼn", "Ǳ": "DZ", "ǲ": "Dz", "ǳ": "dz",
  "Ǆ": "DŽ", "ǅ": "Dž", "ǆ": "dž", "Ǉ": "LJ", "ǈ": "Lj", "ǉ": "lj",
  "Ǌ": "NJ", "ǋ": "Nj", "ǌ": "nj", "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl",
  "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "ſt", "ﬆ": "st",
};

const WIDTH_MAP = { "\u3000": " " };
for (let i = 0xff01; i < 0xfff0; i++) {
  const char = String.fromCodePoint(i);
  const alternate = char.normalize("NFKC");
  if (alternate !== char) {
    WIDTH_MAP[char] = alternate;
  }
}

function unescapeFixup(text) {
  if (Object.hasOwn(HTML_ENTITIES, text)) {
    return HTML_ENTITIES[text];
  }

  const name = text.slice(1, -1);
  if (!name.startsWith("#")) {
    return text;
  }

  const hex = name[1] === "x" || name[1] === "X";
  const digits = name.slice(hex ? 2 : 1);
  if (!digits || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
    return text;
  }

  const code = Number.parseInt(digits, hex ? 16 : 10);
  if (code >= 0x80 && code <= 0x9f) {
    return CP1252[code - 0x80];
  }

  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return "\ufffd";
  }

  if ((code >= 1 && code <= 8) || code === 11 || (code >= 14 && code <= 31)
      || code === 127 || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xffff) >= 0xfffe) {
    return "";
  }

  return String.fromCodePoint(code);
}

function decodeUtf8(bytes) {
  // TextDecoder rejects CESU-8 surrogate pairs and Java's overlong NUL; ftfy accepts them.
  bytes = bytes.replace(/\xc0\x80/g, "\x00").replace(
    /\xed[\xa0-\xaf][\x80-\xbf]\xed[\xb0-\xbf][\x80-\xbf]/g,
    (pair) => {
      const high = ((pair.charCodeAt(1) & 0x3f) << 6) | (pair.charCodeAt(2) & 0x3f);
      const low = ((pair.charCodeAt(4) & 0x3f) << 6) | (pair.charCodeAt(5) & 0x3f);
      const code = 0x10000 + ((high & 1023) << 10) + (low & 1023);

      return String.fromCharCode(...UTF8_ENCODER.encode(String.fromCodePoint(code)));
    },
  );

  return UTF8_DECODER.decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
}

function fixEncodingStep(text) {
  if (!BADNESS_RE.test(text)) {
    return text;
  }

  for (const encoding of ENCODINGS) {
    let bytes = "";
    for (const c of text) {
      const byte = encoding.bytes.get(c);
      if (byte === undefined) {
        bytes = null;
        break;
      }

      bytes += String.fromCharCode(byte);
    }

    if (bytes === null) {
      continue;
    }

    if (encoding.name !== "macroman") {
      bytes = bytes.replace(/\xc3 (?! |quele|quela|quilo|s )/g, "\xc3\xa0 ");
      bytes = bytes.replace(ALTERED_UTF8_RE, (match) => match.replaceAll(" ", "\xa0"));
    }

    if (encoding.name.startsWith("sloppy")) {
      bytes = bytes.replace(LOSSY_UTF8_RE, "\xef\xbf\xbd");
    }

    try {
      return decodeUtf8(bytes);
    } catch {
      // A different single-byte encoding may still recover this segment.
    }
  }

  // Use a fresh global regex: recursive repairs must not reset an outer match's cursor.
  return text.replace(new RegExp(data.utf8Detector, "gu"), (part) => (
    part.length < text.length && BADNESS_RE.test(part) ? fixEncoding(part) : part
  ));
}

function fixEncoding(text) {
  for (;;) {
    const fixed = fixEncodingStep(text);
    if (fixed === text) {
      return text;
    }

    text = fixed;
  }
}

function fixSegment(text, unescapeHtml) {
  for (;;) {
    const origtext = text;
    if (unescapeHtml) {
      text = text.replace(/&#?[0-9A-Za-z]{1,24};/g, unescapeFixup);
    }

    text = fixEncoding(text)
      .replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80])
      .replace(/[\u0132\u0133\u0149\u01c4-\u01cc\u01f1-\u01f3\ufb00-\ufb06]/g, (c) => LIGATURES[c] ?? c)
      .replace(/[\u3000\uff01-\uffef]/g, (c) => WIDTH_MAP[c] ?? c)
      .replace(/[\u201c-\u201f]/g, '"')
      .replace(/[\u02bc\u2018-\u201b]/g, "'")
      .replaceAll("\r\n", "\n")
      .replace(/[\r\u2028\u2029\u0085]/g, "\n")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
      .replace(/\x1b\[([\d;]*)([a-zA-Z])/g, "")
      .replace(/[\x00-\x08\x0b\x0e-\x1f\x7f\u206a-\u206f\ufeff\ufff9-\ufffc]/g, "")
      .normalize("NFC");
    if (text === origtext) {
      return text;
    }
  }
}

export function fixText(text) {
  const out = [];
  let unescapeHtml = true;
  let pos = 0;
  while (pos < text.length) {
    let textbreak = text.indexOf("\n", pos) + 1;
    if (textbreak === 0) {
      textbreak = text.length;
    }

    // Python bounds segments at one million code points, rather than UTF-16 code units.
    if (textbreak - pos > 1_000_000) {
      let end = pos;
      for (let count = 0; count < 1_000_000 && end < textbreak; count++) {
        end += text.codePointAt(end) > 0xffff ? 2 : 1;
      }

      textbreak = end;
    }

    const segment = text.slice(pos, textbreak);
    if (segment.includes("<")) {
      unescapeHtml = false;
    }

    out.push(fixSegment(segment, unescapeHtml));
    pos = textbreak;
  }

  return out.join("");
}
