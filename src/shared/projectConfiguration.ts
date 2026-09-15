/**
 * Настройки расширения в области проекта.
 * @module projectConfiguration
 */

import * as vscode from 'vscode';
import { currentRoot } from './workspaceProjects';

/**
 * Настройки `1c-platform-tools` для корня проекта: настройки с `scope: resource`
 * берутся из папки рабочей области этого проекта.
 *
 * @param root - Корень проекта; без проекта читаются настройки окна
 */
export function projectConfiguration(root: string | undefined = currentRoot()): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('1c-platform-tools', root === undefined ? undefined : vscode.Uri.file(root));
}
