/**
 * QuickPick выбора проекта: избранное + автообнаруженные.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OneCLocator } from './oneCLocator';
import type { ProjectStorage } from './storage';
import { sortProjects } from './sorter';
import type { ProjectsStack } from './stack';
import { InvocationSource } from './constants';
import { normalizePath } from './pathUtils';
import { sameProjectRoot } from '../../shared/workspaceProjects';
import { workspaceProjectItems, type WorkspaceProjectPickItem } from './workspaceProjectPicker';
import type { WorkspaceProjectsSource } from './workspaceProjectsSource';

export interface PickedProject {
	name: string;
	rootPath: string;
}

export interface PickedResult {
	item: PickedProject;
	openInNewWindow: boolean;
	/** Проект этого окна: выбор делает его текущим. */
	inWindow?: boolean;
}

/** Проекты этого окна для списка проектов. */
export type WindowProjects = Pick<WorkspaceProjectsSource, 'snapshotNow' | 'listProjects' | 'selectedRoot' | 'selectProject'>;

/** Пункт списка проектов. */
export interface ProjectListItem extends vscode.QuickPickItem {
	path: string;
	/** Проект этого окна. */
	inWindow?: boolean;
}

/**
 * Пункты списка: проекты этого окна, затем избранное и все проекты без проектов окна.
 * @param windowItems — проекты окна из окна выбора проекта
 * @param favorites — избранное
 * @param detected — найденные проекты
 */
export function projectListItems(
	windowItems: readonly WorkspaceProjectPickItem[],
	favorites: ReadonlyArray<{ label: string; description: string }>,
	detected: ReadonlyArray<{ label: string; description: string }>
): ProjectListItem[] {
	const inWindow = windowItems.flatMap((item): ProjectListItem[] =>
		item.pick?.kind === 'project'
			? [{ label: item.label, description: item.description, iconPath: item.iconPath, path: item.pick.root, inWindow: true }]
			: []
	);
	const outsideWindow = (entry: { description: string }) => !inWindow.some((item) => sameProjectRoot(item.path, entry.description));
	return [
		...(inWindow.length > 0
			? [{ label: 'Рабочая область', kind: vscode.QuickPickItemKind.Separator, path: '' }, ...inWindow]
			: []),
		{ label: 'Избранное', kind: vscode.QuickPickItemKind.Separator, path: '' },
		...favorites.filter(outsideWindow).map((f) => ({ ...f, path: f.description })),
		{ label: 'Все проекты', kind: vscode.QuickPickItemKind.Separator, path: '' },
		...detected.filter(outsideWindow).map((d) => ({ ...d, path: d.description })),
	];
}

/**
 * Выбранное в списке: проект окна как есть, остальное после проверки пути.
 * @param item — пункт списка
 * @param openInNewWindow — нажата кнопка «Открыть в новом окне»
 * @param store — хранилище избранного
 */
export function pickedFromItem(
	item: ProjectListItem,
	openInNewWindow: boolean,
	store: ProjectStorage | undefined
): PickedResult | undefined {
	if (item.inWindow) {
		return { item: { name: item.label, rootPath: item.path }, openInNewWindow: false, inWindow: true };
	}
	if (!validatePath(item, store)) {
		return undefined;
	}
	return { item: { name: item.label, rootPath: normalizePath(item.path) }, openInNewWindow };
}

function validatePath(item: vscode.QuickPickItem, store: ProjectStorage | undefined): boolean {
	const p = typeof item.description === 'string' ? item.description : '';
	if (!p) {return false;}
	if (fs.existsSync(p)) {return true;}
	if (store) {
		void vscode.window
			.showErrorMessage('Путь проекта не существует. Что сделать?', { title: 'Обновить путь' }, { title: 'Удалить' })
			.then((ch) => {
				if (ch?.title === 'Обновить путь') {
					void vscode.commands.executeCommand('1c-platform-tools.projects.editProjects');
				} else if (ch?.title === 'Удалить' && item.label) {
					store.remove(item.label);
					store.save();
				}
			});
	}
	return false;
}

