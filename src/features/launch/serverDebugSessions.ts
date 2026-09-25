/**
 * Сессии отладки, подключённые к порту отладки автономного сервера.
 *
 * Сервер отладки живёт в процессе ibsrv: остановка сервера завершает эти сессии,
 * перезапуск подключает отладчик заново.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEBUG_TYPE } from '../debug/debugConstants';
import { debugSourceFields } from '../debug/debugConfigurations';
import { projectPaths } from '../../shared/projectPaths';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { runWithProject, sameProjectRoot, workspaceFolderOf } from '../../shared/workspaceProjects';
import type { PlatformServerManager, ServerState } from './platformServerManager';

/** Порт отладки ibsrv слушает только на этом адресе, какой бы сетевой интерфейс ни стоял в server.host. */
const DEBUG_SERVER_HOST = '127.0.0.1';

/** Адреса этой машины. */
const LOOPBACK_HOSTS = new Set(['localhost', DEBUG_SERVER_HOST, '::1', '[::1]']);

/**
 * Подключена ли конфигурация отладки к порту отладки запущенного сервера.
 *
 * @param configuration - Конфигурация сессии отладки
 * @param debugPort - Порт отладки запущенного сервера
 */
export function attachesToServer(configuration: vscode.DebugConfiguration, debugPort: number | undefined): boolean {
	return (
		debugPort !== undefined &&
		configuration.type === DEBUG_TYPE &&
		configuration.request === 'attach' &&
		LOOPBACK_HOSTS.has(String(configuration.debugServerHost ?? '').toLowerCase()) &&
		Number(configuration.debugServerPort) === debugPort
	);
}

export class ServerDebugSessions implements vscode.Disposable {
	private readonly sessions = new Set<vscode.DebugSession>();
	/** Проект, для которого после запуска сервера отладчик подключается снова. */
	private resumeFor: string | undefined;
	private attaching: Promise<void> | undefined;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[];

	/** Сессия отладки через сервер началась или закончилась. */
	public readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly manager: PlatformServerManager) {
		this.disposables = [
			this.changeEmitter,
			vscode.debug.onDidStartDebugSession((session) => {
				if (attachesToServer(session.configuration, manager.debugPort)) {
					this.sessions.add(session);
					this.changeEmitter.fire();
				}
			}),
			vscode.debug.onDidTerminateDebugSession((session) => {
				if (this.sessions.delete(session)) {
					this.changeEmitter.fire();
				}
			}),
			manager.onWillStop(() => this.stopBeforeServer()),
			manager.onDidChangeState((state) => this.resumeAfterStart(state)),
		];
	}

	/** Идёт ли отладка через сервер. */
	public get active(): boolean {
		return this.sessions.size > 0;
	}

	/** Завершает отладку через сервер. */
	public async stop(): Promise<void> {
		await Promise.all([...this.sessions].map((session) => vscode.debug.stopDebugging(session)));
	}

	/** Сервер запущен или остановлен пользователем: отладчик сам не подключается. */
	public forgetResume(): void {
		this.resumeFor = undefined;
	}

	/**
	 * Подключает отладчик к порту отладки запущенного сервера проекта.
	 *
	 * @param root - Корень проекта
	 */
	public attach(root: string): Promise<void> {
		this.attaching ??= this.attachIn(root).finally(() => {
			this.attaching = undefined;
		});
		return this.attaching;
	}

	private async attachIn(root: string): Promise<void> {
		const workspaceFolder = workspaceFolderOf(root);
		const paths = await projectPaths(root);
		if (!workspaceFolder || paths.configuration?.dir === undefined) {
			vscode.window.showErrorMessage('Исходный код конфигурации в рабочей области не найден: отлаживать через сервер нечего.');
			return;
		}
		const started = await vscode.debug.startDebugging(workspaceFolder, {
			type: DEBUG_TYPE,
			request: 'attach',
			name: 'Отладка 1С (автономный сервер)',
			...debugSourceFields(
				paths,
				runWithProject(root, () => VRunnerManager.getInstance().getOutPath()),
				(relative) => path.resolve(root, relative)
			),
			debugServerHost: DEBUG_SERVER_HOST,
			debugServerPort: this.manager.debugPort,
			autoAttachTypes: ['Server', 'ManagedClient'],
		});
		if (!started) {
			vscode.window.showErrorMessage('Не удалось запустить отладку через автономный сервер.');
		}
	}

	private async stopBeforeServer(): Promise<void> {
		if (!this.active) {
			return;
		}
		this.resumeFor = this.manager.ownerRoot;
		await this.stop();
	}

	private resumeAfterStart(state: ServerState): void {
		const root = this.resumeFor;
		if (root === undefined || state === 'starting' || state === 'stopped') {
			return;
		}
		this.resumeFor = undefined;
		const owner = this.manager.ownerRoot;
		if (state === 'running' && owner !== undefined && sameProjectRoot(owner, root) && this.manager.debugPort !== undefined) {
			void this.attach(owner);
		}
	}

	public dispose(): void {
		this.disposables.forEach((item) => item.dispose());
	}
}
