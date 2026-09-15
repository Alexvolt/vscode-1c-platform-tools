/**
 * Имя текущего проекта в описании вида, когда проектов несколько.
 * @module projects/projectViewDescription
 */

import * as vscode from 'vscode';
import { multipleProjectsCurrentName } from './projectPresentation';
import { workspaceProjectsSource, type WorkspaceProjectsSource } from './workspaceProjectsSource';

/**
 * Держит `description` вида равным имени текущего проекта при нескольких проектах.
 *
 * @param treeView - Вид
 * @param source - Проекты окна
 * @returns подписка на проекты
 */
export function bindProjectDescription(
	treeView: Pick<vscode.TreeView<unknown>, 'description'>,
	source: WorkspaceProjectsSource = workspaceProjectsSource()
): vscode.Disposable {
	const update = (): void => {
		treeView.description = multipleProjectsCurrentName(source.snapshotNow().projects, source.selectedRoot());
	};
	update();
	return vscode.Disposable.from(source.onDidChangeProjects(update), source.onDidChangeCurrentProject(update));
}
