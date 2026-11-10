import { fixText } from "./helpers/ftfy.js";
import { stripTextEnd } from "./helpers/unicode.js";
import { text2markdown } from "./helpers/text2markdown.js";

export const NON_STANDARD_CONTROL_CHARS_RE = /[\x07\x08\x0c\r\x0b]/g;
export const START_OF_TEXT_THAT_IS_ONLY_WHITESPACE_FOLLOWED_BY_NEWLINE_RE = /^\s*\n/;
export const END_OF_TEXT_THAT_IS_ONLY_WHITESPACE_PRECEDED_BY_NEWLINE_RE = /\n\s*$/;

export function cleanText(text) {
  text = fixText(text);
  text = text.replaceAll("\xa0", " ");
  text = text.replace(NON_STANDARD_CONTROL_CHARS_RE, "");
  text = text.split("\n").map((line) => stripTextEnd(line)).join("\n");
  text = text.replace(START_OF_TEXT_THAT_IS_ONLY_WHITESPACE_FOLLOWED_BY_NEWLINE_RE, "");

  return text.replace(END_OF_TEXT_THAT_IS_ONLY_WHITESPACE_PRECEDED_BY_NEWLINE_RE, "");
}

// A document can be loaded more than once in a run; convert it only once
const markdownCache = new Map();

export async function toMarkdown(text) {
  if (!markdownCache.has(text)) {
    // Skip cross-reference links: they don't help the models, and their HTML would stop ftfy decoding entities
    markdownCache.set(text, await text2markdown(text, { linkXrefs: false }));
  }

  return markdownCache.get(text);
}

export async function normalizeText(text, { markdown }) {
  if (!markdown) {
    text = await toMarkdown(text);
  }

  return cleanText(text);
}
