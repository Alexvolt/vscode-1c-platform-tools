/**
 * Панель «1С: Список дел» в нижней части окна.
 * TreeDataProvider с группировкой по проекту и файлу, фильтрами по тегу и области.
 * @module todoPanelView
 */

import * as vscode from 'vscode';
import { projectScanRoots, type ProjectScanRoot } from '../../shared/workspaceProjects';
import {
	CURRENT_PROJECT_DESCRIPTION,
	isSelectedRoot,
	projectLabel,
	projectRelativePath,
	sameScanRoots,
	selectedFirst,
} from '../artifacts/projectScan';
import { scanWorkspaceForTodos, type TodoEntry, type TodoScanResult } from './todoScanner';

const STATE_KEYS = {
	groupByFile: '1c-platform-tools.todo.groupByHierarchy',
	filterTags: '1c-platform-tools.todo.filterTags',
	filterScope: '1c-platform-tools.todo.filterScope',
} as const;

/** Область фильтра: весь проект, текущий файл или по расширению. */
export type FilterScope = 'all' | 'currentFile' | 'md' | 'bsl' | 'os' | 'feature';

/** Максимальная длина текста строки в колонке (обрезается с «…»). */
const MAX_LINE_PREVIEW_LEN = 80;

/** Расширение файла по значению области (кроме all и currentFile). */
const SCOPE_EXTENSION: Record<Exclude<FilterScope, 'all' | 'currentFile'>, string> = {
	md: '.md',
	bsl: '.bsl',
	os: '.os',
	feature: '.feature',
};

const TAG_ICON_COLORS: Record<string, string> = {
	FIXME: 'editorError.foreground',
	BUG: 'editorError.foreground',
	XXX: 'editorWarning.foreground',
	HACK: 'editorWarning.foreground',
};

const MESSAGE_LOADING = 'Идёт поиск';
const MESSAGE_EMPTY = 'Нет дел';
const MESSAGE_EMPTY_FILTERED = 'Нет дел под текущими отборами';
const MESSAGE_NO_WORKSPACE = 'Откройте папку проекта';

function getIconForTag(tag: string): vscode.ThemeIcon {
	const colorId = TAG_ICON_COLORS[tag] ?? 'editorInfo.foreground';
	return new vscode.ThemeIcon('primitive-dot', new vscode.ThemeColor(colorId));
}

/** Склонение «пункт» для числа (1 пункт, 2 пункта, 5 пунктов). */
function pluralPoints(count: number): string {
	if (count === 1) {
		return 'пункт';
	}
	if (count >= 2 && count <= 4) {
		return 'пункта';
	}
	return 'пунктов';
}

/**
 * Узел дерева списка дел: корень, группа по проекту, группа по файлу или элемент (одна запись).
 */
export type TodoNode =
	| { kind: 'root' }
	| { kind: 'project'; root: string; entries: TodoEntry[] }
	| { kind: 'file'; path: string; entries: TodoEntry[] }
	| { kind: 'entry'; entry: TodoEntry; tableMode?: boolean };

/** Проверяет, что узел — элемент списка (одна запись дела). */
export function isTodoEntryNode(node: TodoNode | undefined): node is { kind: 'entry'; entry: TodoEntry } {
	return node?.kind === 'entry';
}

/**
 * Провайдер дерева панели «1С: Список дел».
 * Хранит кэш отсканированных записей, применяет фильтры по тегам и области, строит узлы с группировкой по файлу или плоский список.
 */
