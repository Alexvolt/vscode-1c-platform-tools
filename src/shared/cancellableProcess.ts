import * as vscode from 'vscode';
import { spawn, exec, type ChildProcess } from 'node:child_process';
import { logger } from './logger';
import { ProcessOutputDecoder } from './processOutput';
import { untrustedWorkspaceBlocks, WORKSPACE_TRUST_REQUIRED } from './workspaceTrust';

const log = logger.scope('process');

/**
 * Результат выполнения отменяемого процесса
 */
export interface CancellableProcessResult {
	/** Успешность выполнения (exitCode === 0 и не было отмены) */
	success: boolean;
	/** Накопленный стандартный вывод */
	stdout: string;
	/** Накопленный поток ошибок */
	stderr: string;
	/** Код возврата процесса (при отмене или ошибке запуска — -1) */
	exitCode: number;
	/** Признак, что выполнение было прервано по CancellationToken */
	cancelled: boolean;
}

/**
 * Программа со списком аргументов: запускается без оболочки.
 *
 * Пакетные файлы Windows (.bat, .cmd) так не запускаются.
 */
export interface ProgramCall {
	/** Исполняемый файл */
	file: string;
	/** Аргументы, каждый передаётся программе как есть */
	args: readonly string[];
}

/** Строка для оболочки дочернего процесса либо программа с аргументами. */
export type ProcessCommand = string | ProgramCall;

/**
 * Команда запуска вместе с её окружением и уборкой
 */
export interface CommandRun {
	/** Что запустить */
	command: ProcessCommand;
	/** Переменные этого запуска поверх окружения задачи */
	env?: NodeJS.ProcessEnv;
	/** Уборка при отмене */
	onCancel?: () => void;
	/** Уборка после выхода отменённого процесса */
	onCancelled?: () => void;
	/** Уборка после выхода процесса при любом исходе */
	onExit?: () => void;
}

/**
 * Опции выполнения отменяемого процесса
 */
export interface CancellableProcessOptions {
	/** Рабочая директория */
	cwd?: string;
	/** Дополнительные переменные окружения (поверх process.env) */
	env?: NodeJS.ProcessEnv;
	/** Токен отмены: при срабатывании дерево процессов завершается принудительно */
	token?: vscode.CancellationToken;
	/** Колбэк живого вывода: вызывается на каждый чанк stdout и stderr */
	onOutput?: (chunk: string) => void;
	/** Уборка при отмене: вызывается до завершения дерева процессов */
	onCancel?: () => void;
	/** Уборка после выхода отменённого процесса: то, что он успел запустить снаружи, ещё живо */
	onCancelled?: () => void;
	/** Уборка по окончании запуска при любом исходе, в том числе когда процесс не стартовал; после onCancelled */
	onExit?: () => void;
}

/**
 * Принудительно завершает процесс вместе с дочерними.
 *
 * На Windows обязателен taskkill /t: команды вроде vrunner.bat порождают
 * дерево процессов (cmd → oscript → 1cv8), и child.kill() убил бы только cmd.
 * На POSIX процесс запускается в собственной группе (detached), поэтому
 * сигнал отправляется всей группе через отрицательный pid.
 *
 * @param pid - Идентификатор корневого процесса
 */
function killProcessTree(pid: number): void {
	if (process.platform === 'win32') {
		exec(`taskkill /pid ${pid} /t /f`, (error) => {
			if (error) {
				log.warn(`taskkill для pid ${pid} завершился с ошибкой: ${error.message}`);
			}
		});
	} else {
		try {
			process.kill(-pid, 'SIGTERM');
		} catch (error) {
			log.warn(`Не удалось завершить группу процессов ${pid}: ${(error as Error).message}`);
		}
	}
}

