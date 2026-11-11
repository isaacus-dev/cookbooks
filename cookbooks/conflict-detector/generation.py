import os
import re
import sys
import json
import shutil
import hashlib
import subprocess

from pathlib import Path
from functools import partial
from concurrent.futures import as_completed, ThreadPoolExecutor

DOCUMENTS_DIR = Path(__file__).resolve().parent / "results" / "documents"

MODEL = "claude-cli-opus"
MAX_TOKENS = 32000

BATCH_SIZE, MAX_PARALLEL_BATCHES = 15, 20
ATTEMPTS, TIMEOUT_SECONDS = 2, 15 * 60


DOCUMENTS = """<reference_document>
{reference}
</reference_document>

<input_document>
{input}
</input_document>"""

PARTIES_PROMPT = """Below is an input document. Identify its major parties: the people or organisations that sign it or are bound by it as a party. Leave out anyone who is only mentioned, such as affiliates, third parties or regulators. If the input document is not an agreement (for example, legislation or a policy), list instead the main groups it binds or protects, such as "employers" and "employees".

Respond with ONLY a JSON array, no prose and no markdown code fences, of {"id": short lowercase slug, "name": the name as the input document gives it (e.g. "The Walt Disney Company", "Robert A. Iger", or a role like "the Customer" if the input document names no one), "role": a few words on who they are in this deal}.

<input_document>
{input}
</input_document>"""

RECOMMEND_PROMPT = (
    """You are a senior lawyer. A client checks an input document against its standard, the reference document. For each finding in <findings>, write summaries, a comment, a recommendation for each party to the input document and a rewrite. <all_findings> lists every finding in this review as context; several can be on the same point.

Read both documents in full first. A finding is what a detector matched, not a confirmed difference or absence, so check it against both documents. Read qualifiers exactly ("to the extent", "unless"). Never describe a limited rule as unlimited.

Parties to the input document:
{parties}

Kinds of finding: "changed" (an input passage matched with one or more reference passages that may differ from it), "added" (an input passage that matched no reference passage) and "missing" (a reference passage that matched no input passage).

Judge each finding against the input document as it is now, never against a rewrite that you give for another finding.

Fields:
- "summaries": for a reader who skims the findings. One or two sentences each, 40 words at most. For "changed", give one per reference passage, in order: start with "The input document", then say what the reference document does instead, with the exact amount, date, condition or party that differs and its qualifiers. If only the wording differs, write exactly "Same in substance; only the wording differs." instead. For "added" and "missing", give one: what the passage secures and for which party, with its qualifiers. Never say what happens without it or that another clause lacks it.
- "falsePositive": true only if, with both full documents in view, no part of the finding changes the effect. One equivalent reference passage does not make the whole finding false. A different law, price, amount or date is a real difference.
- "comment": two to four sentences: what the input document does, what the reference document does instead, and which party this favours and why. Cite a reference clause by the number and heading it has, for example "Section 4.1 (Fees) of the reference document", after you check them.
- "referenceQuotes": exact excerpts, 80 words at most each, from other reference passages that the comment relies on. [] if none.
- "parties": for each party id, from that party's point of view:
  - "action", in this order: "ignore" if the finding is a false positive; null if it is a commercial choice, such as a price, salary or date; else "rewrite" if the rewrite helps the party, "remove" if the party gains most when the whole input passage goes (not for "missing", nor when another clause refers to it), or "ignore".
  - "reason": one sentence on what the party gains or loses, in concrete terms. Name another input clause only if it already gives the same result.
- "rewrite": the passage at the reference document's position. For "changed", redraft the input passage. For "added", narrow or qualify it toward the reference position, or give null if that position is to have no such passage. For "missing", draft the clause to insert, and cover only this finding's reference passage.
- "insertAfter": for "missing", copy exactly the end of the input document paragraph that the new clause follows: its last 8 to 15 words, or all of it if it is shorter, with its punctuation and Markdown. These words must occur only once in the input document. Choose the place a lawyer would choose: in the right section, after the most related clause. Else null.

Summaries, comment and reasons:
- Write ASD-STE100 Simplified Technical English: active voice, one idea per sentence, no sentence over 20 words, common words with one meaning.
- Use plain words for legal ideas: "a chance to fix the problem first", not "a cure period". Never write "shall", "herein", "pursuant to", "notwithstanding", "the foregoing" or "in respect of".
- Call the documents "the input document" and "the reference document", never by title or year. Name each party, for example "the Customer". Never "You" or "We".
- Never mention finding ids, the detector, this review or the rewrite. Plain text, no Markdown.
- They must agree with each other. Check each of them against the exact words of the passages before you answer.

Rewrite:
- Write it as part of the input document, in its drafting style: its defined terms, party names, capitalisation, legal words and cross-reference style, in Markdown. Adapt the reference wording to the input document. Never cite a reference section number or use a term the input document does not define.
- Go no further than the reference position. Never limit or widen an obligation the finding is not about.
- "changed" and "added": change only what the finding is about. Keep all other words, numbering, list markers and line structure.
- "missing": write the whole clause, numbered to fit its place.
- The rewrite must not contradict or repeat another clause. If it must override a clause that this finding cannot change, start with "Despite Section X,". After you move or add words, check that "this" and "such" still point to the right thing.
- Where a rule depends on who acts, say who.

Respond with ONLY one JSON object, no prose and no code fences. Map each finding id in <findings>, exactly as given, to:
{"summaries": [string], "falsePositive": boolean, "comment": string, "referenceQuotes": [string], "parties": {<party id>: {"action": "ignore" | "remove" | "rewrite" | null, "reason": string}}, "rewrite": string (null only for "added"), "insertAfter": string or null}
Include each of those finding ids once, and every party id in each.

"""
    + DOCUMENTS
    + """

<all_findings>
{index}
</all_findings>

<findings>
{findings}
</findings>"""
)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))

    except (OSError, ValueError):
        return None


