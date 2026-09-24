/**
 * Метка каталога `.1cpt` в проводнике.
 *
 * Значок папки задаёт тема значков пользователя. Для Material Icon Theme и
 * vscode-icons расширение задаёт значок через `configurationDefaults` в
 * package.json. Для остальных тем каталог отмечается меткой справа и
 * подсказкой, без цвета: цветом проводник уже показывает состояние git.
 *
 * @module serviceFolderDecoration
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

/** Каталог служебных файлов расширения. */
export const SERVICE_FOLDER = '.1cpt';

/** Декорация без привязки к API VS Code: её можно проверить без редактора. */
export interface ServiceFolderDecoration {
	badge: string;
	tooltip: string;
}

/**
 * Декорация для пути: только сам каталог `.1cpt`.
 *
 * @param fsPath - Путь файла или каталога
 * @returns Метка и подсказка либо undefined для прочих путей
 */
export function serviceFolderDecoration(fsPath: string): ServiceFolderDecoration | undefined {
	return path.basename(fsPath) === SERVICE_FOLDER
		? { badge: '1С', tooltip: '1C: Platform Tools: служебные файлы проекта' }
		: undefined;
}

/**
 * Регистрирует декорацию каталога `.1cpt` в проводнике.
 *
 * @param context - Контекст расширения
 */
export function registerServiceFolderDecoration(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider({
			provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
				return uri.scheme === 'file' ? serviceFolderDecoration(uri.fsPath) : undefined;
			},
		})
	);
}
