/**
 * Сканирование проектов на комментарии-метки (например TODO, FIXME, XXX, HACK, BUG).
 * Используется панелью «1С: Список дел» (todoPanelView).
 * @module todoScanner
 */

import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { projectConfiguration } from '../../shared/projectConfiguration';
import type { ProjectScanRoot } from '../../shared/workspaceProjects';
import {
	detectedScanRoots,
	findProjectFiles,
	isOutsideScanRoot,
	matchesProjectGlob,
	searchExcludeGlob,
} from '../artifacts/projectScan';

const log = logger.scope('todo');

/** Одна найденная метка в коде (тег, строка, URI, текст). */
export interface TodoEntry {
	uri: vscode.Uri;
	line: number;
	tag: string;
	message: string;
	/** Содержимое строки в файле. */
	lineContent: string;
	/** Корень проекта, которому принадлежит файл. */
	root: string;
}

/** Результат {@link scanWorkspaceForTodos}. */
export interface TodoScanResult {
	/** Корни просканированных проектов по порядку проектов. */
	roots: string[];
	/** Записи, отсортированные по пути и номеру строки. */
	entries: TodoEntry[];
}

const DEFAULT_TAGS = ['TODO', 'FIXME', 'XXX', 'HACK', 'BUG'];
const DEFAULT_INCLUDE = ['**/*.bsl', '**/*.os', '**/*.md', '**/*.feature'];
const DEFAULT_EXCLUDE = ['oscript_modules', 'out', '.git', 'vendor', 'build'];

function buildTagRegex(tags: string[]): RegExp {
	const escaped = tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return new RegExp(String.raw`\b(${escaped})\b\s*:?\s*(.*)`, 'i');
}

/**
 * Проверяет, что вхождение тега допустимо для типа файла:
 * .md — любой текст; .feature — только строки-комментарии (#); остальные — после // или <!--.
 */
function isCommentLine(uri: vscode.Uri, line: string, tagMatchIndex: number): boolean {
	const ext = (uri.fsPath.split('.').pop() ?? '').toLowerCase();
	if (ext === 'md') {return true;}
	if (ext === 'feature') {
		if (!line.trimStart().startsWith('#')) {return false;}
		const before = line.slice(0, tagMatchIndex).trim();
		return before === '' || before === '#' || before.startsWith('# ');
	}
	const before = line.slice(0, tagMatchIndex).trim();
	return before.endsWith('//') || before.startsWith('//') || before.includes('<!--');
}

function scanFile(uri: vscode.Uri, content: string, regex: RegExp, root: string): TodoEntry[] {
	const entries: TodoEntry[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = regex.exec(line);
		if (match && isCommentLine(uri, line, line.indexOf(match[1]))) {
			entries.push({
				uri,
				line: i + 1,
				tag: match[1].toUpperCase(),
				message: (match[2] ?? '').trim(),
				lineContent: line.trimEnd(),
				root,
			});
		}
	}
	return entries;
}

async function filesOf(scanRoot: ProjectScanRoot, includePatterns: string[], excludeSegments: string[]): Promise<vscode.Uri[]> {
	// Объединяем расширения в один glob при возможности; без лимита на число файлов
	const extFromPattern = (p: string): string | null => {
		const m = p.match(/^\*\*\/\*\.(\w+)$/);
		return m ? m[1].toLowerCase() : null;
	};
	const exts = includePatterns.map(extFromPattern).filter((e): e is string => e !== null);
	const globs = exts.length === includePatterns.length && exts.length > 0
		? [`**/*.{${exts.join(',')}}`]
		: includePatterns;
	const found = new Map<string, vscode.Uri>();
	for (const glob of globs) {
		for (const uri of await findProjectFiles(scanRoot, glob, excludeSegments)) {
			found.set(uri.fsPath, uri);
		}
	}
	return [...found.values()];
}

/**
 * Теги списка дел из настроек проектов без повторов.
 *
 * @param roots - Корни проектов; без проектов читаются настройки окна
 */
export function configuredTodoTags(roots: readonly string[]): string[] {
	const sources = roots.length > 0 ? roots : [undefined];
	const tags = sources.flatMap((root) => projectConfiguration(root).get<string[]>('todo.tags') ?? DEFAULT_TAGS);
	return [...new Set(tags)];
}

/** Настройки todo.include, todo.exclude и todo.tags проекта. */
function todoSettings(root: string): { includePatterns: string[]; excludeSegments: string[]; regex: RegExp } {
	const config = projectConfiguration(root);
	return {
		includePatterns: config.get<string[]>('todo.include') ?? DEFAULT_INCLUDE,
		excludeSegments: config.get<string[]>('todo.exclude') ?? DEFAULT_EXCLUDE,
		regex: buildTagRegex(config.get<string[]>('todo.tags') ?? DEFAULT_TAGS),
	};
}

