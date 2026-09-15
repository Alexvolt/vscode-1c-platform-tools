import * as vscode from 'vscode';
import { DependenciesCommands } from '../commands/dependenciesCommands';
import { openGetStartedWalkthrough } from '../features/tools/getStartedView';
import {
	currentRoot,
	hasProjects,
	IS_1C_PROJECT_CONTEXT,
	onDidChangeCurrentProject,
	onDidChangeProjects,
	sameProjectRoot,
} from '../shared/workspaceProjects';

function sameRoot(left: string | undefined, right: string | undefined): boolean {
	return left === undefined || right === undefined ? left === right : sameProjectRoot(left, right);
}

export interface RefreshableProvider {
	refresh(): void;
}

export interface RegisterProjectCreatedHandlerParams {
	treeDataProvider: RefreshableProvider;
	artifactsProvider: RefreshableProvider;
	metadataTreeProvider: RefreshableProvider;
	/** Пересобрать дерево панели тестирования (проект создан → появились каталоги тестов) */
	rebuildTesting?: () => void;
}

/**
 * Определяет стартовый статус проекта и обновляет контекст `1c-platform-tools.is1CProject`.
 *
 * @returns Промис, который разрешается в `true`, если в окне есть проект 1С.
 */
export async function detectAndSetInitialProjectContext(): Promise<boolean> {
	const isProject = hasProjects();
	await vscode.commands.executeCommand('setContext', IS_1C_PROJECT_CONTEXT, isProject);
	return isProject;
}

/**
 * Перечитывает панели, когда в окне появился первый проект или пропал последний.
 *
 * Если в том же обнаружении сменился текущий проект, панели обновляются сами по
 * смене проекта.
 *
 * @returns Подписка на проекты
 */
export function registerProjectCreatedHandler(
	params: RegisterProjectCreatedHandlerParams
): vscode.Disposable {
	const { treeDataProvider, artifactsProvider, metadataTreeProvider, rebuildTesting } = params;
	let hadProjects = hasProjects();
	let knownRoot = currentRoot();

	return vscode.Disposable.from(
		onDidChangeCurrentProject((change) => {
			knownRoot = change.current;
		}),
		onDidChangeProjects(() => {
			const has = hasProjects();
			if (has === hadProjects) {
				return;
			}
			hadProjects = has;
			if (!sameRoot(currentRoot(), knownRoot)) {
				return;
			}
			treeDataProvider.refresh();
			artifactsProvider.refresh();
			metadataTreeProvider.refresh();
			rebuildTesting?.();
		})
	);
}

/**
 * Выполняет post-open сценарии для workspace после активации.
 *
 * - отложенная установка зависимостей после создания проекта
 * - отложенное открытие руководства «С чего начать?»
 */
export function runPostOpenProjectWorkflow(
	context: vscode.ExtensionContext,
	installDependencies: () => Promise<void>
): void {
	const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
	const isOpenFolder = (saved: string | undefined) =>
		saved !== undefined && folders.some((folder) => sameProjectRoot(folder, saved));

	const installAfterCreatePath = context.globalState.get<string>(
		DependenciesCommands.INSTALL_DEPS_AFTER_CREATE_KEY
	);
	if (isOpenFolder(installAfterCreatePath)) {
		void context.globalState.update(
			DependenciesCommands.INSTALL_DEPS_AFTER_CREATE_KEY,
			undefined
		);
		setImmediate(() => void installDependencies());
	}

	const showGetStartedForPath = context.globalState.get<string>(
		'1c-platform-tools.showGetStartedForPath'
	);
	if (isOpenFolder(showGetStartedForPath)) {
		void context.globalState.update('1c-platform-tools.showGetStartedForPath', undefined);
		openGetStartedWalkthrough(context, { scheduleDelayMs: 500 });
	}
}
