import { h, icon } from '/demo/dom.js';

const LABEL = 'Table of contents';

export function buildOutlineTree(entries) {
	const roots = [];
	const stack = [];
	for (const { id, title, level } of entries) {
		const node = { id, title, children: [] };
		while (stack.length && stack.at(-1).level >= level) stack.pop();
		(stack.at(-1)?.node.children ?? roots).push(node);
		stack.push({ level, node });
	}
	return roots;
}

export const topLevelIds = (tree) => tree.map((node) => node.id);

export function createOutlineNav({ onSelect, onToggle } = {}) {
	const el = h('div', { className: 'demo-outline demo-scroll' });

	function renderNode(node, expandedIds) {
		const { children } = node;
		const isOpen = expandedIds.includes(node.id);
		const lead = children.length
			? h('button', {
					type: 'button',
					className: 'demo-outline__toggle demo-focus',
					'aria-expanded': String(isOpen),
					'aria-label': `${isOpen ? 'Collapse' : 'Expand'} ${node.title}`,
					innerHTML: icon(['M9 6l6 6-6 6'], 12, 2),
					onclick: () => onToggle?.(node.id)
				})
			: h('span', { className: 'demo-outline__bullet', 'aria-hidden': 'true' });
		const link = h(
			'button',
			{ type: 'button', className: 'demo-outline__link demo-focus', title: node.title, onclick: () => onSelect?.(node.id) },
			h('span', { className: 'demo-outline__label', textContent: node.title })
		);
		if (children.length) link.append(h('span', { className: 'demo-outline__child-count', textContent: String(children.length) }));
		const item = h('div', { className: 'demo-outline__item' }, h('div', { className: 'demo-outline__row' }, lead, link));
		if (children.length && isOpen) {
			item.append(h('div', { className: 'demo-outline__children' }, ...children.map((child) => renderNode(child, expandedIds))));
		}
		return item;
	}

	function update({ items = [], expandedIds = [] } = {}) {
		el.replaceChildren(
			items.length
				? h('nav', { 'aria-label': LABEL }, ...items.map((node) => renderNode(node, expandedIds)))
				: h('p', { className: 'demo-outline__empty', textContent: 'No sections detected.' })
		);
	}

	update();

	return { el, update };
}

export function createOutlineRail({ onSelect, getContainer } = {}) {
	const el = h('nav', { className: 'demo-rail demo-scroll', 'aria-label': LABEL });
	let items = [];
	let scrolledId = null;

	function render() {
		const contains = (node) => String(node.id) === scrolledId || node.children.some(contains);
		const active = scrolledId === null ? null : items.find(contains);
		el.replaceChildren(
			...items.map((item) => {
				const tick = h('button', {
					type: 'button',
					className: `demo-rail__tick demo-focus${item === active ? ' is-active' : ''}`,
					title: item.title,
					'aria-label': item.title,
					onclick: () => onSelect?.(item.id)
				});
				if (item === active) tick.setAttribute('aria-current', 'true');
				return tick;
			})
		);
	}

	(function attach() {
		const container = getContainer?.();
		if (!getContainer) return;
		if (!container) return requestAnimationFrame(attach);
		let frame = 0;
		const read = () => {
			const anchors = [...container.querySelectorAll('.demo-doc__heading[data-demo-block]')];
			const threshold = container.getBoundingClientRect().top + 32;
			let current = anchors[0];
			for (const anchor of anchors) {
				if (anchor.getBoundingClientRect().top > threshold) break;
				current = anchor;
			}
			scrolledId = current?.dataset.demoBlock ?? null;
			render();
		};
		container.addEventListener('scroll', () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(read);
		}, { passive: true });
		read();
	})();

	function update({ items: next = [] } = {}) {
		items = next;
		render();
	}

	return { el, update };
}
