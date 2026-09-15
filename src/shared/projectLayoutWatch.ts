/**
 * Слежение за тем, из чего собрана раскладка проекта.
 *
 * Раскладка кэшируется на корень, поэтому её нужно забывать, когда появляется или
 * исчезает маркерный файл, удаляется каталог с найденным исходным кодом, меняются
 * пути в настройках или состав папок рабочей области. Наблюдатели смотрят во все
 * папки рабочей области и забывают только затронутые раскладки. Появление и
 * удаление `packagedef` отслеживает модуль проектов.
 * @module projectLayoutWatch
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_PATHS, DEFAULT_TESTING } from './pathDefaults';
import {
	directoryKey,
	invalidateProjectLayout,
	invalidateProjectLayoutsForFile,
	invalidateProjectLayoutsForRemoval,
	setLayoutExclusions,
	setTestsDirectory,
} from './projectLayout';

/** Описания конфигураций, расширений и внешних объектов обоих форматов и проекты EDT. */
const MARKERS = '**/{*.xml,*.mdo,.project}';

/** Файлы, от которых зависит, где лежат конфигурации. */
const CONFIGURATION_FILES = new Set(['Configuration.xml', 'Configuration.mdo', '.project']);

/** Настройки, от которых зависит раскладка: каталог сборки, исключения артефактов и каталог тестов. */
const SETTINGS = [
	'1c-platform-tools.path.out',
	'1c-platform-tools.artifacts.exclude',
	'1c-platform-tools.test.directoryName',
];

/** Разборка кладёт тысячи файлов подряд: сброс один на всю пачку. */
const DEBOUNCE_MS = 300;

/** Изменение раскладки. */
export interface ProjectLayoutChange {
	/** Могли измениться конфигурации, подпроекты или исключения обхода: проекты ищутся заново. */
	projects: boolean;
}

const changed = new vscode.EventEmitter<ProjectLayoutChange>();

/** Раскладка какого-то корня забыта; изменения в паузе сливаются в одно событие. */
export const onDidChangeProjectLayout: vscode.Event<ProjectLayoutChange> = changed.event;

let timer: NodeJS.Timeout | undefined;
let pending: ProjectLayoutChange | undefined;

/**
 * Сообщает, что раскладка изменилась.
 *
 * @param change - Что изменилось; признаки в паузе объединяются
 */
export function notifyProjectLayoutChanged(change: ProjectLayoutChange): void {
	pending = { projects: (pending?.projects ?? false) || change.projects };
	if (timer) {
		clearTimeout(timer);
	}
	timer = setTimeout(() => {
		timer = undefined;
		const next = pending ?? { projects: false };
		pending = undefined;
		changed.fire(next);
	}, DEBOUNCE_MS);
}

/** Может ли появление или удаление файла сменить состав конфигураций. */
export function changesConfigurations(file: string): boolean {
	return CONFIGURATION_FILES.has(path.basename(file));
}

/** Настройки обхода одного корня. */
interface LayoutSettings {
	/** Каталоги, которые обход пропускает: каталог сборки и исключения артефактов. */
	exclusions: string[];
	testsDirectory: string;
}

/** Настройки обхода по ключу корня; сбрасываются при смене настроек обхода и папок. */
const settingsCache = new Map<string, LayoutSettings>();

function layoutSettings(root?: string): LayoutSettings {
	const key = root === undefined ? '' : directoryKey(root);
	const cached = settingsCache.get(key);
	if (cached) {
		return cached;
	}
	const config = vscode.workspace.getConfiguration('1c-platform-tools', root === undefined ? undefined : vscode.Uri.file(root));
	const out = config.get<string>('path.out', DEFAULT_PATHS.out).replace(/\\/g, '/').replace(/^\.?\//, '');
	const build = out.split('/')[0];
	const excluded = config.get<string[]>('artifacts.exclude', []).map((item) => item.replace(/\\/g, '/').replace(/^\.?\/|\/$/g, ''));
	const settings: LayoutSettings = {
		exclusions: [...new Set([build, ...excluded].filter((item) => item.length > 0 && !item.includes('/')))],
		testsDirectory: config.get<string>('test.directoryName', DEFAULT_TESTING.directoryName),
	};
	settingsCache.set(key, settings);
	return settings;
}

export function registerProjectLayoutWatch(context: vscode.ExtensionContext): void {
	settingsCache.clear();
	setLayoutExclusions((root) => layoutSettings(root).exclusions);
	setTestsDirectory((root) => layoutSettings(root).testsDirectory);
	const onMarker = (uri: vscode.Uri) => {
		if (invalidateProjectLayoutsForFile(uri.fsPath)) {
			notifyProjectLayoutChanged({ projects: changesConfigurations(uri.fsPath) });
		}
	};
	const onDeleted = (uri: vscode.Uri) => {
		const { forgotten, projects } = invalidateProjectLayoutsForRemoval(uri.fsPath);
		if (forgotten) {
			notifyProjectLayoutChanged({ projects });
		}
	};
	const forgetAll = (projects: boolean) => {
		settingsCache.clear();
		invalidateProjectLayout();
		notifyProjectLayoutChanged({ projects });
	};
	const markers = vscode.workspace.createFileSystemWatcher(MARKERS, false, true, false);
	const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);

	context.subscriptions.push(
		markers,
		deletions,
		markers.onDidCreate(onMarker),
		markers.onDidDelete(onMarker),
		deletions.onDidDelete(onDeleted),
		// Состав проектов при смене папок пересчитывает модуль проектов
		vscode.workspace.onDidChangeWorkspaceFolders(() => forgetAll(false)),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
				forgetAll(true);
			}
		}),
		new vscode.Disposable(() => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		})
	);
}
