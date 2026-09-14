import * as vscode from 'vscode';
import { readActiveProfileName } from '../../shared/projectState';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { registerWorkspaceProjectCommands } from './workspaceProjectCommands';
import { WORKSPACE_PROJECTS_VIEW_ID, WorkspaceProjectsTreeProvider } from './workspaceProjectsView';
import { workspaceProjectsSource } from './workspaceProjectsSource';

/**
 * Регистрирует вид «Рабочая область» и команды «1С: Проект».
 *
 * @param context - Контекст расширения
 * @param showNoProjects - Сообщение, что проектов нет
 */
export function registerWorkspaceProjectsFeature(
	context: vscode.ExtensionContext,
	showNoProjects: () => void
): void {
	const source = workspaceProjectsSource();
	const provider = new WorkspaceProjectsTreeProvider(
		source,
		readActiveProfileName,
		VRunnerManager.getInstance(context).onDidChangeActiveEnvProfile
	);
	const treeView = vscode.window.createTreeView(WORKSPACE_PROJECTS_VIEW_ID, {
		treeDataProvider: provider,
		showCollapseAll: false,
	});
	context.subscriptions.push(provider, treeView, ...registerWorkspaceProjectCommands(source, showNoProjects));
}
