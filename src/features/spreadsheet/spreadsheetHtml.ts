/**
 * Показ табличного документа, который прочитала md-sparrow (`cf-spreadsheet-get`).
 *
 * Страница вкладки — `resources/webview/spreadsheet.*`. Здесь только сетка листа.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Ответ `cf-spreadsheet-get`. Координаты нулевые, как в выгрузке. */
export interface SpreadsheetDto {
	rowCount?: number;
	rows?: SpreadsheetRow[];
	columnSets?: SpreadsheetColumnSet[];
	formats?: SpreadsheetFormat[];
	fonts?: SpreadsheetFont[];
	lines?: SpreadsheetLine[];
	merges?: SpreadsheetMerge[];
	areas?: SpreadsheetArea[];
	drawings?: SpreadsheetDrawing[];
}

interface SpreadsheetRow {
	index?: number;
	formatIndex?: number;
	columnsId?: string;
	/** Индекс строки в файле, если показ развернул диапазон indexTo. */
	sourceIndex?: number;
	cells?: SpreadsheetCell[];
}

interface SpreadsheetCell {
	column?: number;
	text?: string;
	formatIndex?: number;
	parameter?: boolean;
	detail?: string;
	/** Колонка в файле, если на листе она сдвинута в общую сетку. */
	sourceColumn?: number;
}

interface SpreadsheetColumnSet {
	id?: string;
	size?: number;
	columns?: Array<{ column?: number; formatIndex?: number }>;
}

interface SpreadsheetFormat {
	font?: number;
	leftBorder?: number;
	topBorder?: number;
	rightBorder?: number;
	bottomBorder?: number;
	height?: number;
	width?: number;
	hAlign?: string;
	vAlign?: string;
	wrap?: boolean;
}

interface SpreadsheetFont {
	face?: string;
	sizePt?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikeout?: boolean;
}

interface SpreadsheetLine {
	style?: string;
	width?: number;
}

interface SpreadsheetMerge {
	row?: number;
	column?: number;
	rowSpan?: number;
	colSpan?: number;
	columnsId?: string;
}

interface SpreadsheetArea {
	name?: string;
	kind?: string;
	beginRow?: number;
	endRow?: number;
	beginColumn?: number;
	endColumn?: number;
}

interface SpreadsheetDrawing {
	row?: number;
	column?: number;
	label?: string;
}

const MAX_ROWS = 400;
const DEFAULT_COLUMN_WIDTH = 72;

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function widthPx(units: number | undefined): number | undefined {
	if (units === undefined || units <= 0) {
		return undefined;
	}
	return Math.max(12, Math.round(units));
}

function heightPx(units: number | undefined): number | undefined {
	if (units === undefined || units <= 0) {
		return undefined;
	}
	return Math.max(4, Math.round((units * 96) / 288));
}

function formatAt(sheet: SpreadsheetDto, index: number | undefined): SpreadsheetFormat | undefined {
	if (index === undefined || index <= 0) {
		return undefined;
	}
	return sheet.formats?.[index - 1];
}

interface LineEdge {
	style: string;
	width: number;
}

function cellCss(sheet: SpreadsheetDto, format: SpreadsheetFormat | undefined): string {
	if (!format) {
		return '';
	}
	const font = format.font !== undefined ? sheet.fonts?.[format.font] : undefined;
	const parts: string[] = [];
	if (font) {
		const face = (font.face ?? '').replace(/[^\p{L}\p{N} \-]/gu, '') || 'Arial';
		const size = font.sizePt && font.sizePt > 0 ? font.sizePt : 10;
		parts.push(`font-family:${face},Arial,sans-serif;font-size:${size}pt;`);
		if (font.bold) {
			parts.push('font-weight:700;');
		}
		if (font.italic) {
			parts.push('font-style:italic;');
		}
		const decoration = [font.underline ? 'underline' : '', font.strikeout ? 'line-through' : ''].filter((item) => item.length > 0);
		if (decoration.length > 0) {
			parts.push(`text-decoration:${decoration.join(' ')};`);
		}
	}
	if (format.hAlign) {
		parts.push(`text-align:${format.hAlign};`);
	}
	if (format.vAlign) {
		parts.push(`vertical-align:${format.vAlign === 'center' ? 'middle' : format.vAlign};`);
	}
	if (format.wrap) {
		parts.push('white-space:pre-wrap;');
	}
	return parts.join('');
}