/** Нужно ли открывать в новом окне с учётом настроек. */
export function shouldOpenInNewWindow(forceNew: boolean, source: InvocationSource): boolean {
	if (!forceNew) {return false;}
	if (vscode.workspace.workspaceFolders?.length || vscode.window.activeTextEditor) {
		return true;
	}
	const cfg = vscode.workspace.getConfiguration('1c-platform-tools');
	const mode = cfg.get<string>('projects.openInCurrentWindowIfEmpty', 'always');
	if (mode === 'always') {return false;}
	if (mode === 'never') {return true;}
	if (mode === 'onlyUsingCommandPalette') {return source !== InvocationSource.Palette;}
	if (mode === 'onlyUsingSideBar') {return source !== InvocationSource.SideBar;}
	return true;
}

/** Нужно ли спрашивать подтверждение перед переключением в активном окне. */
async function needsConfirm(source: InvocationSource): Promise<boolean> {
	if (!vscode.workspace.workspaceFolders?.length || !vscode.window.activeTextEditor) {
		return false;
	}
	const cfg = vscode.workspace.getConfiguration('1c-platform-tools');
	const mode = cfg.get<string>('projects.confirmSwitchOnActiveWindow', 'never');
	if (mode === 'never') {return false;}
	if (mode === 'onlyUsingCommandPalette') {return source === InvocationSource.Palette;}
	if (mode === 'onlyUsingSideBar') {return source === InvocationSource.SideBar;}
	return mode === 'always';
}

export async function canSwitchOnActiveWindow(source: InvocationSource): Promise<boolean> {
	if (!(await needsConfirm(source))) {return true;}
	const ch = await vscode.window.showWarningMessage(
		'Открыть проект в активном окне?',
		{ modal: true },
		{ title: 'Открыть' }
	);
	return ch?.title === 'Открыть';
}

export async function pickProjects(
	store: ProjectStorage | undefined,
	locator: OneCLocator,
	showNewWindowBtn: boolean,
	source: InvocationSource,
	recent: ProjectsStack,
	context: vscode.ExtensionContext,
	windowProjects?: WindowProjects
): Promise<PickedResult | undefined> {
	const cfg = vscode.workspace.getConfiguration('1c-platform-tools');
	const hideCurrent = cfg.get<boolean>('projects.removeCurrentProjectFromList', true);
	const searchFullPath = cfg.get<boolean>('projects.filterOnFullPath', false);
	const filterTags = context.globalState.get<string[]>('1c-platform-tools.projects.filterByTags', []);

	let favorites: Array<{ label: string; description: string }> = [];
	if (store) {
		favorites = filterTags.length > 0 ? store.byTags(filterTags) : store.entries();
		favorites = sortProjects(favorites);
	}

	const [detectedPaths] = await Promise.all([locator.locateProjects(), windowProjects?.listProjects()]);
	// eslint-disable-next-line no-restricted-syntax -- из всех проектов убирается открытая папка окна
	const currentFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	let detected = detectedPaths
		.filter((p) => !hideCurrent || path.normalize(p) !== path.normalize(currentFsPath))
		.filter((p) => !favorites.some((f) => path.normalize(f.description) === path.normalize(p)))
		.map((p) => ({ label: path.basename(p) || p, description: p }));
	detected = sortProjects(detected);

	const windowItems = windowProjects
		? workspaceProjectItems(windowProjects.snapshotNow(), windowProjects.selectedRoot(), false)
		: [];
	const items = projectListItems(windowItems, favorites, detected);

	const visibleCount = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).length;
	if (visibleCount === 0) {
		void vscode.window.showInformationMessage(
			'Нет сохранённых проектов. Добавьте папки в настройку baseFolders или сохраните текущий проект.'
		);
		return undefined;
	}

	const newWindowBtn: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon('link-external'),
		tooltip: 'Открыть в новом окне',
	};

	return new Promise<PickedResult | undefined>((resolve) => {
		const picker = vscode.window.createQuickPick<ProjectListItem>();
		picker.placeholder = 'Выберите проект...';
		picker.matchOnDescription = searchFullPath;
		picker.items = items.map((it) => ({
			...it,
			buttons: showNewWindowBtn && !it.inWindow ? [newWindowBtn] : [],
		}));

		picker.onDidChangeSelection((selected) => {
			const it = selected[0];
			if (!it || it.kind === vscode.QuickPickItemKind.Separator) {return;}
			resolve(pickedFromItem(it, false, store));
			picker.hide();
		});

		picker.onDidTriggerItemButton((ev) => {
			const it = ev.item;
			if (!it || it.kind === vscode.QuickPickItemKind.Separator) {return;}
			resolve(pickedFromItem(it, true, store));
			picker.hide();
		});

		picker.onDidHide(() => {
			resolve(undefined);
			picker.dispose();
		});

		void vscode.commands.executeCommand('setContext', 'in1cProjectsList', true);
		picker.show();
	}).finally(() => {
		void vscode.commands.executeCommand('setContext', 'in1cProjectsList', false);
	});
}

