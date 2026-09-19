/**
 * Фича автономного сервера 1С (ibsrv): команды, статус-бар и меню действий.
 *
 * Статус-бар показывает состояние сервера; клик открывает меню (старт/стоп/
 * перезапуск/браузер/логи/конфиг). Видимость — только для проектов 1С.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerInfobaseHolder } from '../../shared/exclusiveInfobase';
import { openLocalUrl } from '../../shared/remoteEnv';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { ServerUrls } from '../../shared/ibsrvPublication';
import { DEBUG_TYPE } from '../debug/debugConstants';
import { projectPaths } from '../../shared/projectPaths';
import { isAgentOptions, uiOnlyHandler } from '../../shared/agentGate';
import { PlatformServerManager, ServerState, PublicationSelection } from './platformServerManager';
import { notifyQuiet } from '../../shared/notify';
import { projectConfiguration } from '../../shared/projectConfiguration';
import {
	currentRoot,
	onDidChangeCurrentProject,
	outsideProject,
	projectsSnapshot,
	sameProjectRoot,
	workspaceFolderOf,
} from '../../shared/workspaceProjects';
import { inCurrentProject, projectLabel } from '../../commands/projectScope';
import type { StructuredCommandResult } from '../../shared/commandExecutionTypes';

/** Изменяемая ссылка на признак проекта 1С. */
interface ProjectRef {
	current: boolean;
}

/**
 * Открывает один из адресов публикации во внешнем браузере.
 *
 * @param manager - Менеджер сервера
 */
async function openInBrowser(manager: PlatformServerManager): Promise<void> {
	const urls: ServerUrls = manager.getUrls() ?? (await manager.previewUrls());
	const running = manager.state === 'running';

	interface UrlItem extends vscode.QuickPickItem {
		url: string;
	}
	const items: UrlItem[] = [
		{ label: '$(home) Корень публикации', description: urls.root, url: urls.root },
		{ label: '$(symbol-interface) OData $metadata', description: urls.odataMetadata, url: urls.odataMetadata },
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: running ? 'Открыть в браузере' : 'Открыть в браузере (сервер не запущен)',
		placeHolder: running ? 'Выберите адрес' : 'Сервер ещё не запущен, адрес может быть недоступен',
		ignoreFocusOut: true,
	});
	if (picked) {
		await openLocalUrl(picked.url);
	}
}

/** Элемент выбора публикуемых сервисов. */
interface PubItem extends vscode.QuickPickItem {
	role: 'odata' | 'webAll' | 'httpAll' | 'web' | 'http' | 'sep';
	serviceName?: string;
}

/**
 * Взаимоисключение «Все <категория>» и отдельных сервисов категории.
 *
 * Если только что отметили «Все Web/HTTP» — снимаем отдельные сервисы категории;
 * если отметили отдельный — снимаем «Все» этой категории.
 *
 * @param selected - Текущий выбор
 * @param previous - Предыдущий выбор (для вычисления только что добавленного)
 * @returns Согласованный выбор
 */
function reconcileSelection(selected: readonly PubItem[], previous: readonly PubItem[]): PubItem[] {
	const added = selected.filter((it) => !previous.includes(it));
	let result = [...selected];
	for (const item of added) {
		if (item.role === 'webAll') {
			result = result.filter((i) => i.role !== 'web');
		} else if (item.role === 'web') {
			result = result.filter((i) => i.role !== 'webAll');
		} else if (item.role === 'httpAll') {
			result = result.filter((i) => i.role !== 'http');
		} else if (item.role === 'http') {
			result = result.filter((i) => i.role !== 'httpAll');
		}
	}
	return result;
}

/**
 * Показывает QuickPick выбора сервисов со взаимоисключением «Все»/отдельные.
 *
 * @param items - Все элементы выбора
 * @param initial - Изначально отмеченные
 * @param hasServices - Доступны ли списки сервисов из метаданных
 * @returns Отмеченные элементы или undefined при отмене
 */
function pickServices(items: PubItem[], initial: PubItem[], hasServices: boolean): Promise<PubItem[] | undefined> {
	return new Promise((resolve) => {
		const qp = vscode.window.createQuickPick<PubItem>();
		qp.canSelectMany = true;
		qp.title = 'Что публиковать автономным сервером';
		qp.placeholder = hasServices
			? 'Отметьте сервисы; «Все …» и отдельные сервисы взаимоисключают друг друга'
			: 'Метаданные недоступны, доступны только категории';
		qp.ignoreFocusOut = true;
		qp.items = items;
		qp.selectedItems = initial;

		let previous: readonly PubItem[] = initial;
		let guard = false;
		qp.onDidChangeSelection((selected) => {
			if (guard) {
				return;
			}
			const reconciled = reconcileSelection(selected, previous);
			const changed = reconciled.length !== selected.length || reconciled.some((it, i) => it !== selected[i]);
			if (changed) {
				guard = true;
				qp.selectedItems = reconciled;
				guard = false;
			}
			previous = qp.selectedItems;
		});

		let accepted = false;
		qp.onDidAccept(() => {
			accepted = true;
			const result = [...qp.selectedItems];
			qp.hide();
			resolve(result);
		});
		qp.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			qp.dispose();
		});
		qp.show();
	});
}

