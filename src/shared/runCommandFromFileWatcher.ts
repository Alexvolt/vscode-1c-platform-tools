import * as vscode from 'vscode';
import { logger } from './logger';
import { currentRoot, projectOf, runWithProject } from './workspaceProjects';

const log = logger.scope('trigger');

const RUN_COMMAND_FILE = '1c-platform-tools-run-command';
const COMMAND_PREFIX = '1c-platform-tools.';

async function handleRunCommandFile(uri: vscode.Uri): Promise<void> {
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		const line = doc.getText().split(/\r?\n/)[0]?.trim() ?? '';
		if (!line.startsWith(COMMAND_PREFIX)) {
			log.warn(
				`неверный идентификатор в ${uri.fsPath} (ожидается строка, начинающаяся с ${COMMAND_PREFIX})`
			);
			await vscode.workspace.fs.delete(uri, { useTrash: false });
			return;
		}
		await vscode.workspace.fs.delete(uri, { useTrash: false });
		await vscode.commands.executeCommand(line);
		log.info(`выполнена команда ${line}`);
	} catch (error) {
		const errMsg = (error as Error).message;
		log.error(`ошибка при обработке ${uri.fsPath}: ${errMsg}`);
	}
}

/**
 * Следит за файлом-командой `.cursor/1c-platform-tools-run-command` во всех папках
 * рабочей области. Команда выполняется в проекте, где лежит файл; вне проектов
 * в текущем.
 */
export function registerRunCommandFileWatcher(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher(`**/.cursor/${RUN_COMMAND_FILE}`);
	const run = (uri: vscode.Uri) => void runWithProject(projectOf(uri) ?? currentRoot(), () => handleRunCommandFile(uri));
	watcher.onDidCreate(run);
	watcher.onDidChange(run);
	context.subscriptions.push(watcher);
}
