/**
 * Реестр открытых форм расширения и сохранение по Ctrl+S.
 *
 * Внутри webview обработчик Ctrl+S не помогает: сочетание перехватывает сам
 * VS Code до страницы. Поэтому клавиша объявлена в манифесте и приходит
 * командой, а команда просит активную форму сохранить себя.
 */

import * as vscode from 'vscode';

/** Сообщение формам: пользователь нажал сохранить */
export const SAVE_REQUEST_MESSAGE = { type: 'saveRequested' } as const;

/** Открытые формы: и custom editor, и панели свойств */
const panels = new Set<vscode.WebviewPanel>();

/** Сохранение боковой панели. */
interface FocusedSave {
	focused: () => boolean;
	save: () => void;
}

const focusedSaves: FocusedSave[] = [];

/**
 * Подключает сохранение боковой панели.
 *
 * @param focused - Панель в фокусе
 * @param save - Записать изменения
 */
export function registerFocusedSave(focused: () => boolean, save: () => void): vscode.Disposable {
	const entry: FocusedSave = { focused, save };
	focusedSaves.push(entry);
	return new vscode.Disposable(() => {
		const index = focusedSaves.indexOf(entry);
		if (index >= 0) {
			focusedSaves.splice(index, 1);
		}
	});
}

/**
 * Ставит форму на учёт и снимает её при закрытии.
 *
 * @param panel - Панель формы
 */
export function registerFormPanel(panel: vscode.WebviewPanel): void {
	panels.add(panel);
	panel.onDidDispose(() => panels.delete(panel));
}

/** Просит сохранить форму в фокусе: боковую панель, иначе активную вкладку. */
export function requestSaveInActiveForm(): void {
	const focused = focusedSaves.find((entry) => entry.focused());
	if (focused) {
		focused.save();
		return;
	}
	for (const panel of panels) {
		if (panel.active) {
			void panel.webview.postMessage(SAVE_REQUEST_MESSAGE);
			return;
		}
	}
}

/**
 * Регистрирует команду сохранения формы.
 *
 * @returns Disposable регистрации
 */
export function registerFormSaveCommand(): vscode.Disposable {
	return vscode.commands.registerCommand('1c-platform-tools.editors.save', () => requestSaveInActiveForm());
}