/**
 * Открывает QuickPick для настройки избранного: выбор проектов флажками.
 * @returns true при успешном сохранении.
 */
export async function pickFavoritesToConfigure(
	store: ProjectStorage,
	locator: OneCLocator,
	recent: ProjectsStack
): Promise<boolean> {
	const favorites = store.entries();
	const sortedFav = sortProjects(favorites);

	const detectedPaths = await locator.locateProjects();
	const detected = detectedPaths
		.filter((p) => !sortedFav.some((f) => path.normalize(f.description) === path.normalize(p)))
		.map((p) => ({ label: path.basename(p) || p, description: p }));
	const sortedDet = sortProjects(detected);

	const favoritePaths = new Set(sortedFav.map((f) => path.normalize(f.description)));
	const pickItems: vscode.QuickPickItem[] = [
		{ label: 'Избранное', kind: vscode.QuickPickItemKind.Separator },
		...sortedFav.map((f) => ({ label: f.label, description: f.description, picked: true })),
		{ label: 'Все проекты', kind: vscode.QuickPickItemKind.Separator },
		...sortedDet.map((d) => ({ label: d.label, description: d.description, picked: false })),
	];

	const selected = await vscode.window.showQuickPick(pickItems, {
		canPickMany: true,
		placeHolder: 'Отметьте проекты для избранного',
		title: 'Настроить избранное',
		matchOnDescription: true,
	});

	if (selected === undefined) {
		return false;
	}

	const selectedItems = selected as vscode.QuickPickItem[];
	const selectedPaths = new Set(
		selectedItems.map((it) => path.normalize(typeof it.description === 'string' ? it.description : ''))
	);
	const toAdd = selectedItems.filter((it) => {
		const p = typeof it.description === 'string' ? it.description : '';
		return p && !favoritePaths.has(path.normalize(p));
	});
	const toRemove = sortedFav.filter((f) => !selectedPaths.has(path.normalize(f.description)));

	for (const it of toAdd) {
		const p = typeof it.description === 'string' ? it.description : '';
		if (p && fs.existsSync(p)) {
			store.add(typeof it.label === 'string' ? it.label : String(it.label), p);
		}
	}
	for (const f of toRemove) {
		store.remove(f.label);
	}
	if (toAdd.length > 0 || toRemove.length > 0) {
		store.save();
	}
	return toAdd.length > 0 || toRemove.length > 0;
}

export async function openPickedProject(
	picked: PickedResult | undefined,
	forceNew: boolean,
	source: InvocationSource,
	recent: ProjectsStack,
	_context: vscode.ExtensionContext,
	windowProjects?: Pick<WindowProjects, 'selectProject'>
): Promise<void> {
	if (!picked) {return;}
	if (picked.inWindow) {
		await windowProjects?.selectProject(picked.item.rootPath);
		return;
	}
	if (!picked.openInNewWindow && !forceNew) {
		if (!(await canSwitchOnActiveWindow(source))) {return;}
	}
	recent.push(picked.item.name);
	const openNew = shouldOpenInNewWindow(forceNew || picked.openInNewWindow, source);
	const uri = vscode.Uri.file(picked.item.rootPath);
	await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: openNew });
}
