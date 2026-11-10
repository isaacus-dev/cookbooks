import { h } from '/demo/dom.js';

export function createDocumentViewer({ markAccents = {}, markTitles = {}, onSelectMark, onHoverKey, registerMark } = {}) {
	const bodyEl = h('article', { className: 'demo-doc__body demo-scroll' });
	const el = h('div', { className: 'demo-doc' }, bodyEl);
	let blocks;
	let activeKey = null;
	let hoverKey = null;

	function formatted(seg, linked) {
		let node = document.createTextNode(seg.text);
		if (seg.emphasis) node = h('em', null, node);
		if (seg.strong) node = h('strong', null, node);
		if (!seg.href || !linked) return node;
		return h('a', { className: 'demo-doc__link', href: seg.href, target: '_blank', rel: 'external noopener noreferrer' }, node);
	}

	function setHover(key, fromMark = false) {
		if (key === hoverKey) return;
		hoverKey = key;
		for (const node of bodyEl.querySelectorAll('.demo-doc__para--bar')) {
			node.classList.toggle('is-hover', key !== null && node.dataset.keys.split(' ').includes(key));
		}
		if (fromMark) onHoverKey?.(key);
	}

	function renderSegments(container, segments) {
		const runs = [];
		for (const seg of segments) {
			const keys = seg.keys ?? [];
			const last = runs.at(-1);
			if (seg.kind && last?.kind === seg.kind && last.keys.join() === keys.join()) last.parts.push(seg);
			else runs.push({ kind: seg.kind, keys, parts: [seg] });
		}
		for (const { kind, keys, parts } of runs) {
			if (!kind) {
				container.append(formatted(parts[0], true));
				continue;
			}
			const clickable = Boolean(onSelectMark && keys.length);
			const mark = h('mark', { className: 'demo-doc__mark' }, ...parts.map((part) => formatted(part, !clickable)));
			if (markAccents[kind]) mark.style.setProperty('--demo-mark-accent', markAccents[kind]);
			if (markTitles[kind]) mark.title = markTitles[kind];
			if (clickable) {
				const select = () => onSelectMark(keys[(keys.indexOf(activeKey) + 1) % keys.length]);
				Object.assign(mark, {
					tabIndex: 0,
					onclick: select,
					onkeydown: (event) => {
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault();
						select();
					},
					onpointermove: () => setHover(keys[0], true),
					onpointerleave: () => setHover(null, true)
				});
				mark.setAttribute('role', 'button');
			}
			registerMark?.(mark, keys);
			container.append(mark);
		}
	}

	function render() {
		if (!blocks?.length) {
			bodyEl.replaceChildren(h('p', { className: 'demo-doc__status', textContent: blocks ? 'This document is empty.' : 'Loading…' }));
			return;
		}
		const bars = blocks.map((block) => {
			if (block.kind !== 'paragraph') return undefined;
			const marked = block.segments.filter((seg) => seg.kind);
			if (!marked.length) return undefined;
			return { accent: markAccents[marked[0].kind], keys: [...new Set(marked.flatMap((seg) => seg.keys ?? []))] };
		});
		const shares = (a, b) => Boolean(a && b && a.keys.some((key) => b.keys.includes(key)));
		const onMark = (event) => event.target.closest('.demo-doc__mark[role="button"]');

		bodyEl.replaceChildren(
			...blocks.map((block, i) => {
				if (block.kind === 'heading') {
					const heading = h(`h${Math.min(Math.max(block.level, 1), 6)}`, { className: 'demo-doc__heading', textContent: block.text });
					heading.dataset.demoBlock = block.start;
					return heading;
				}
				const p = h('p', { className: 'demo-doc__para' });
				p.dataset.demoBlock = block.start;
				if (block.indent > 0) {
					p.classList.add('demo-clause');
					p.style.setProperty('--demo-chrome-clause-depth', String(block.indent));
				}
				if (block.marker) {
					const body = h('span', { className: 'demo-clause__body' });
					renderSegments(body, block.segments);
					p.classList.add('demo-clause--marked');
					p.append(h('span', { className: 'demo-clause__marker', textContent: block.marker }), body);
				} else renderSegments(p, block.segments);

				const bar = bars[i];
				if (!bar) return p;
				p.classList.add('demo-doc__para--bar');
				p.classList.toggle('joins-prev', shares(bars[i - 1], bar));
				p.classList.toggle('joins-next', shares(bar, bars[i + 1]));
				p.dataset.keys = bar.keys.join(' ');
				if (bar.accent) p.style.setProperty('--demo-mark-accent', bar.accent);
				if (activeKey !== null && bar.keys.includes(activeKey)) p.classList.add('is-active');
				if (hoverKey !== null && bar.keys.includes(hoverKey)) p.classList.add('is-hover');
				if (onSelectMark) {
					p.classList.add('is-clickable');
					p.onclick = (event) => onMark(event) || onSelectMark(bar.keys[0]);
					p.onpointermove = (event) => onMark(event) || setHover(bar.keys[0], true);
					p.onpointerleave = () => setHover(null, true);
				}
				return p;
			})
		);
	}

	function update({ blocks: next, activeKey: key = null } = {}) {
		blocks = next;
		activeKey = key;
		render();
	}

	update();

	return { el, bodyEl, update, setHoverKey: (key) => setHover(key) };
}