def call_model(prompt: str, *, model: str, api_key: str | None, timeout=TIMEOUT_SECONDS) -> str:
    message = [{"role": "user", "content": prompt}]

    if model.startswith("claude-cli-"):
        result = subprocess.run(
            [
                "claude",
                "-p",
                "--model",
                model.removeprefix("claude-cli-"),
                "--output-format",
                "text",
                "--allowedTools",
                "",
                "--no-session-persistence",
            ],
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
        )

        if result.returncode != 0:
            raise RuntimeError(f"claude CLI exited {result.returncode}: {result.stderr.strip()[:300]}")

        return result.stdout

    if model.startswith("claude"):
        import anthropic

        reply = anthropic.Anthropic(api_key=api_key, timeout=timeout).messages.create(
            model=model, max_tokens=MAX_TOKENS, messages=message
        )

        return "".join(block.text for block in reply.content if block.type == "text")

    if model.startswith("gpt"):
        import openai

        reply = openai.OpenAI(api_key=api_key, timeout=timeout).chat.completions.create(model=model, messages=message)

        return reply.choices[0].message.content or ""

    from google import genai

    client = genai.Client(api_key=api_key, http_options={"timeout": timeout * 1000})

    return client.models.generate_content(model=model, contents=prompt).text or ""


def fill(template: str, **values) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m[1], m[0]), template)


def first_words(text: str, length=140) -> str:
    flat = " ".join(text.split())

    return f"{flat[:length]}…" if len(flat) > length else flat


def json_in(text: str, opening: str, closing: str):
    return json.loads(text[text.find(opening) : text.rfind(closing) + 1])


def trimmed(value) -> str | None:
    return (str(value).strip() or None) if value else None


def locate(text: str, quote) -> dict | None:
    if not quote:
        return None

    if (at := text.find(quote)) >= 0:
        return {"start": at, "end": at + len(quote)}

    positions, flat = [], []

    for n, char in enumerate(text):
        if char.isspace() and flat and flat[-1] == " ":
            continue

        flat.append(" " if char.isspace() else char)
        positions.append(n)

    needle = re.sub(r"\s+", " ", quote).strip()
    found = "".join(flat).find(needle)

    if not needle or found < 0:
        return None

    return {"start": positions[found], "end": positions[found + len(needle) - 1] + 1}


def insertion_point(input_text: str, quote) -> int | None:
    span = locate(input_text, quote)

    if span is None:
        return None

    line_end = input_text.find("\n", span["end"])

    return len(input_text) if line_end < 0 else line_end


def anchor(entry, quote, input_text: str) -> str | None:
    if (insert_at := insertion_point(input_text, quote)) is None:
        return f"insertAfter not found in the input document: {quote}"

    if locate(input_text[insert_at:], quote):
        return f"insertAfter occurs more than once in the input document: {quote}"

    entry["insertAfter"], entry["insertAt"] = quote, insert_at

    return None