/**
 * Выбор публикуемых сервисов (QuickPick по дереву метаданных).
 *
 * «Все Web/HTTP-сервисы» и отдельные сервисы категории взаимоисключают друг
 * друга: включил «Все» — отдельные снимаются, и наоборот. Выбор сохраняется
 * локально и применяется к конфигу публикации.
 *
 * @param manager - Менеджер сервера
 */
async function selectPublishedServices(manager: PlatformServerManager): Promise<void> {
	const root = currentRoot();
	const services = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Чтение сервисов из метаданных…' },
		() => manager.loadServices(root)
	);

	const selection = manager.getPublicationSelection(root);

	const items: PubItem[] = [
		{ label: 'OData', description: 'Стандартный интерфейс OData', role: 'odata' },
		{ label: 'Web-сервисы', kind: vscode.QuickPickItemKind.Separator, role: 'sep' },
		{ label: 'Все Web-сервисы', description: 'публиковать все (по умолчанию)', role: 'webAll' },
	];
	for (const name of services?.web ?? []) {
		items.push({ label: name, role: 'web', serviceName: name });
	}
	items.push(
		{ label: 'HTTP-сервисы', kind: vscode.QuickPickItemKind.Separator, role: 'sep' },
		{ label: 'Все HTTP-сервисы', description: 'публиковать все (по умолчанию)', role: 'httpAll' }
	);
	for (const name of services?.http ?? []) {
		items.push({ label: name, role: 'http', serviceName: name });
	}

	const initial = items.filter((it) => {
		switch (it.role) {
			case 'odata': return selection.odata;
			case 'webAll': return selection.webAll;
			case 'httpAll': return selection.httpAll;
			case 'web': return !selection.webAll && selection.web.includes(it.serviceName!);
			case 'http': return !selection.httpAll && selection.http.includes(it.serviceName!);
			default: return false;
		}
	});

	const picked = await pickServices(items, initial, services !== undefined);
	if (!picked) {
		return;
	}

	const has = (role: PubItem['role']): boolean => picked.some((p) => p.role === role);
	const names = (role: PubItem['role']): string[] => picked.filter((p) => p.role === role).map((p) => p.serviceName!);

	const next: PublicationSelection = {
		odata: has('odata'),
		webAll: has('webAll'),
		web: names('web'),
		httpAll: has('httpAll'),
		http: names('http'),
	};
	await manager.setPublicationSelection(next, root);

	const owner = manager.ownerRoot;
	if (manager.state === 'running' && owner !== undefined && root !== undefined && sameProjectRoot(owner, root)) {
		const action = await vscode.window.showInformationMessage(
			'Выбор публикации сохранён. Перезапустить сервер, чтобы применить?',
			'Перезапустить'
		);
		if (action === 'Перезапустить') {
			await manager.restart();
		}
	} else {
		notifyQuiet('Выбор публикуемых сервисов сохранён.');
	}
}

/**
 * Запускает отладку через автономный сервер.
 *
 * Включает порт отладки (если выключен), поднимает/перезапускает сервер
 * текущего проекта с `--debug` и подключает отладчик расширения к порту
 * отладки ibsrv в папке рабочей области этого проекта.
 *
 * @param manager - Менеджер сервера
 */
