/**
 * Доверие к папке: расширение не запускает код из недоверенной рабочей области.
 *
 * Расширение выполняет vrunner, rac, 1cestart и 1cedtcli, ставит OneScript и
 * зависимости, поднимает Docker и автономный сервер, прогоняет тесты и шаги
 * хуков. Всё это запускает программы по проекту, поэтому в режиме ограниченной
 * функциональности такие действия не выполняются. Собственный компонент чтения
 * метаданных сюда не входит: его путь и источник задаёт расширение, а не папка.
 * После того как папке доверили, проверка проходит и команды работают обычным
 * образом: состояние читается на каждый вызов.
 *
 * @module workspaceTrust
 */

import * as vscode from 'vscode';
import { logger } from './logger';

const log = logger.scope('trust');

/** Показывать предупреждение не чаще раза в этот интервал. */
const NOTICE_INTERVAL_MS = 10_000;

/**
 * Отказ, который видят пользователь, агент и терминал задачи.
 *
 * Текст один на все места: причина и что сделать, чтобы команда пошла.
 */
export const WORKSPACE_TRUST_REQUIRED =
	'Папка не доверенная, расширение не запускает код из неё. Подтвердите доверие папке в VS Code и повторите.';

let lastNoticeAt = 0;

/** Чтение признака доверия; в тестах подменяется {@link setWorkspaceTrustProbe}. */
let readTrust: () => boolean = () => vscode.workspace.isTrusted;

/**
 * Подменяет источник признака доверия.
 *
 * Окно vscode-test всегда доверенное, поэтому отказ проверяется подменой.
 *
 * @param probe - Чтение признака; без аргумента возвращается состояние окна
 */
export function setWorkspaceTrustProbe(probe?: () => boolean): void {
	readTrust = probe ?? (() => vscode.workspace.isTrusted);
}

/**
 * Признак доверия к рабочей области.
 *
 * @returns true, если папке доверяют
 */
export function isWorkspaceTrusted(): boolean {
	return readTrust();
}

/**
 * Проверяет доверие перед действием, которое запускает пользователь.
 *
 * @param action - Что собирались сделать, в именительном падеже
 * @returns true, если папке доверяют и действие можно выполнять
 */
export function ensureWorkspaceTrusted(action: string): boolean {
	if (isWorkspaceTrusted()) {
		return true;
	}

	log.warn(`папка не доверенная, действие не выполнено: ${action}`);
	const now = Date.now();
	if (now - lastNoticeAt > NOTICE_INTERVAL_MS) {
		lastNoticeAt = now;
		void vscode.window.showWarningMessage(WORKSPACE_TRUST_REQUIRED);
	}
	return false;
}

/**
 * Обёртка обработчика команды, которая запускает код из папки.
 *
 * @param action - Что собирались сделать либо идентификатор команды
 * @param handler - Обработчик команды
 * @returns Обработчик, который в недоверенной папке не вызывается
 */
export function withWorkspaceTrust<A extends unknown[], R>(
	action: string,
	handler: (...args: A) => R
): (...args: A) => R | undefined {
	return (...args: A) => (ensureWorkspaceTrusted(action) ? handler(...args) : undefined);
}

/**
 * Проверяет доверие в глубине запуска: без окна, сообщение показывает точка входа.
 *
 * @param action - Что собирались сделать, в именительном падеже
 * @returns true, если запускать нельзя
 */
export function untrustedWorkspaceBlocks(action: string): boolean {
	if (isWorkspaceTrusted()) {
		return false;
	}
	log.warn(`папка не доверенная, запуск отменён: ${action}`);
	return true;
}

/**
 * Подписывается на выдачу доверия рабочей области.
 *
 * @param onGranted - Что сделать, когда папке доверили
 * @returns Подписка
 */
export function onWorkspaceTrustGranted(onGranted: () => void): vscode.Disposable {
	return vscode.workspace.onDidGrantWorkspaceTrust(() => {
		log.info('папке выдано доверие');
		onGranted();
	});
}