def parse_answer(text: str, batch, *, recommendations, summaries, input_text: str, reference_text: str) -> list[str]:
    answer = json_in(text, "{", "}")
    problems = []

    for finding in batch:
        if not (entry := answer.get(finding["id"])):
            problems.append(f"{finding['id']}: no answer")

            continue

        if len(texts := entry.get("summaries") or []) != len(finding["keys"]):
            problems.append(f"{finding['id']}: {len(texts)} summaries for {len(finding['keys'])} passages")

            continue

        if not (rewrite := trimmed(entry["rewrite"])) and finding["kind"] != "added":
            problems.append(f"{finding['id']}: no rewrite")

            continue

        result = {
            "falsePositive": entry["falsePositive"],
            "comment": entry["comment"].strip(),
            "rewrite": rewrite,
            "parties": {
                party["id"]: {
                    "action": "ignore"
                    if entry["falsePositive"] or (finding["kind"] == "missing" and vote.get("action") == "remove")
                    else vote.get("action"),
                    "reason": vote.get("reason", "").strip(),
                }
                for party in recommendations["parties"]
                for vote in [entry["parties"].get(party["id"], {})]
            },
            "references": [],
        }

        for quote in entry["referenceQuotes"]:
            if span := locate(reference_text, quote):
                result["references"].append(span)

            else:
                problems.append(f"{finding['id']}: reference quote not found (dropped): {first_words(quote, 80)}")

        if finding["kind"] == "missing" and (problem := anchor(result, trimmed(entry["insertAfter"]), input_text)):
            problems.append(f"{finding['id']}: {problem}")

            continue

        recommendations["findings"][finding["id"]] = result
        summaries.update(zip(finding["keys"], (t.strip() for t in texts), strict=True))

    return problems


def run_batches(findings, save, *, ask, template: str, values: dict, pending, settle, label: str):
    done = total = 0

    for _ in range(ATTEMPTS):
        todo = [f for f in findings if pending(f)]
        batches = [todo[n : n + BATCH_SIZE] for n in range(0, len(todo), BATCH_SIZE)]
        total += len(batches)

        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_BATCHES) as pool:
            calls = {
                pool.submit(ask, fill(template, **values, findings="\n\n".join(f["block"] for f in batch))): batch
                for batch in batches
            }

            for call in as_completed(calls):
                try:
                    problems = settle(call.result(), calls[call])

                except Exception as error:
                    problems = [f"batch of {', '.join(f['id'] for f in calls[call])} failed: {error}"]

                save()
                done += 1

                for problem in problems:
                    print(f"{label}: {problem}", file=sys.stderr)

                print(f"{label} {done}/{total}", flush=True)

    if left := sum(1 for f in findings if pending(f)):
        print(f"{label}: gave up on {left} findings", file=sys.stderr)


def read_run(run_dir) -> tuple[Path, dict]:
    path = Path(run_dir) / "report.json"

    if (report := read_json(path)) is None:
        sys.exit(f"No saved run in {run_dir}: run the comparison in the notebook first")

    return path, report


def write_report(path, report):
    scratch = path.with_suffix(".json.tmp")
    scratch.write_text(json.dumps(report, indent=2), encoding="utf-8")
    os.replace(scratch, path)


def save_run(path, report, summaries):
    report["summaries"] = {
        "model": report["recommendations"]["model"],
        "matches": [
            {"key": key, "deviation_id": d["id"], "match_index": i, "text": summaries[key]}
            for d in report["deviations"]
            for i in range(len(d["matches"]))
            if (key := f"d{d['id']}-{i}") in summaries
        ],
        "gaps": [
            {"key": key, "gap_id": g["id"], "side": side, "text": summaries[key]}
            for side in ("reference", "input")
            for g in report[f"gaps_{side}"]
            if (key := f"{side[0]}{g['id']}") in summaries
        ],
    }
    write_report(path, report)