async function startServerDebug(manager: PlatformServerManager): Promise<void> {
	const root = currentRoot();
	const workspaceFolder = root === undefined ? undefined : workspaceFolderOf(root);
	if (root === undefined || !workspaceFolder) {
		vscode.window.showErrorMessage('Откройте рабочую область проекта 1С.');
		return;
	}

	if (!projectConfiguration(root).get<boolean>('server.debug', false)) {
		const action = await vscode.window.showInformationMessage(
			'Для отладки нужен порт отладки автономного сервера. Включить его (server.debug)?',
			'Включить'
		);
		if (action !== 'Включить') {
			return;
		}
		await projectConfiguration(root).update('server.debug', true, vscode.ConfigurationTarget.Workspace);
	}

	// Перечитываем настройки после возможного включения отладки.
	const serverConfig = projectConfiguration(root);
	const debugPort = serverConfig.get<number>('server.debugPort', 1550);
	const host = serverConfig.get<string>('server.host', 'localhost');

	const configuration = (await projectPaths(root)).configuration?.dir;
	if (configuration === undefined) {
		vscode.window.showErrorMessage('Исходный код конфигурации в рабочей области не найден: отлаживать через сервер нечего.');
		return;
	}

	const ownedByRoot = (): boolean => {
		const owner = manager.ownerRoot;
		return owner !== undefined && sameProjectRoot(owner, root);
	};
	if (manager.state === 'running' && ownedByRoot()) {
		await manager.restart();
	} else {
		await manager.start(root);
	}
	if (manager.state !== 'running' || !ownedByRoot()) {
		return; // ошибка запуска уже показана менеджером
	}

	const started = await vscode.debug.startDebugging(workspaceFolder, {
		type: DEBUG_TYPE,
		request: 'attach',
		name: 'Отладка 1С (автономный сервер)',
		rootProject: path.resolve(root, configuration),
		debugServerHost: host,
		debugServerPort: debugPort,
		autoAttachTypes: ['Server', 'ManagedClient'],
	});
	if (!started) {
		vscode.window.showErrorMessage('Не удалось запустить отладку через автономный сервер.');
	}
}

/**
 * Меню действий сервера (открывается кликом по статус-бару).
 *
 * @param manager - Менеджер сервера
 */
async function showServerMenu(manager: PlatformServerManager): Promise<void> {
	interface MenuItem extends vscode.QuickPickItem {
		action: 'start' | 'stop' | 'restart' | 'browser' | 'services' | 'debug' | 'logs' | 'config';
	}

	const running = manager.state === 'running';
	const busy = manager.state === 'starting';

	const items: MenuItem[] = [];
	if (running) {
		items.push(
			{ label: '$(debug-stop) Остановить сервер', action: 'stop' },
			{ label: '$(debug-restart) Перезапустить', action: 'restart' },
			{ label: '$(globe) Открыть в браузере', action: 'browser' }
		);
	} else if (!busy) {
		items.push({ label: '$(run) Запустить сервер', action: 'start' });
	}
	items.push(
		{ label: '$(checklist) Выбрать публикуемые сервисы', action: 'services' },
		{ label: '$(debug-alt) Отладка через сервер', action: 'debug' },
		{ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'logs' },
		{ label: '$(output) Показать журнал', action: 'logs' },
		{ label: '$(settings-gear) Открыть конфиг публикации', action: 'config' }
	);

	const owner = manager.ownerRoot;
	const picked = await vscode.window.showQuickPick(items, {
		title: `Автономный сервер 1С: ${stateLabel(manager.state)}${owner === undefined ? '' : `, проект ${projectLabel(owner)}`}`,
		ignoreFocusOut: true,
	});
	if (!picked) {
		return;
	}

	switch (picked.action) {
		case 'start':
			await manager.start();
			break;
		case 'stop':
			await manager.stop();
			break;
		case 'restart':
			await manager.restart();
			break;
		case 'browser':
			await openInBrowser(manager);
			break;
		case 'services':
			await selectPublishedServices(manager);
			break;
		case 'debug':
			await startServerDebug(manager);
			break;
		case 'logs':
			manager.showLogs();
			break;
		case 'config':
			await manager.openPublicationConfig();
			break;
	}
}

/**
 * Текстовая метка состояния.
 */
function stateLabel(state: ServerState): string {
	switch (state) {
		case 'running': return 'запущен';
		case 'starting': return 'запускается';
		case 'error': return 'ошибка';
		default: return 'остановлен';
	}
}

/**
 * Регистрирует фичу автономного сервера: менеджер, статус-бар, команды.
 *
 * @param context - Контекст расширения
 * @param isProjectRef - Изменяемая ссылка на признак проекта 1С
 * @returns Массив Disposable
 */