export class TodoPanelTreeDataProvider implements vscode.TreeDataProvider<TodoNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TodoNode | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<TodoNode | undefined | null | void> =
		this._onDidChangeTreeData.event;

	private _entries: TodoEntry[] = [];
	/** Корни проектов последнего скана. */
	private _roots: string[] = [];
	private _didInitialLoad = false;
	private _isScanning = false;
	private _lastFilteredCount = 0;
	private _treeView: vscode.TreeView<TodoNode> | undefined;
	private _refreshPromise: Promise<void> | null = null;
	private _rescanRequested = false;

	/**
	 * @param _context - Контекст расширения: отборы и группировка в globalState
	 * @param _scan - Скан проектов окна
	 * @param _scanRoots - Каталоги проектов окна сейчас
	 */
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _scan: () => Promise<TodoScanResult> = () => scanWorkspaceForTodos(),
		private readonly _scanRoots: () => ProjectScanRoot[] = projectScanRoots
	) {}

	setTreeView(treeView: vscode.TreeView<TodoNode>): void {
		this._treeView = treeView;
		this._updateViewTitle();
	}

	getLastFilteredCount(): number {
		return this._lastFilteredCount;
	}

	private _updateViewTitle(): void {
		if (this._treeView) {
			this._treeView.title = 'Список дел';
		}
	}

	/**
	 * Сообщение вместо пустого дерева и счётчик на значке панели.
	 *
	 * @param message - Текст под заголовком; пусто, когда список не пуст
	 * @param count - Число пунктов после отборов
	 */
	private _setViewState(message: string | undefined, count: number): void {
		if (!this._treeView) {
			return;
		}
		this._treeView.message = message;
		this._treeView.badge = count > 0
			? { value: count, tooltip: `${count} ${pluralPoints(count)}` }
			: undefined;
	}

	private _hasActiveFilters(): boolean {
		const tags = this._context.globalState.get<string[]>(STATE_KEYS.filterTags);
		const scope = this._context.globalState.get<FilterScope>(STATE_KEYS.filterScope);
		return (tags?.length ?? 0) > 0 || (scope !== undefined && scope !== 'all');
	}

	/** Список проектов изменился: пересканировать, если панель уже загружалась. */
	projectsChanged(): void {
		if (this._didInitialLoad) {
			void this.refresh();
		}
	}

	/**
	 * Выбранный проект сменился: тот же набор проектов перерисовывается в новом
	 * порядке, другой сканируется заново.
	 */
	currentProjectChanged(): void {
		if (!this._didInitialLoad) {
			return;
		}
		if (sameScanRoots(this._roots, this._scanRoots())) {
			this._fireChange();
			return;
		}
		void this.refresh();
	}

	/**
	 * Пересканировать проекты и обновить дерево.
	 * Вызов во время сканирования не запускает второе, а повторяет скан после текущего.
	 * Найденное показывается, если за время скана не сменился список проектов.
	 */
	refresh(): Promise<void> {
		this._rescanRequested = true;
		this._refreshPromise ??= this._doRefresh();
		return this._refreshPromise;
	}

	private async _doRefresh(): Promise<void> {
		this._isScanning = true;
		if (this._entries.length === 0) {
			this._fireChange();
		}
		try {
			while (this._rescanRequested) {
				this._rescanRequested = false;
				const result = await this._scan();
				if (this._rescanRequested && !sameScanRoots(result.roots, this._scanRoots())) {
					continue;
				}
				this._entries = result.entries;
				this._roots = result.roots;
				this._didInitialLoad = true;
				this._lastFilteredCount = this._filterEntries().length;
				this._updateViewTitle();
				// Значок обновляется и когда панель скрыта: getChildren тогда не зовут
				this._setViewState(
					this._lastFilteredCount > 0 ? undefined : this._emptyMessage(),
					this._lastFilteredCount
				);
			}
		} finally {
			this._isScanning = false;
			this._refreshPromise = null;
		}
		this._fireChange();
	}

	getChildren(node?: TodoNode): TodoNode[] {
		if (!node || node.kind === 'root') {
			return this._getRootChildren();
		}
		if (node.kind === 'project') {
			return this._buildNodesFromEntries(node.entries);
		}
		if (node.kind === 'file') {
			return node.entries.map((e) => ({ kind: 'entry' as const, entry: e, tableMode: false }));
		}
		return [];
	}

	private _emptyMessage(): string {
		if (this._roots.length === 0) {
			return MESSAGE_NO_WORKSPACE;
		}
		return this._hasActiveFilters() ? MESSAGE_EMPTY_FILTERED : MESSAGE_EMPTY;
	}

	private _getRootChildren(): TodoNode[] {
		this._updateViewTitle();

		if (!this._didInitialLoad) {
			this._didInitialLoad = true;
			void this.refresh();
			this._setViewState(MESSAGE_LOADING, 0);
			return [];
		}

		if (this._isScanning && this._entries.length === 0) {
			this._setViewState(MESSAGE_LOADING, 0);
			return [];
		}

		const filtered = this._filterEntries();
		if (this._entries.length === 0 || filtered.length === 0) {
			this._lastFilteredCount = 0;
			this._setViewState(this._emptyMessage(), 0);
			return [];
		}

		this._lastFilteredCount = filtered.length;
		this._setViewState(undefined, filtered.length);
		return this._roots.length > 1
			? this._buildProjectNodes(filtered)
			: this._buildNodesFromEntries(filtered);
	}

	/** Группы проектов с делами, выбранный проект первым. */
	private _buildProjectNodes(entries: TodoEntry[]): TodoNode[] {
		const byRoot = new Map<string, TodoEntry[]>();
		for (const entry of entries) {
			const list = byRoot.get(entry.root) ?? [];
			list.push(entry);
			byRoot.set(entry.root, list);
		}
		return selectedFirst(this._roots, (root) => root)
			.filter((root) => byRoot.has(root))
			.map((root) => ({ kind: 'project' as const, root, entries: byRoot.get(root) ?? [] }));
	}

	private _buildNodesFromEntries(entries: TodoEntry[]): TodoNode[] {
		const groupBy = this._context.globalState.get<boolean>(STATE_KEYS.groupByFile) ?? true;
		if (!groupBy) {
			return entries.map((entry) => ({ kind: 'entry' as const, entry, tableMode: true }));
		}
		const byPath = new Map<string, TodoEntry[]>();
		for (const e of entries) {
			const p = this._relPath(e);
			if (!byPath.has(p)) {byPath.set(p, []);}
			byPath.get(p)!.push(e);
		}
		return Array.from(byPath.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([filePath, fileEntries]) => ({ kind: 'file' as const, path: filePath, entries: fileEntries }));
	}

	private _filterEntries(): TodoEntry[] {
		let list = this._entries;
		const filterTags = this._context.globalState.get<string[]>(STATE_KEYS.filterTags);
		if (filterTags?.length) {
			const set = new Set(filterTags.map((t) => t.toUpperCase()));
			list = list.filter((e) => set.has(e.tag));
		}
		const scope = this._context.globalState.get<FilterScope>(STATE_KEYS.filterScope) ?? 'all';
		if (scope === 'all') {return list;}
		if (scope === 'currentFile') {
			const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
			return activeUri ? list.filter((e) => e.uri.toString() === activeUri) : [];
		}
		const ext = SCOPE_EXTENSION[scope] ?? '';
		return list.filter((e) => e.uri.fsPath.toLowerCase().endsWith(ext));
	}

	private _fireChange(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	private _relPath(entry: TodoEntry): string {
		return projectRelativePath(entry.root, entry.uri.fsPath);
	}

	private _fileLabel(filePath: string): { fileName: string; dirPath: string } {
		const sep = filePath.includes('/') ? '/' : '\\';
		const parts = filePath.split(sep);
		const fileName = parts.at(-1) ?? filePath;
		const lastSep = filePath.lastIndexOf(sep);
		const dirPath = lastSep <= 0 ? '' : filePath.slice(0, lastSep);
		return { fileName, dirPath };
	}

	getTreeItem(node: TodoNode): vscode.TreeItem {
		if (node.kind === 'root') {return new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);}
		if (node.kind === 'project') {
			const count = node.entries.length;
			const item = new vscode.TreeItem(projectLabel(node.root), vscode.TreeItemCollapsibleState.Expanded);
			item.contextValue = 'todoProject';
			item.description = isSelectedRoot(node.root) ? CURRENT_PROJECT_DESCRIPTION : undefined;
			item.iconPath = new vscode.ThemeIcon('repo');
			item.tooltip = `${node.root}: ${count} ${pluralPoints(count)}`;
			return item;
		}
		if (node.kind === 'file') {
			const count = node.entries.length;
			const { fileName, dirPath } = this._fileLabel(node.path);
			const label = dirPath ? `${fileName} ${dirPath}` : fileName;
			const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
			item.contextValue = 'todoFile';
			item.description = String(count);
			item.iconPath = new vscode.ThemeIcon('symbol-file');
			item.tooltip = `${node.path}: ${count} ${pluralPoints(count)}`;
			return item;
		}
		const e = node.entry;
		const pathStr = this._relPath(e);
		const lineContent = (e.lineContent ?? e.message ?? '').trimStart();
		const msgCol = lineContent.length > MAX_LINE_PREVIEW_LEN
			? `${lineContent.slice(0, MAX_LINE_PREVIEW_LEN)}…`
			: lineContent;
		const locationStr = `стр. ${e.line}`;
		const isTable = node.tableMode === true;
		const item = new vscode.TreeItem(msgCol, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'todoEntry';
		item.description = isTable ? `${pathStr}  ${locationStr}` : locationStr;
		item.iconPath = getIconForTag(e.tag);
		item.tooltip = `${pathStr}, строка ${e.line}`;
		item.command = {
			command: '1c-platform-tools.todo.openLocation',
			title: 'Перейти',
			arguments: [e.uri.toString(), e.line],
		};
		return item;
	}

	getGroupByFile(): boolean {
		return this._context.globalState.get<boolean>(STATE_KEYS.groupByFile) ?? true;
	}

	async setGroupByFile(value: boolean): Promise<void> {
		await this._context.globalState.update(STATE_KEYS.groupByFile, value);
		this._fireChange();
	}

	getFilterTags(): string[] | undefined {
		return this._context.globalState.get<string[]>(STATE_KEYS.filterTags);
	}

	async setFilterTags(tags: string[] | null): Promise<void> {
		await this._context.globalState.update(STATE_KEYS.filterTags, tags?.length ? tags : undefined);
		this._fireChange();
	}

	getFilterScope(): FilterScope {
		return this._context.globalState.get<FilterScope>(STATE_KEYS.filterScope) ?? 'all';
	}

	async setFilterScope(scope: FilterScope): Promise<void> {
		await this._context.globalState.update(STATE_KEYS.filterScope, scope === 'all' ? undefined : scope);
		this._fireChange();
	}

	async clearAllFilters(): Promise<void> {
		await this._context.globalState.update(STATE_KEYS.filterTags, undefined);
		await this._context.globalState.update(STATE_KEYS.filterScope, undefined);
		this._fireChange();
	}

	refreshView(): void {
		this._fireChange();
	}
}