function lineEdge(sheet: SpreadsheetDto, index: number | undefined): LineEdge | undefined {
	if (index === undefined) {
		return undefined;
	}
	const line = sheet.lines?.[index];
	if (!line?.style || line.style === 'none') {
		return undefined;
	}
	return { style: line.style, width: line.width && line.width > 0 ? line.width : 1 };
}

function formatEdge(sheet: SpreadsheetDto, format: SpreadsheetFormat | undefined, side: 'left' | 'top' | 'right' | 'bottom'): LineEdge | undefined {
	if (!format) {
		return undefined;
	}
	const index = side === 'left' ? format.leftBorder : side === 'top' ? format.topBorder : side === 'right' ? format.rightBorder : format.bottomBorder;
	return lineEdge(sheet, index);
}

function stronger(current: LineEdge | undefined, next: LineEdge | undefined): LineEdge | undefined {
	if (!current) {
		return next;
	}
	if (!next) {
		return current;
	}
	return next.width > current.width ? next : current;
}

/** Рамка видимой ячейки: своя, соседей и ячеек внутри объединения. */
function spanBorders(
	sheet: SpreadsheetDto,
	formats: Map<string, number>,
	row: number,
	column: number,
	rowSpan: number,
	colSpan: number
): string {
	const at = (r: number, c: number, side: 'left' | 'top' | 'right' | 'bottom'): LineEdge | undefined =>
		formatEdge(sheet, formatAt(sheet, formats.get(`${r}:${c}`)), side);
	let left: LineEdge | undefined;
	let right: LineEdge | undefined;
	let top: LineEdge | undefined;
	let bottom: LineEdge | undefined;
	for (let r = row; r < row + rowSpan; r += 1) {
		left = stronger(left, at(r, column, 'left') ?? at(r, column - 1, 'right'));
		right = stronger(right, at(r, column + colSpan - 1, 'right') ?? at(r, column + colSpan, 'left'));
	}
	for (let c = column; c < column + colSpan; c += 1) {
		top = stronger(top, at(row, c, 'top') ?? at(row - 1, c, 'bottom'));
		bottom = stronger(bottom, at(row + rowSpan - 1, c, 'bottom') ?? at(row + rowSpan, c, 'top'));
	}
	const css = (side: string, edge: LineEdge | undefined): string =>
		edge ? `border-${side}:${edge.width}px ${edge.style} #222;` : '';
	return `${css('left', left)}${css('top', top)}${css('right', right)}${css('bottom', bottom)}`;
}

interface Section {
	columnsId?: string;
	from: number;
	to: number;
}

function sectionsOf(rows: Map<number, SpreadsheetRow>, rowCount: number): Section[] {
	const sections: Section[] = [];
	for (let index = 0; index < rowCount; index += 1) {
		const columnsId = rows.get(index)?.columnsId;
		const last = sections[sections.length - 1];
		if (last && last.columnsId === columnsId && last.to === index - 1) {
			last.to = index;
			continue;
		}
		sections.push({ columnsId, from: index, to: index });
	}
	return sections;
}

function mergeMatches(merge: SpreadsheetMerge, columnsId: string | undefined): boolean {
	if (!merge.columnsId) {
		return columnsId === undefined;
	}
	return merge.columnsId === columnsId;
}