def generate_run(run_dir, *, model: str = MODEL, api_key: str | None = None, use_cache: bool = True) -> dict:
    cli = model.startswith("claude-cli-")
    key = (
        "ANTHROPIC_API_KEY"
        if model.startswith("claude")
        else "OPENAI_API_KEY"
        if model.startswith("gpt")
        else "GOOGLE_API_KEY"
    )

    api_key = api_key or os.environ.get(key)

    if not (shutil.which("claude") if cli else api_key):
        sys.exit(
            f"No client for {model}: "
            + (
                "`claude` is not on PATH: install Claude Code, or use an API model"
                if cli
                else f"pass api_key, or set {key} in .env"
            )
        )

    path, report = read_run(run_dir)
    texts = {}

    for side in ("reference", "input"):
        identity = report.get(side) or {}
        text = (read_json(DOCUMENTS_DIR / f"{identity.get('source_sha256')}.json") or {}).get("text")

        if text is None or hashlib.sha256(text.encode("utf-8")).hexdigest() != identity.get("text_sha256"):
            sys.exit(f"The documents behind {run_dir} have changed: run the comparison in the notebook again")

        texts[side] = text

    saved = report.get("recommendations") if use_cache else None

    if not saved or saved["model"] != model:
        saved = {"model": model, "parties": None, "findings": {}}

    recommendations = report["recommendations"] = saved
    summaries = {
        row["key"]: row["text"]
        for kind in ("matches", "gaps")
        for row in (report.get("summaries") or {}).get(kind, [])
        if saved["findings"]
    }
    findings = [
        {
            "id": f"d{d['id']}-0",
            "kind": "changed",
            "heading": d["heading"],
            "draft": texts["input"][s["start"] : s["end"]] if (s := m["input"]["span"]) else m["input"]["text"],
            "standards": [match["reference"]["text"] for match in d["matches"]],
            "keys": [f"d{d['id']}-{i}" for i in range(len(d["matches"]))],
        }
        for d in report["deviations"]
        for m in d["matches"][:1]
    ]
    findings += [
        {
            "id": f"i{g['id']}",
            "kind": "added",
            "heading": g["heading"],
            "draft": g["text"],
            "standards": [],
            "keys": [f"i{g['id']}"],
        }
        for g in report["gaps_input"]
    ]
    findings += [
        {
            "id": f"r{g['id']}",
            "kind": "missing",
            "heading": g["heading"],
            "standards": [g["text"]],
            "keys": [f"r{g['id']}"],
        }
        for g in report["gaps_reference"]
    ]

    for f in findings:
        refs = f["standards"]
        f["block"] = "\n".join(
            filter(
                None,
                (
                    f'<finding id="{f["id"]}" kind="{f["kind"]}">',
                    f["heading"] and f"Heading: {f['heading']}",
                    "draft" in f and f"Input passage:\n{f['draft'].strip()}",
                    *(
                        f"Reference passage{f' {n}' if len(refs) > 1 else ''}:\n{r.strip()}"
                        for n, r in enumerate(refs, 1)
                    ),
                    "</finding>",
                ),
            )
        )

    save = partial(save_run, path, report, summaries)
    ask = partial(call_model, model=model, api_key=api_key)

    print("STAGE: Finding parties", flush=True)

    for _ in range(0 if recommendations["parties"] else ATTEMPTS):
        try:
            rows = json_in(ask(fill(PARTIES_PROMPT, **texts)), "[", "]")

        except Exception as error:
            print(f"Finding parties failed: {error}", file=sys.stderr)

            continue

        if rows:
            recommendations["parties"] = rows
            save()

            break

        print("Finding parties failed: the answer named no parties", file=sys.stderr)

    if not recommendations["parties"]:
        sys.exit("Could not find the parties to the input document")

    print("STAGE: Summarizing and recommending", flush=True)
    run_batches(
        findings,
        save,
        ask=ask,
        template=RECOMMEND_PROMPT,
        values={
            **texts,
            "parties": "\n".join(f"- {p['id']}: {p['name']} ({p['role']})" for p in recommendations["parties"]),
            "index": "\n".join(
                f"- {f['id']} ({f['kind']}){' ' + f['heading'] if f['heading'] else ''}: "
                f"{first_words(f.get('draft') or f['standards'][0])}"
                for f in findings
            ),
        },
        pending=lambda f: f["id"] not in recommendations["findings"] or any(k not in summaries for k in f["keys"]),
        settle=partial(
            parse_answer,
            recommendations=recommendations,
            summaries=summaries,
            input_text=texts["input"],
            reference_text=texts["reference"],
        ),
        label="Summarizing and recommending",
    )

    return report
