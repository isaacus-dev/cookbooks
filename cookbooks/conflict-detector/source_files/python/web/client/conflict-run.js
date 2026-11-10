import { clauseNumberAt, definedTerm, findingTitle, sectionAt } from '/demo/markdown.js';

export const ACCENTS = {
	deviation: 'var(--cd-deviation)',
	gap_reference: 'var(--cd-gap-reference)',
	gap_input: 'var(--cd-gap-input)'
};

export const MARK_TITLES = {
	deviation: 'Deviates from the other document',
	gap_reference: 'Not addressed in the input document',
	gap_input: 'Not addressed in the reference document'
};

export const FILTERS = [
	{ id: 'deviation', label: 'Deviations', list: 'deviations' },
	{ id: 'gap_reference', label: 'Reference', list: 'gaps_reference' },
	{ id: 'gap_input', label: 'Input', list: 'gaps_input' }
];

export function collectSpans(report, side) {
	const input = side === 'input';
	const entries = report.deviations.flatMap((deviation) =>
		deviation.matches.map((match, index) => ({
			span: input ? (match.input?.span ?? deviation.span) : match.reference?.span,
			kind: 'deviation',
			key: `d${deviation.id}-${index}`
		}))
	);
	for (const gap of input ? report.gaps_input : report.gaps_reference) {
		entries.push({ span: gap.span, kind: input ? 'gap_input' : 'gap_reference', key: `${input ? 'i' : 'r'}${gap.id}` });
	}
	const byRange = new Map();
	for (const { span, kind, key } of entries) {
		if (!span) continue;
		const range = `${span.start}:${span.end}`;
		if (byRange.has(range)) byRange.get(range).keys.push(key);
		else byRange.set(range, { start: span.start, end: span.end, kind, keys: [key] });
	}
	return [...byRange.values()];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function cleanDisplayText(text) {
	if (!text) return '';
	return text
		.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/&(#\d+|[a-zA-Z]+);/g, (full, name) =>
			name[0] === '#' ? String.fromCodePoint(Number(name.slice(1))) : Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : full
		)
		.replace(/^([ \t]*)#{1,6}[ \t]+/gm, '$1')
		.replace(/^([ \t]*)[*+-][ \t]+/gm, '$1• ')
		.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
		.replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1')
		.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
		.replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, '$1');
}

const excerpts = (summary, quote) => [
	...(summary ? [{ text: cleanDisplayText(summary) }] : []),
	{ text: cleanDisplayText(quote) || '—', quote: true }
];

const fallbackTitle = (segId) => (segId ? `Clause ${segId.replace(/^seg:/, '')}` : 'Clause');

const tidy = (text) => text.replace(/\.\s*$/, '').trim();

function titleFor(heading, span, source) {
	if (!source || !span) return heading;
	return findingTitle(heading, clauseNumberAt(source.blocks, span.start), definedTerm(source.text.slice(span.start, span.end)));
}

function referenceLabel(span, source) {
	if (!source || !span) return null;
	const section = sectionAt(source.blocks, span.start);
	const number = clauseNumberAt(source.blocks, span.start);
	if (section && /^EXHIBIT [A-Z]$/.test(section) && number) return `${section}, ${number}`;
	return section ? findingTitle(section, number, null) : number ? `Clause ${number}` : null;
}

function subheadingAt(text, offset) {
	const line = text.slice(text.lastIndexOf('\n', offset - 1) + 1).trim();
	const name = /^(?:\d+\.\s*)?(?:\(\w{1,4}\)\s*)?([A-Z][^.\n]{2,60}?)\.\s/.exec(line)?.[1];
	const words = name?.split(/\s+/) ?? [];
	return words.length && words.length <= 8 && words.every((w) => /^[A-Z(]/.test(w) || /^(?:of|and|or|to|for|the|in|on|by|with)$/.test(w))
		? name
		: null;
}

function inDocumentOrder(entries) {
	const rows = entries.sort((a, b) => a.position - b.position).map((entry) => entry.row);
	const headingKey = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
	for (let start = 0; start < rows.length; ) {
		let end = start + 1;
		while (end < rows.length && rows[end].group === rows[start].group) end += 1;
		const { group } = rows[start];
		const run = rows.slice(start, end);
		if (group && run.every((row) => headingKey(row.title) === headingKey(group))) for (const row of run) row.group = undefined;
		start = end;
	}
	return rows;
}

export function findingRows(report, filterId, sources = {}) {
	if (filterId === 'deviation') {
		return inDocumentOrder(
			report.deviations.map((deviation) => {
				const matches = deviation.matches.map((match, index) => {
					const key = `d${deviation.id}-${index}`;
					const summary = report.summaries?.matches?.find((entry) => entry.key === key)?.text;
					return { key, excerpts: excerpts(summary, match.reference?.text) };
				});
				const [first] = deviation.matches;
				const span = first.input?.span ?? deviation.span;
				const text = sources.input && span ? sources.input.text.slice(span.start, span.end) : '';
				const name = definedTerm(text) ?? (span && sources.input ? subheadingAt(sources.input.text, span.start) : null);
				const reference = referenceLabel(first.reference?.span, sources.reference);
				const title =
					reference && name
						? `${tidy(reference)} (${name})`
						: reference
							? tidy(reference)
							: (name ?? tidy(titleFor(deviation.heading || fallbackTitle(deviation.seg_id), span, sources.input)));
				return {
					position: span?.start ?? 0,
					row: {
						key: matches[0].key,
						keys: matches.map((match) => match.key),
						title,
						accent: ACCENTS.deviation,
						...(matches.length > 1 ? { matches } : { excerpts: matches[0].excerpts }),
						action: 'View full clause'
					}
				};
			})
		);
	}

	const gaps = filterId === 'gap_reference' ? report.gaps_reference : report.gaps_input;
	const prefix = filterId === 'gap_reference' ? 'r' : 'i';
	const source = filterId === 'gap_reference' ? sources.reference : sources.input;

	return inDocumentOrder(
		gaps.map((gap) => {
			const key = `${prefix}${gap.id}`;
			const summary = report.summaries?.gaps?.find((entry) => entry.key === key)?.text;
			const located = source && gap.span;
			const term = located ? definedTerm(source.text.slice(gap.span.start, gap.span.end)) : null;
			const section = located ? sectionAt(source.blocks, gap.span.start) : null;
			const heading = gap.heading || (located ? subheadingAt(source.text, gap.span.start) : null);
			const title = tidy(
				term && section
					? term
					: heading
						? titleFor(heading, gap.span, source)
						: (referenceLabel(gap.span, source) ?? titleFor(fallbackTitle(gap.seg_id), gap.span, source))
			);
			return {
				position: gap.span?.start ?? 0,
				row: {
					key,
					group: section ? tidy(section) : undefined,
					title,
					accent: ACCENTS[filterId],
					excerpts: excerpts(summary, gap.text),
					...(filterId === 'gap_reference' ? { action: 'View full clause' } : {})
				}
			};
		})
	);
}
