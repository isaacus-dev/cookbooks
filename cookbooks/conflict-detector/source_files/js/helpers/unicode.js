// Python and the enrichment API count Unicode code points, rather than UTF-16 code units.
const WHITESPACE = "[\\t-\\r\\x1c-\\x20\\x85\\p{Z}]";
const LEADING_WHITESPACE = new RegExp(`^${WHITESPACE}+`, "u");
const TRAILING_WHITESPACE = new RegExp(`${WHITESPACE}+$`, "u");
const WHITESPACE_RUN = new RegExp(`${WHITESPACE}+`, "u");

export function textLength(text) {
  return Array.from(text).length;
}

let splitSource = null;
let splitChars = [];

export function sliceText(text, start, end) {
  if (text !== splitSource) {
    splitSource = text;
    splitChars = Array.from(text);
  }

  return splitChars.slice(start, end).join("");
}

export function stripTextStart(text) {
  return text.replace(LEADING_WHITESPACE, "");
}

export function stripTextEnd(text) {
  return text.replace(TRAILING_WHITESPACE, "");
}

export function stripText(text) {
  return stripTextEnd(stripTextStart(text));
}

export function splitText(text) {
  return text.split(WHITESPACE_RUN).filter(Boolean);
}