/**
 * Выполняет команду как отменяемый процесс с живым выводом.
 *
 * В отличие от child_process.exec, позволяет:
 * - прервать выполнение по CancellationToken (с завершением всего дерева процессов);
 * - получать stdout/stderr по мере поступления (для TestRun.appendOutput).
 *
 * Промис никогда не отклоняется: ошибки запуска возвращаются как
 * { success: false, exitCode: -1, stderr: <сообщение> }.
 *
 * @param command - Строка команды для оболочки либо программа с аргументами
 * @param options - Опции выполнения
 * @returns Промис с результатом выполнения
 */
export function runCancellableCommand(
	command: ProcessCommand,
	options?: CancellableProcessOptions
): Promise<CancellableProcessResult> {
	return new Promise((settle) => {
		let stdout = '';
		let stderr = '';
		let cancelled = false;
		let settled = false;

		const resolve = (result: CancellableProcessResult) => {
			try {
				options?.onExit?.();
			} catch (error) {
				log.warn(`Уборка после запуска не удалась: ${(error as Error).message}`);
			}
			settle(result);
		};

		// Отменённый заранее запуск не стартует: иначе процесс успел бы создать контейнер или базу
		if (options?.token?.isCancellationRequested) {
			resolve({ success: false, stdout, stderr, exitCode: -1, cancelled: true });
			return;
		}

		// Единственная точка запуска дочерних процессов расширения: терминал задачи,
		// панель тестирования и синхронные команды приходят сюда
		if (untrustedWorkspaceBlocks(typeof command === 'string' ? command : command.file)) {
			options?.onOutput?.(`${WORKSPACE_TRUST_REQUIRED}\n`);
			resolve({ success: false, stdout, stderr: WORKSPACE_TRUST_REQUIRED, exitCode: -1, cancelled: false });
			return;
		}

		const spawnOptions = {
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : process.env,
			windowsHide: true,
			// На POSIX — собственная группа процессов, чтобы убивать всё дерево
			detached: process.platform !== 'win32'
		};
		let child: ChildProcess;
		try {
			child = typeof command === 'string'
				? spawn(command, { ...spawnOptions, shell: true })
				: spawn(command.file, command.args, { ...spawnOptions, shell: false });
		} catch (error) {
			// Отказ запуска без оболочки (например, EINVAL у пакетного файла) приходит исключением
			const message = (error as Error).message;
			options?.onOutput?.(message);
			resolve({ success: false, stdout, stderr: message, exitCode: -1, cancelled: false });
			return;
		}

		const finish = (exitCode: number) => {
			if (settled) {
				return;
			}
			settled = true;
			cancellationSubscription?.dispose();
			if (cancelled) {
				options?.onCancelled?.();
			}
			resolve({
				success: exitCode === 0 && !cancelled,
				stdout,
				stderr,
				exitCode,
				cancelled
			});
		};

		const cancellationSubscription = options?.token?.onCancellationRequested(() => {
			cancelled = true;
			options?.onCancel?.();
			if (child.pid !== undefined) {
				log.info(`Отмена: завершаю дерево процессов pid ${child.pid}`);
				killProcessTree(child.pid);
			}
		});

		// Кодировку выбирает декодер: на Windows консольные программы пишут не в UTF-8
		const stdoutDecoder = new ProcessOutputDecoder();
		const stderrDecoder = new ProcessOutputDecoder();
		child.stdout?.on('data', (chunk: Buffer) => {
			const text = stdoutDecoder.push(chunk);
			if (text !== '') {
				stdout += text;
				options?.onOutput?.(text);
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = stderrDecoder.push(chunk);
			if (text !== '') {
				stderr += text;
				options?.onOutput?.(text);
			}
		});

		child.on('error', (error) => {
			stderr += error.message;
			options?.onOutput?.(error.message);
			finish(-1);
		});

		child.on('close', (code) => {
			for (const [decoder, isStdout] of [[stdoutDecoder, true], [stderrDecoder, false]] as const) {
				const rest = decoder.flush();
				if (rest === '') {
					continue;
				}
				if (isStdout) {
					stdout += rest;
				} else {
					stderr += rest;
				}
				options?.onOutput?.(rest);
			}
			finish(code ?? -1);
		});
	});
}
