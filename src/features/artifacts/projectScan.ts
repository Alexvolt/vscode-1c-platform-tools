/**
 * Каталоги проектов для поиска файлов и группы по проектам в панелях.
 *
 * @module projectScan
 */

import * as path from 'node:path';
import { sameOrUnder } from '../../shared/projectLayout';
import {
	currentRoot,
	listProjects,
	outsideProject,
	projectByRoot,
	projectDisplayName,
	projectScanRoots,
	sameProjectRoot,
	type ProjectScanRoot,
} from '../../shared/workspaceProjects';

/** Описание группы выбранного проекта. */
export const CURRENT_PROJECT_DESCRIPTION = 'текущий';

/** Каталоги проектов после полного обнаружения. */
export async function detectedScanRoots(): Promise<ProjectScanRoot[]> {
	await listProjects();
	return projectScanRoots();
}

/**
 * Не относится ли файл к проекту: лежит вне его корня, в подпроекте, во вложенной
 * папке рабочей области или под исключённым сегментом пути внутри проекта.
 *
 * @param scanRoot - Проект и каталоги, которые ему не принадлежат
 * @param file - Абсолютный путь
 * @param segments - Исключённые сегменты; сравниваются только ниже корня проекта
 */
export function isOutsideScanRoot(scanRoot: ProjectScanRoot, file: string, segments: readonly string[]): boolean {
	if (!sameOrUnder(file, scanRoot.root) || scanRoot.excludeDirs.some((dir) => sameOrUnder(file, dir))) {
		return true;
	}
	const relative = `/${projectRelativePath(scanRoot.root, file)}/`;
	return segments.some((segment) => segment.length > 0 && relative.includes(`/${segment}/`));
}

/**
 * Путь от корня проекта через `/`.
 *
 * @param root - Корень проекта
 * @param file - Абсолютный путь внутри проекта
 * @returns `.` для самого корня
 */
export function projectRelativePath(root: string, file: string): string {
	const relative = path.relative(root, file);
	return relative === '' ? '.' : relative.split(/[\\/]/).join('/');
}

/** Корень выбранного проекта без корня вызова. */
export function selectedRoot(): string | undefined {
	return outsideProject(() => currentRoot());
}

/** Корень выбранного проекта. */
export function isSelectedRoot(root: string): boolean {
	const selected = selectedRoot();
	return selected !== undefined && sameProjectRoot(root, selected);
}

/**
 * Элементы в прежнем порядке, элемент выбранного проекта первым.
 *
 * @param items - Элементы по проектам
 * @param rootOf - Корень проекта элемента
 */
export function selectedFirst<T>(items: readonly T[], rootOf: (item: T) => string): T[] {
	const selected = selectedRoot();
	const index = selected === undefined ? -1 : items.findIndex((item) => sameProjectRoot(rootOf(item), selected));
	return index <= 0 ? [...items] : [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}

/** Подпись группы проекта. */
export function projectLabel(root: string): string {
	const project = projectByRoot(root);
	return project ? projectDisplayName(project) : path.basename(root);
}

/**
 * Совпадает ли набор просканированных корней с каталогами проектов.
 *
 * @param scanned - Корни последнего скана
 * @param roots - Каталоги проектов сейчас
 */
export function sameScanRoots(scanned: readonly string[], roots: readonly ProjectScanRoot[]): boolean {
	return scanned.length === roots.length && scanned.every((root, index) => sameProjectRoot(root, roots[index].root));
}