/** Порядок записей: по пути, затем по номеру строки. */
export function compareTodoEntries(a: TodoEntry, b: TodoEntry): number {
	const pathCompare = a.uri.fsPath.localeCompare(b.uri.fsPath);
	return pathCompare === 0 ? a.line - b.line : pathCompare;
}

/** Файл под масками todo.include проекта. */
function isIncluded(root: string, includePatterns: readonly string[], uri: vscode.Uri): boolean {
	return includePatterns.some((glob) => matchesProjectGlob(root, glob, uri));
}

/** Комментарии-метки файла на диске; непрочитанный файл без меток. */
async function readTodos(uri: vscode.Uri, regex: RegExp, root: string): Promise<TodoEntry[]> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return scanFile(uri, new TextDecoder('utf-8', { fatal: false }).decode(bytes), regex, root);
	} catch (err) {
		log.debug(`Не удалось прочитать файл ${uri.fsPath}: ${String(err)}`);
		return [];
	}
}

/**
 * Комментарии-метки одного документа по настройкам его проекта.
 *
 * @param scanRoot - Проект документа
 * @param document - Документ
 * @returns undefined, если документ проект не сканирует
 */
export function scanTodoDocument(scanRoot: ProjectScanRoot, document: vscode.TextDocument): TodoEntry[] | undefined {
	const { includePatterns, excludeSegments, regex } = todoSettings(scanRoot.root);
	if (isOutsideScanRoot(scanRoot, document.uri.fsPath, excludeSegments)) {
		return undefined;
	}
	return isIncluded(scanRoot.root, includePatterns, document.uri)
		? scanFile(document.uri, document.getText(), regex, scanRoot.root)
		: undefined;
}

/** Путь на диске, дела под которым читаются заново. */
export interface TodoPathChange {
	uri: vscode.Uri;
	/** Путь может быть каталогом: тогда читаются все файлы под ним. */
	tree: boolean;
}

/**
 * Комментарии-метки файлов по путям на диске, которые проект сканирует.
 *
 * @param scanRoot - Проект путей
 * @param changes - Пути; отсутствующие на диске пропускаются
 */
export async function scanTodoPaths(scanRoot: ProjectScanRoot, changes: readonly TodoPathChange[]): Promise<TodoEntry[]> {
	const { includePatterns, excludeSegments, regex } = todoSettings(scanRoot.root);
	const entries: TodoEntry[] = [];
	for (const { uri, tree } of changes) {
		if (isOutsideScanRoot(scanRoot, uri.fsPath, excludeSegments)) {
			continue;
		}
		const included = isIncluded(scanRoot.root, includePatterns, uri);
		if (!included && !tree) {
			continue;
		}
		const stat = await fs.stat(uri.fsPath).catch(() => undefined);
		if (included && stat?.isFile()) {
			entries.push(...(await readTodos(uri, regex, scanRoot.root)));
		} else if (tree && stat?.isDirectory()) {
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(uri, '**/*'),
				searchExcludeGlob(uri.fsPath, scanRoot, excludeSegments)
			);
			for (const file of files) {
				if (!isOutsideScanRoot(scanRoot, file.fsPath, excludeSegments) && isIncluded(scanRoot.root, includePatterns, file)) {
					entries.push(...(await readTodos(file, regex, scanRoot.root)));
				}
			}
		}
	}
	return entries;
}

/**
 * Комментарии-метки одного проекта по его настройкам todo.include, todo.exclude и todo.tags.
 *
 * @param scanRoot - Проект и каталоги, которые ему не принадлежат
 */
export async function scanProjectTodos(scanRoot: ProjectScanRoot): Promise<TodoEntry[]> {
	const { includePatterns, excludeSegments, regex } = todoSettings(scanRoot.root);

	const entries: TodoEntry[] = [];
	for (const uri of await filesOf(scanRoot, includePatterns, excludeSegments)) {
		entries.push(...(await readTodos(uri, regex, scanRoot.root)));
	}
	return entries;
}

/**
 * Сканирует проекты окна на комментарии-метки.
 *
 * @param roots - Проекты для обхода; по умолчанию все проекты после обнаружения
 */
export async function scanWorkspaceForTodos(roots?: readonly ProjectScanRoot[]): Promise<TodoScanResult> {
	const scanRoots = roots ?? (await detectedScanRoots());
	const entries: TodoEntry[] = [];
	for (const scanRoot of scanRoots) {
		entries.push(...(await scanProjectTodos(scanRoot)));
	}
	entries.sort(compareTodoEntries);
	return { roots: scanRoots.map((scanRoot) => scanRoot.root), entries };
}
