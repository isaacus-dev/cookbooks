import re

from functools import cache

import ftfy

from text2markdown import text2markdown

NON_STANDARD_CONTROL_CHARS_RE = re.compile(r"[" + re.escape("\a\b\f\r\v") + "]")
START_OF_TEXT_THAT_IS_ONLY_WHITESPACE_FOLLOWED_BY_NEWLINE_RE = re.compile(r"^\s*\n")
END_OF_TEXT_THAT_IS_ONLY_WHITESPACE_PRECEDED_BY_NEWLINE_RE = re.compile(r"\n\s*$")


def clean_text(text: str) -> str:
    text = ftfy.fix_text(text)
    text = text.replace("\xa0", " ")
    text = NON_STANDARD_CONTROL_CHARS_RE.sub("", text)
    text = "\n".join([re.sub(r"\s+$", "", line) for line in text.split("\n")])
    text = START_OF_TEXT_THAT_IS_ONLY_WHITESPACE_FOLLOWED_BY_NEWLINE_RE.sub("", text)

    return END_OF_TEXT_THAT_IS_ONLY_WHITESPACE_PRECEDED_BY_NEWLINE_RE.sub("", text)


# A document can be loaded more than once in a run; convert it only once
@cache
def to_markdown(text: str) -> str:
    # Skip cross-reference links: they don't help the models, and their HTML would stop ftfy decoding entities
    return text2markdown(text, link_xrefs=False)


def normalize_text(text: str, *, markdown: bool) -> str:
    if not markdown:
        text = to_markdown(text)

    return clean_text(text)
