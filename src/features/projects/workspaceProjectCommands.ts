/**
 * Команды «1С: Проект»: выбор текущего проекта, список, инициализация и действия над строками вида.
 * @module projects/workspaceProjectCommands
 */

import * as vscode from 'vscode';
import { isAgentOptions } from '../../shared/agentGate';
import { notifyQuiet } from '../../shared/notify';
import { projectOverride } from '../../shared/workspaceProjects';
import {
	initializeProjectInteractive,
	initializeProjectResult,
	type ProjectInitializationData,
} from './projectInitialization';
import { listProjectsResult, selectionFailure, selectProjectByRoot, type ProjectCommandResult } from './projectList';
import { candidateName } from './projectPresentation';
import { pickWorkspaceProject } from './workspaceProjectPicker';
import { isWorkspaceProjectsNode, nodeRoot } from './workspaceProjectsView';
import type { WorkspaceProjectsSource } from './workspaceProjectsSource';

/**
 * Корень из аргумента команды: строка, `{ root }`, узел вида или файловый Uri.
 *
 * @param arg - Первый аргумент команды
 */
export function rootArgument(arg: unknown): string | undefined {
	if (typeof arg === 'string') {
		return arg.trim() || undefined;
	}
	if (arg instanceof vscode.Uri) {
		return arg.scheme === 'file' ? arg.fsPath : undefined;
	}
	if (isWorkspaceProjectsNode(arg)) {
		return nodeRoot(arg);
	}
	if (typeof arg === 'object' && arg !== null) {
		const root = (arg as { root?: unknown }).root;
		return typeof root === 'string' && root.trim() !== '' ? root.trim() : undefined;
	}
	return undefined;
}

/** Вызов ждёт результат или пришёл от агента. */
function wantsResult(args: readonly unknown[]): boolean {
	return (
		isAgentOptions(args[0]) ||
		args.some((arg) => typeof arg === 'object' && arg !== null && (arg as { wait?: unknown }).wait === true)
	);
}

/** Каталог из опций агента. */
function projectPathOption(args: readonly unknown[]): string | undefined {
	for (const arg of args) {
		const value = typeof arg === 'object' && arg !== null ? (arg as { projectPath?: unknown }).projectPath : undefined;
		if (typeof value === 'string' && value.trim() !== '') {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Инициализация проекта из команды. Агенту результат без вопросов: каталог из `root`,
 * `projectPath` или корня вызова; пользователю вопросы в окнах.
 *
 * @param source - Проекты окна
 * @param arg - Первый аргумент команды
 * @param opts - Опции вызова
 */
export async function initializeProjectCommand(
	source: WorkspaceProjectsSource,
	arg?: unknown,
	opts?: unknown
): Promise<ProjectCommandResult<ProjectInitializationData> | undefined> {
	const args = [arg, opts];
	if (wantsResult(args)) {
		return initializeProjectResult(source, rootArgument(arg) ?? projectPathOption(args) ?? projectOverride());
	}
	await initializeProjectInteractive(source, rootArgument(arg));
	return undefined;
}

/**
 * Регистрирует команды проектов рабочей области.
 *
 * @param source - Проекты окна
 * @param showNoProjects - Сообщение, что проектов нет
 */
export function registerWorkspaceProjectCommands(
	source: WorkspaceProjectsSource,
	showNoProjects: () => void
): vscode.Disposable[] {
	const selectInteractively = async (): Promise<void> => {
		const pick = await pickWorkspaceProject(source, showNoProjects);
		if (!pick) {
			return;
		}
		if (pick.kind === 'project') {
			await source.selectProject(pick.root);
			return;
		}
		const answer = await vscode.window.showInformationMessage(
			`«${candidateName(pick.candidate)}» не проект: в ${pick.candidate.root} нет файла packagedef. Инициализировать проект?`,
			'Инициализировать проект'
		);
		if (answer) {
			await initializeProjectInteractive(source, pick.candidate.root);
		}
	};

	const targetRoot = (arg: unknown): string | undefined => rootArgument(arg) ?? source.selectedRoot();

	return [
		vscode.commands.registerCommand('1c-platform-tools.project.select', async (arg?: unknown, opts?: unknown) => {
			const root = rootArgument(arg);
			const agent = wantsResult([arg, opts]);
			if (root === undefined) {
				if (agent) {
					return selectionFailure('Передайте корень проекта в параметре root.', source);
				}
				await selectInteractively();
				return undefined;
			}
			const result = await selectProjectByRoot(source, root);
			if (!result.success && !agent) {
				void vscode.window.showErrorMessage(result.stderr);
			}
			return result;
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.makeCurrent', async (arg?: unknown) => {
			const root = rootArgument(arg);
			if (root !== undefined) {
				await source.selectProject(root);
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.list', async (arg?: unknown, opts?: unknown) => {
			if (wantsResult([arg, opts])) {
				return listProjectsResult(source);
			}
			await selectInteractively();
			return undefined;
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.initialize', (arg?: unknown, opts?: unknown) =>
			initializeProjectCommand(source, arg, opts)
		),
		vscode.commands.registerCommand('1c-platform-tools.project.separateConfiguration', async (arg?: unknown) => {
			const root = rootArgument(arg);
			if (root !== undefined) {
				await initializeProjectInteractive(source, root);
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.openInNewWindow', async (arg?: unknown) => {
			const root = targetRoot(arg);
			if (root !== undefined) {
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.revealInExplorer', async (arg?: unknown) => {
			const root = targetRoot(arg);
			if (root !== undefined) {
				await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root));
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.openTerminal', async (arg?: unknown) => {
			const root = targetRoot(arg);
			if (root !== undefined) {
				await vscode.commands.executeCommand('workbench.action.terminal.newWithCwd', { cwd: root });
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.copyPath', async (arg?: unknown) => {
			const root = targetRoot(arg);
			if (root !== undefined) {
				await vscode.env.clipboard.writeText(root);
				notifyQuiet('Путь проекта скопирован');
			}
		}),
		vscode.commands.registerCommand('1c-platform-tools.project.refresh', () => source.refresh()),
	];
}