function renderSection(sheet: SpreadsheetDto, section: Section, rows: Map<number, SpreadsheetRow>): string {
	const set = sheet.columnSets?.find((item) => item.id === section.columnsId) ?? sheet.columnSets?.[0];
	const widths = new Map<number, number>();
	for (const column of set?.columns ?? []) {
		if (column.column === undefined) {
			continue;
		}
		const width = widthPx(formatAt(sheet, column.formatIndex)?.width);
		if (width !== undefined) {
			widths.set(column.column, width);
		}
	}
	let columns = set?.size ?? 0;
	for (let index = section.from; index <= section.to; index += 1) {
		for (const cell of rows.get(index)?.cells ?? []) {
			if (cell.column !== undefined) {
				columns = Math.max(columns, cell.column + 1);
			}
		}
	}
	for (const merge of sheet.merges ?? []) {
		if (merge.row === undefined || merge.column === undefined || merge.row < section.from || merge.row > section.to) {
			continue;
		}
		if (!mergeMatches(merge, section.columnsId)) {
			continue;
		}
		columns = Math.max(columns, merge.column + (merge.colSpan ?? 1));
	}
	columns = Math.max(columns, 1);
	const formats = new Map<string, number>();
	for (const [index, row] of rows) {
		for (const cell of row.cells ?? []) {
			if (cell.column !== undefined && cell.formatIndex !== undefined && cell.formatIndex > 0) {
				formats.set(`${index}:${cell.column}`, cell.formatIndex);
			}
		}
	}
	const covered = new Set<string>();
	const spans = new Map<string, { rowSpan: number; colSpan: number }>();
	for (const merge of sheet.merges ?? []) {
		if (
			merge.row === undefined
			|| merge.column === undefined
			|| merge.row < section.from
			|| merge.row > section.to
			|| !mergeMatches(merge, section.columnsId)
			|| merge.column >= columns
		) {
			continue;
		}
		const rowSpan = Math.min(merge.rowSpan ?? 1, section.to - merge.row + 1);
		const colSpan = Math.min(merge.colSpan ?? 1, columns - merge.column);
		if (rowSpan < 1 || colSpan < 1) {
			continue;
		}
		const originRow = merge.row;
		const originColumn = merge.column;
		spans.set(`${originRow}:${originColumn}`, { rowSpan, colSpan });
		for (let row = originRow; row < originRow + rowSpan; row += 1) {
			for (let col = originColumn; col < originColumn + colSpan; col += 1) {
				if (row !== originRow || col !== originColumn) {
					covered.add(`${row}:${col}`);
				}
			}
		}
	}
	const drawings = new Map<string, string>();
	for (const drawing of sheet.drawings ?? []) {
		if (drawing.row === undefined || drawing.column === undefined || !drawing.label) {
			continue;
		}
		if (drawing.row < section.from || drawing.row > section.to) {
			continue;
		}
		drawings.set(`${drawing.row}:${drawing.column}`, drawing.label);
	}
	const cols = Array.from({ length: columns }, (_, column) => `<col style="width:${widths.get(column) ?? DEFAULT_COLUMN_WIDTH}px">`).join('');
	const head = Array.from({ length: columns }, (_, column) => `<th class="col">${column + 1}</th>`).join('');
	const body: string[] = [];
	for (let index = section.from; index <= section.to; index += 1) {
		const row = rows.get(index);
		const cells = new Map((row?.cells ?? []).map((cell) => [cell.column, cell]));
		const height = heightPx(formatAt(sheet, row?.formatIndex)?.height);
		const tds = [`<td class="rn">${index + 1}</td>`];
		for (let column = 0; column < columns; column += 1) {
			const key = `${index}:${column}`;
			if (covered.has(key)) {
				continue;
			}
			const cell = cells.get(column);
			const span = spans.get(key);
			const drawing = drawings.get(key);
			const raw = cell?.text ?? '';
			const shown = cell?.parameter && raw.length > 0 ? `<${raw}>` : raw.length > 0 ? raw : (drawing ?? '');
			const spanSize = span ?? { rowSpan: 1, colSpan: 1 };
			const css = `${cellCss(sheet, formatAt(sheet, cell?.formatIndex))}${spanBorders(sheet, formats, index, column, spanSize.rowSpan, spanSize.colSpan)}`;
			const title = cell?.detail ? ` title="${escapeHtml(cell.detail)}"` : '';
			const spanAttr = span ? ` rowspan="${span.rowSpan}" colspan="${span.colSpan}"` : '';
			const editable = raw.length > 0 || cell?.parameter === true;
			const srcRow = row?.sourceIndex ?? index;
			const srcCol = cell?.sourceColumn ?? column;
			const mark = cell?.parameter ? ' class="param"' : !raw && drawing ? ' class="drawing"' : '';
			const editAttr = editable
				? ` data-edit="1" data-src-row="${srcRow}" data-src-col="${srcCol}" data-text="${escapeHtml(raw)}"${cell?.parameter ? ' data-parameter="1"' : ''}`
				: '';
			tds.push(`<td data-col="${column}" style="${css}"${spanAttr}${title}${mark}${editAttr}>${escapeHtml(shown)}</td>`);
		}
		body.push(`<tr data-row="${index}"${height ? ` style="height:${height}px"` : ''}>${tds.join('')}</tr>`);
	}
	return `<div class="paper"><table><colgroup><col class="rn">${cols}</colgroup><thead><tr><th class="corner"></th>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}

function columnWidths(sheet: SpreadsheetDto, set: SpreadsheetColumnSet | undefined, count: number): number[] {
	const widths = Array.from({ length: count }, () => DEFAULT_COLUMN_WIDTH);
	for (const column of set?.columns ?? []) {
		if (column.column === undefined || column.column < 0 || column.column >= count) {
			continue;
		}
		widths[column.column] = widthPx(formatAt(sheet, column.formatIndex)?.width) ?? DEFAULT_COLUMN_WIDTH;
	}
	return widths;
}

function edgesOf(widths: number[]): number[] {
	const edges = [0];
	for (const width of widths) {
		edges.push((edges[edges.length - 1] ?? 0) + width);
	}
	return edges;
}

/** Колонка общей сетки, в которую попадает координата x. */
function columnAt(edges: number[], x: number): number {
	let index = 0;
	for (let cursor = 0; cursor < edges.length - 1; cursor += 1) {
		if ((edges[cursor] ?? 0) <= x) {
			index = cursor;
		}
	}
	return index;
}

/**
 * Одна сетка на весь лист.
 *
 * У макета бывают разные наборы колонок для шапки и таблицы. В конфигураторе
 * это всё равно один лист: узкие колонки шапки складываются в широкие колонки таблицы.
 */
function unifySheet(sheet: SpreadsheetDto): SpreadsheetDto {
	const sets = sheet.columnSets ?? [];
	if (sets.length <= 1) {
		return sheet;
	}
	const primary = sets.reduce((best, set) => ((set.size ?? 0) > (best.size ?? 0) ? set : best), sets[0]);
	const count = Math.max(primary?.size ?? 0, 1);
	const primaryEdges = edgesOf(columnWidths(sheet, primary, count));
	const mappedMerges: NonNullable<SpreadsheetDto['merges']> = [];
	const rows = (sheet.rows ?? []).map((row) => {
		const set = sets.find((item) => item.id && item.id === row.columnsId) ?? sets.find((item) => !item.id) ?? primary;
		if (!row.columnsId || set === primary) {
			return { ...row, columnsId: undefined };
		}
		const used = (row.cells ?? []).reduce((max, cell) => Math.max(max, (cell.column ?? 0) + 1), set?.size ?? 0);
		const setEdges = edgesOf(columnWidths(sheet, set, Math.max(used, 1)));
		const cells = (row.cells ?? []).map((cell) => {
			const column = cell.column ?? 0;
			const start = columnAt(primaryEdges, setEdges[column] ?? 0);
			const end = columnAt(primaryEdges, Math.max((setEdges[column + 1] ?? start) - 1, setEdges[column] ?? 0));
			if (end > start && row.index !== undefined) {
				mappedMerges.push({ row: row.index, column: start, rowSpan: 1, colSpan: end - start + 1 });
			}
			return { ...cell, column: start, sourceColumn: cell.sourceColumn ?? column };
		});
		return { ...row, columnsId: undefined, cells };
	});
	const merges = [...(sheet.merges ?? []), ...mappedMerges].map((merge) => {
		if (!merge.columnsId) {
			return merge;
		}
		const set = sets.find((item) => item.id === merge.columnsId);
		if (!set) {
			return { ...merge, columnsId: undefined };
		}
		const span = merge.colSpan ?? 1;
		const used = Math.max(set.size ?? 0, (merge.column ?? 0) + span);
		const setEdges = edgesOf(columnWidths(sheet, set, used));
		const start = columnAt(primaryEdges, setEdges[merge.column ?? 0] ?? 0);
		const end = columnAt(primaryEdges, Math.max((setEdges[(merge.column ?? 0) + span] ?? start) - 1, 0));
		return { ...merge, column: start, colSpan: Math.max(1, end - start + 1), columnsId: undefined };
	});
	return {
		...sheet,
		rows,
		merges,
		columnSets: [{ size: count, columns: primary?.columns }],
	};
}

/** Область на весь лист не показываем: это сам документ, а не секция макета. */
function sectionAreas(areas: SpreadsheetArea[], rowCount: number): SpreadsheetArea[] {
	return areas.filter((area) => {
		if (!area.name || rowCount <= 1) {
			return Boolean(area.name);
		}
		const allRows = (area.beginRow ?? 0) <= 0 && (area.endRow ?? 0) >= rowCount - 1;
		const allColumns = (area.beginColumn ?? -1) < 0 && (area.endColumn ?? -1) < 0;
		return !(allRows && allColumns);
	});
}

/** Каталог страницы внутри расширения. */
export function spreadsheetWebviewDir(extensionPath: string): string {
	return path.join(extensionPath, 'resources', 'webview');
}

/** HTML вкладки просмотра. */
export function renderSpreadsheetHtml(sheet: SpreadsheetDto, title: string, nonce: string, webviewDir: string): string {
	sheet = unifySheet(sheet);
	const declared = sheet.rowCount ?? 0;
	const last = (sheet.rows ?? []).reduce((max, row) => Math.max(max, (row.index ?? 0) + 1), 0);
	const rowCount = Math.min(Math.max(declared, last), MAX_ROWS);
	const truncated = Math.max(declared, last) > rowCount;
	const rows = new Map(
		(sheet.rows ?? [])
			.filter((row) => row.index !== undefined && row.index < rowCount)
			.map((row) => [row.index as number, row])
	);
	const areas = sectionAreas(sheet.areas ?? [], rowCount);
	const columnCount = Math.max(...(sheet.columnSets ?? []).map((set) => set.size ?? 0), 0);
	const stateJson = JSON.stringify({
		rowCount,
		columnCount,
		areas: areas.map((area) => ({
			name: area.name,
			kind: area.kind ?? 'rows',
			beginRow: area.beginRow ?? 0,
			endRow: area.endRow ?? 0,
			beginColumn: area.beginColumn ?? -1,
			endColumn: area.endColumn ?? -1,
		})),
	}).replace(/</g, '\\u003c');
	const chip = (area: (typeof areas)[number], index: number): string =>
		`<button type="button" class="chip" data-area="${index}">${escapeHtml(area.name ?? '')}</button>`;
	const sideAreas = areas
		.map((area, index) => ((area.kind ?? 'rows') === 'columns' ? '' : chip(area, index)))
		.join('');
	const topAreas = areas
		.map((area, index) => ((area.kind ?? 'rows') === 'columns' ? chip(area, index) : ''))
		.join('');
	const tables = rowCount > 0 ? sectionsOf(rows, rowCount).map((section) => renderSection(sheet, section, rows)).join('') : '';
	const note = truncated ? `<div class="note">Показаны первые ${rowCount} строк</div>` : '';
	const sheetHtml = `${note}${tables || '<div class="empty">В документе нет строк</div>'}`;
	const slots: Record<string, string> = {
		TITLE: escapeHtml(title),
		NONCE: nonce,
		CSS: webviewFile(webviewDir, 'spreadsheet.css'),
		JS: webviewFile(webviewDir, 'spreadsheet.js'),
		STATE_JSON: stateJson,
		SIDE_AREAS: sideAreas,
		TOP_AREAS: topAreas,
		SHEET: sheetHtml,
	};
	return webviewFile(webviewDir, 'spreadsheet.html').replace(
		/\{\{(TITLE|NONCE|CSS|JS|STATE_JSON|SIDE_AREAS|TOP_AREAS|SHEET)\}\}/g,
		(_match, key: string) => slots[key] ?? ''
	);
}

function webviewFile(dir: string, name: string): string {
	try {
		return fs.readFileSync(path.join(dir, name), 'utf8');
	} catch {
		throw new Error('Страница табличного документа не найдена.');
	}
}
