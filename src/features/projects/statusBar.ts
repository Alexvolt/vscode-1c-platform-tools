/**
 * Status Bar — текущий проект.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	currentRoot,
	outsideProject,
	projectByRoot,
	projectDisplayName,
	type WorkspaceProject,
} from '../../shared/workspaceProjects';
import type { ProjectStorage } from './storage';
import type { OneCLocator } from './oneCLocator';
import { setCurrentProjectPath } from './decoration';

let statusItem: vscode.StatusBarItem | undefined;

/**
 * Текст и подсказка статусной строки с текущим проектом окна: имя из избранного с тем же
 * корнем, иначе имя проекта.
 * @param project — текущий проект
 * @param favorites — избранное
 * @param all — проекты окна
 */
export function currentProjectStatus(
	project: WorkspaceProject,
	favorites: Pick<ProjectStorage, 'existsWithRootPath'>,
	all?: readonly WorkspaceProject[]
): { text: string; tooltip: string } {
	const name = favorites.existsWithRootPath(project.root, true)?.name ?? projectDisplayName(project, all);
	return { text: `$(folder) ${name}`, tooltip: project.root };
}

/**
 * Показывает текущий проект в статусной строке и обновляет подсветку в сайдбаре.
 * В окне без проекта 1С показывает открытую папку.
 * @param storage — хранилище избранного
 * @param locator — локатор автообнаруженных проектов
 * @param projectName — имя проекта (если известно)
 */
export function showStatusBar(
	storage: ProjectStorage,
	locator: OneCLocator,
	projectName?: string
): void {
	const root = outsideProject(currentRoot);
	const project = root === undefined ? undefined : projectByRoot(root);
	// eslint-disable-next-line no-restricted-syntax -- окно без проекта 1С: строка показывает открытую папку
	const ws = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
	const currentPath = project?.root ?? ws?.fsPath;
	setCurrentProjectPath(root ?? currentPath);

	const config = vscode.workspace.getConfiguration('1c-platform-tools');
	const show = config.get<boolean>('projects.showProjectNameInStatusBar', true);
	if (!show || !currentPath) {
		statusItem?.hide();
		return;
	}

	if (!statusItem) {
		statusItem = vscode.window.createStatusBarItem('1c-platform-tools.projects.statusBar', vscode.StatusBarAlignment.Left);
		statusItem.name = '1С: Проекты';
	}

	const openInNew = config.get<boolean>('projects.openInNewWindowWhenClickingInStatusBar', false);
	statusItem.command = openInNew ? '1c-platform-tools.projects.listNewWindow' : '1c-platform-tools.projects.listOpen';

	if (project) {
		const status = currentProjectStatus(project, storage);
		statusItem.text = status.text;
		statusItem.tooltip = status.tooltip;
		statusItem.show();
		return;
	}

	statusItem.tooltip = currentPath;

	if (projectName) {
		statusItem.text = `$(folder) ${projectName}`;
		statusItem.show();
		return;
	}

	const fromStorage = storage.existsWithRootPath(currentPath, true);
	if (fromStorage) {
		statusItem.text = `$(folder) ${fromStorage.name}`;
		statusItem.show();
		return;
	}

	const norm = currentPath.toLowerCase();
	const fromLocator = locator.projectList.find((p) => p.toLowerCase() === norm);
	if (fromLocator) {
		statusItem.text = `$(folder) ${path.basename(fromLocator) || fromLocator}`;
		statusItem.show();
		return;
	}

	statusItem.text = `$(folder) ${path.basename(currentPath) || currentPath}`;
	statusItem.show();
}