export function registerPlatformServerFeature(
	context: vscode.ExtensionContext,
	isProjectRef: ProjectRef
): vscode.Disposable[] {
	const vrunner = VRunnerManager.getInstance(context);
	const manager = new PlatformServerManager(vrunner, context);

	const statusItem = vscode.window.createStatusBarItem(
		'1c-platform-tools.server.status',
		vscode.StatusBarAlignment.Left,
		1
	);
	statusItem.name = 'Автономный сервер 1С';
	statusItem.command = '1c-platform-tools.server.menu';

	const refresh = (): void => {
		if (!isProjectRef.current || (manager.ownerRoot === undefined && outsideProject(() => currentRoot()) === undefined)) {
			statusItem.hide();
			return;
		}
		applyStatus(statusItem, manager);
		statusItem.show();
	};

	refresh();

	// Пока ibsrv держит файловую базу, конфигуратор её не откроет: команды
	// загрузки, выгрузки и обновления конфигурации БД этой базы просят
	// освободить её на время работы и возвращают сервер сам.
	const holderRegistration = registerInfobaseHolder(manager.infobaseHolder());

	const disposables: vscode.Disposable[] = [
		manager,
		new vscode.Disposable(() => holderRegistration.dispose()),
		statusItem,
		manager.onDidChangeState(() => refresh()),
		// Профиль задаёт адрес ИБ — при его смене сервер перегенерирует конфиг
		// публикации и предложит перезапуск, если работает на другой базе
		vrunner.onDidChangeActiveEnvProfile(() => void manager.onActiveProfileChanged()),
		vrunner.onDidChangeVRunnerVersion(() => void manager.onActiveProfileChanged()),
		// Сервер при смене проекта продолжает работать для своего проекта
		onDidChangeCurrentProject(() => refresh()),
		vscode.commands.registerCommand('1c-platform-tools.server.menu', uiOnlyHandler('Меню сервера открывается пользователем; агенту доступны server.start, server.stop, server.restart.', inCurrentProject(() => showServerMenu(manager)))),
		vscode.commands.registerCommand('1c-platform-tools.server.start', inCurrentProject((arg?: unknown) =>
			isAgentOptions(arg) ? startForAgent(manager) : manager.start()
		)),
		vscode.commands.registerCommand('1c-platform-tools.server.stop', () => manager.stop()),
		vscode.commands.registerCommand('1c-platform-tools.server.restart', inCurrentProject(() => manager.restart())),
		vscode.commands.registerCommand('1c-platform-tools.server.openInBrowser', inCurrentProject(() => openInBrowser(manager))),
		vscode.commands.registerCommand('1c-platform-tools.server.selectServices', inCurrentProject(() => selectPublishedServices(manager))),
		vscode.commands.registerCommand('1c-platform-tools.server.debug', inCurrentProject(() => startServerDebug(manager))),
		vscode.commands.registerCommand('1c-platform-tools.server.showLogs', () => manager.showLogs()),
		vscode.commands.registerCommand('1c-platform-tools.server.openConfig', inCurrentProject(() => manager.openPublicationConfig())),
		vscode.commands.registerCommand('1c-platform-tools.server.statusBarRefresh', () => refresh()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
	];

	return disposables;
}

/**
 * Запуск сервера агентом: без вопроса пользователю, сервер другого проекта не останавливается.
 *
 * @param manager - Менеджер сервера
 * @returns Отказ, когда сервер работает для другого проекта
 */
async function startForAgent(manager: PlatformServerManager): Promise<StructuredCommandResult | void> {
	const root = currentRoot();
	const owner = manager.ownerRoot;
	if (root !== undefined && owner !== undefined && !sameProjectRoot(owner, root)) {
		const message =
			`Автономный сервер проекта ${projectLabel(owner)} запущен. ` +
			'Остановите его командой server.stop и запустите снова.';
		return { success: false, exitCode: 1, stdout: '', stderr: message };
	}
	await manager.start(root);
}

/**
 * Применяет состояние сервера к элементу статус-бара.
 */
function applyStatus(item: vscode.StatusBarItem, manager: PlatformServerManager): void {
	const urls = manager.getUrls();
	const owner = manager.ownerRoot;
	const running = owner !== undefined && projectsSnapshot().projects.length > 1
		? `Автономный сервер проекта ${projectLabel(owner)} запущен`
		: 'Автономный сервер запущен';
	switch (manager.state) {
		case 'running':
			// Янтарный фон (единственный «выделяющий» фон статус-бара) — явный признак,
			// что сервер запущен. Цвет текста VS Code подберёт контрастный автоматически.
			item.text = `$(broadcast) 1С: Сервер${manager.port ? ` :${manager.port}` : ''}`;
			item.tooltip = urls ? `${running}\n${urls.root}` : running;
			item.color = undefined;
			item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			break;
		case 'starting':
			item.text = '$(sync~spin) 1С: Сервер…';
			item.tooltip = 'Автономный сервер запускается';
			item.color = undefined;
			item.backgroundColor = undefined;
			break;
		case 'error':
			item.text = '$(error) 1С: Сервер';
			item.tooltip = 'Ошибка автономного сервера, откройте журнал';
			item.color = undefined;
			item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			break;
		default:
			item.text = '$(server) 1С: Сервер';
			item.tooltip = 'Автономный сервер остановлен';
			item.color = undefined;
			item.backgroundColor = undefined;
	}
}
