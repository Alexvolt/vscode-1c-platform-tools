const vscodeApi = acquireVsCodeApi();
const areas = sheetState.areas;
const rowCount = sheetState.rowCount;
// Лист строится заново после правки ячейки и при возврате на вкладку: прокрутка,
// поиск и область переживают перестроение через состояние webview
const saved = vscodeApi.getState() || {};

function remember(patch) {
	vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, patch));
}

function clear(className) {
	for (const node of document.querySelectorAll('.' + className)) {
		node.classList.remove(className);
	}
}

function showArea(chip, scroll) {
	clear('mark');
	for (const item of document.querySelectorAll('.chip')) {
		item.classList.remove('active');
	}
	chip.classList.add('active');
	const area = areas[Number(chip.dataset.area)];
	const beginRow = area.beginRow < 0 ? 0 : area.beginRow;
	const endRow = area.endRow < 0 ? rowCount - 1 : area.endRow;
	const beginColumn = area.beginColumn < 0 ? 0 : area.beginColumn;
	const endColumn = area.endColumn < 0 ? sheetState.columnCount - 1 : area.endColumn;
	if (area.kind !== 'columns') {
		for (let row = beginRow; row <= endRow; row++) {
			document.querySelector('tr[data-row="' + row + '"]')?.classList.add('mark');
		}
	}
	if (area.kind !== 'rows') {
		for (const cell of document.querySelectorAll('td[data-col]')) {
			const column = Number(cell.dataset.col);
			const row = Number(cell.parentElement && cell.parentElement.dataset.row);
			if (column >= beginColumn && column <= endColumn && (area.kind === 'columns' || (row >= beginRow && row <= endRow))) {
				cell.classList.add('mark');
			}
		}
	}
	const target = document.querySelector('tr[data-row="' + beginRow + '"]');
	if (target && scroll) {
		target.scrollIntoView({ block: 'center' });
	}
}

for (const chip of document.querySelectorAll('[data-area]')) {
	chip.addEventListener('click', () => {
		showArea(chip, true);
		remember({ area: chip.dataset.area });
	});
}

const input = document.querySelector('input');
const found = document.querySelector('.found');
let hits = [];
let hit = 0;

function search(next, scroll = true) {
	const query = input.value.trim().toLowerCase();
	remember({ query: input.value });
	clear('hit');
	if (!query) {
		found.textContent = '';
		hits = [];
		return;
	}
	if (!next) {
		hits = [...document.querySelectorAll('tbody td')].filter((cell) => cell.textContent.toLowerCase().includes(query));
		hit = 0;
	} else if (hits.length) {
		hit = (hit + 1) % hits.length;
	}
	found.textContent = hits.length ? (hit + 1) + ' из ' + hits.length : 'нет';
	const cell = hits[hit];
	if (cell) {
		cell.classList.add('hit');
		if (scroll) {
			cell.scrollIntoView({ block: 'center', inline: 'center' });
		}
	}
}

input.addEventListener('input', () => search(false));
input.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') {
		search(true);
	}
});

document.querySelector('tbody')?.addEventListener('dblclick', (event) => {
	const cell = event.target.closest('td[data-edit]');
	if (!cell || cell.querySelector('input')) {
		return;
	}
	const editor = document.createElement('input');
	editor.className = 'cell-edit';
	editor.value = cell.dataset.text || '';
	cell.textContent = '';
	cell.append(editor);
	editor.focus();
	editor.select();
	let done = false;
	const cancel = () => {
		if (done) {
			return;
		}
		done = true;
		cell.textContent = cell.dataset.parameter === '1' ? '<' + (cell.dataset.text || '') + '>' : (cell.dataset.text || '');
	};
	const commit = () => {
		if (done) {
			return;
		}
		done = true;
		const text = editor.value;
		cell.dataset.text = text;
		cell.textContent = cell.dataset.parameter === '1' ? '<' + text + '>' : text;
		vscodeApi.postMessage({
			type: 'setText',
			row: Number(cell.dataset.srcRow),
			column: Number(cell.dataset.srcCol),
			text: text,
			parameter: cell.dataset.parameter === '1',
		});
	};
	editor.addEventListener('keydown', (keyEvent) => {
		if (keyEvent.key === 'Enter') {
			keyEvent.preventDefault();
			commit();
		}
		if (keyEvent.key === 'Escape') {
			keyEvent.preventDefault();
			cancel();
		}
	});
	editor.addEventListener('blur', () => commit());
});

const scroller = document.querySelector('.scroll');
let scrollPending = false;
scroller.addEventListener('scroll', () => {
	if (scrollPending) {
		return;
	}
	scrollPending = true;
	requestAnimationFrame(() => {
		scrollPending = false;
		remember({ top: scroller.scrollTop, left: scroller.scrollLeft });
	});
});

const savedChip = saved.area === undefined ? null : document.querySelector('[data-area="' + saved.area + '"]');
if (savedChip) {
	showArea(savedChip, false);
}
if (saved.query) {
	input.value = saved.query;
	search(false, false);
}
scroller.scrollTop = saved.top || 0;
scroller.scrollLeft = saved.left || 0;
