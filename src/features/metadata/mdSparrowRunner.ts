/**
 * Запуск CLI md-sparrow (java -jar …).
 * @module mdSparrowRunner
 */

import { spawn } from 'node:child_process';
import { logger } from '../../shared/logger';
import type { MdSparrowRuntime } from './mdSparrowBootstrap';
import { MdSparrowResidentPool, type ResidentCancellation, type ResidentStopMode } from './mdSparrowResident';

const log = logger.scope('md-sparrow');

export interface MdSparrowRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Параметры вызова md-sparrow. */
export interface MdSparrowRunOptions {
	cwd?: string;
	/** Токен отмены, например vscode.CancellationToken. */
	token?: ResidentCancellation;
	/** Подпись вызова в журнале, например операция. */
	label?: string;
}

/** Подкоманды, которые ничего не пишут: их можно повторить после падения процесса. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['read-json']);

/** Параметры JVM: вывод и пути в UTF-8 независимо от кодировки системы. */
const JVM_OPTIONS = [
	'-Dfile.encoding=UTF-8',
	'-Dsun.jnu.encoding=UTF-8',
	'-Dstdout.encoding=UTF-8',
	'-Dstderr.encoding=UTF-8',
	'-Dsun.stdout.encoding=UTF-8',
	'-Dsun.stderr.encoding=UTF-8',
];

/** Резиденты md-sparrow текущего окна. */
const residents = new MdSparrowResidentPool({
	launch: (runtime, jarPath) => ({ command: runtime.java, args: [...JVM_OPTIONS, '-jar', jarPath, 'serve'] }),
	runOnce: (runtime, request) => runMdSparrowOnce(runtime, [...request.args], request),
	retryable: (args) => READ_ONLY_COMMANDS.has(args[0] ?? ''),
	log,
});

/**
 * Выполняет команду md-sparrow с заданными аргументами командной строки (после main jar).
 *
 * Команда уходит резидентному процессу сборки; сборка без резидентного режима
 * выполняет её разовым запуском.
 */
export function runMdSparrow(
	runtime: MdSparrowRuntime,
	args: string[],
	options?: MdSparrowRunOptions
): Promise<MdSparrowRunResult> {
	return residents.run(runtime, { args, cwd: options?.cwd, token: options?.token, label: options?.label });
}

/**
 * Останавливает резидентные процессы md-sparrow; следующий вызов поднимет их заново.
 *
 * @param mode - `drain` дорабатывает очередь, `now` снимает неотправленные запросы
 */
export function stopMdSparrowResidents(mode: ResidentStopMode = 'drain'): Promise<void> {
	return residents.stopAll(mode);
}

/**
 * Выполняет подпроцесс md-sparrow с заданными аргументами командной строки (после main jar).
 */
export function runMdSparrowOnce(
	runtime: MdSparrowRuntime,
	args: string[],
	options?: MdSparrowRunOptions
): Promise<MdSparrowRunResult> {
	const { java, jarPath } = runtime;
	const fullArgs = [...JVM_OPTIONS, '-jar', jarPath, ...args];
	const cmdLine = `${java} ${fullArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
	log.debug(`запуск: ${cmdLine}${options?.cwd ? ` (cwd=${options.cwd})` : ''}`);
	const label = options?.label ?? args[0] ?? '';

	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(java, fullArgs, {
			cwd: options?.cwd,
			windowsHide: true,
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		const sub = options?.token?.onCancellationRequested(() => {
			try {
				child.kill();
			} catch {
				/* */
			}
		});
		child.on('error', (err) => {
			sub?.dispose();
			log.error(`не удалось запустить процесс: ${err.message}`);
			reject(err);
		});
		child.on('close', (code) => {
			sub?.dispose();
			const duration = Date.now() - startedAt;
			if (code === 0) {
				log.debug(`${label}: разовый запуск за ${duration} мс`);
			} else {
				log.warn(`${label}: код выхода ${code ?? -1} за ${duration} мс${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`);
			}
			resolve({ exitCode: code ?? -1, stdout, stderr });
		});
	});
}
