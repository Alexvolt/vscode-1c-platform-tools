/**
 * Резидентный процесс md-sparrow: одна JVM на сборку, запросы и ответы строками JSON.
 *
 * Процесс запускается первым запросом и принимает запросы после строки готовности.
 * Следующий запрос уходит, когда пришёл ответ на предыдущий: при падении процесса
 * известно, какой запрос был в работе. Сборка, которая не прислала готовность,
 * запоминается, и её запросы дальше идут разовыми запусками.
 *
 * @module mdSparrowResident
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScopedLogger } from '../../shared/logger';
import type { MdSparrowRuntime } from './mdSparrowBootstrap';
import type { MdSparrowRunResult } from './mdSparrowRunner';

/** Версия протокола, на которой говорит клиент. */
const PROTOCOL = 1;

/** Код ответа на отменённый запрос. */
const CANCELLED_EXIT_CODE = 130;

/** Сколько раз отправляется запрос чтения, если процесс падает на нём. */
const READ_ATTEMPTS = 2;

/** Сколько последних символов stderr процесса попадает в ошибку при падении. */
const STDERR_TAIL = 4000;

/** Ожидание в очереди, начиная с которого оно попадает в журнал. */
const QUEUE_WAIT_LOG_MS = 50;

/** Префикс каталогов с копиями локальных сборок во временном каталоге. */
const COPY_DIR_PREFIX = 'md-sparrow-resident-';

/** Токен отмены: совместим с vscode.CancellationToken. */
export interface ResidentCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Запрос к md-sparrow: аргументы те же, что у разового запуска. */
export interface ResidentRequest {
	args: readonly string[];
	cwd?: string;
	token?: ResidentCancellation;
	/** Подпись запроса в журнале. */
	label?: string;
}

/** Команда запуска процесса. */
export interface ResidentLaunch {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}

/** Сроки жизни процесса. */
export interface ResidentTiming {
	/** Сколько ждать строку готовности. */
	readyTimeoutMs: number;
	/** Простой, после которого процесс останавливается. */
	idleMs: number;
	/** Сколько ждать выхода процесса после просьбы завершиться. */
	exitWaitMs: number;
	/** Сколько при остановке ждать запросы, уже стоящие в очереди, и запрос в работе. */
	drainMs: number;
}

export const RESIDENT_TIMING: ResidentTiming = {
	readyTimeoutMs: 30_000,
	idleMs: 10 * 60_000,
	exitWaitMs: 3_000,
	drainMs: 30_000,
};

/**
 * Как останавливать процесс.
 *
 * `drain` дорабатывает очередь, `now` снимает неотправленные запросы и ждёт только
 * запрос в работе.
 */
export type ResidentStopMode = 'drain' | 'now';

/** Процесс не прислал строку готовности: сборка не знает резидентного режима. */
export class ResidentUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ResidentUnsupportedError';
	}
}

/** Процесс остановлен: запрос в него уже не попадёт. */
export class ResidentStoppedError extends Error {
	constructor() {
		super('Процесс md-sparrow остановлен.');
		this.name = 'ResidentStoppedError';
	}
}

interface Job {
	readonly id: number;
	readonly request: ResidentRequest;
	readonly retryable: boolean;
	readonly createdAt: number;
	attempts: number;
	sentAt: number;
	cancelRequested: boolean;
	settled: boolean;
	/** Ждут результата запроса. */
	settledWaiters: Array<() => void>;
	cancelSubscription?: { dispose(): void };
	resolve(result: MdSparrowRunResult): void;
	reject(error: Error): void;
}

interface ReadyMessage {
	ready: true;
	version?: string;
	protocol: number;
}

interface ResponseMessage {
	id: number;
	exitCode: number;
	stdout?: string;
	stderr?: string;
	/** Последний ответ процесса: следующих запросов он не выполнит. */
	closing?: boolean;
}

function isReady(message: unknown): message is ReadyMessage {
	const value = message as Partial<ReadyMessage> | null;
	return typeof value === 'object' && value !== null && value.ready === true && value.protocol === PROTOCOL;
}

function isResponse(message: unknown): message is ResponseMessage {
	const value = message as Partial<ResponseMessage> | null;
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof value.id === 'number' &&
		typeof value.exitCode === 'number'
	);
}

/** JSON без символов вне ASCII: канал не зависит от кодировки stdin процесса. */
function asciiJson(message: unknown): string {
	return JSON.stringify(message).replace(
		/[^\x00-\x7e]/g,
		(ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
	);
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}

function cancelledResult(): MdSparrowRunResult {
	return { exitCode: CANCELLED_EXIT_CODE, stdout: '', stderr: '' };
}

function stoppedResult(): MdSparrowRunResult {
	return { exitCode: -1, stdout: '', stderr: 'Процесс md-sparrow остановлен до завершения операции.' };
}

/** Настройки одного резидента. */
export interface ResidentOptions {
	/** Команда запуска; зовётся перед каждым стартом процесса. */
	prepare: () => Promise<ResidentLaunch>;
	/** Можно ли повторить запрос, на котором упал процесс. */
	retryable: (args: readonly string[]) => boolean;
	log: ScopedLogger;
	/** Подпись сборки в журнале. */
	label: string;
	timing: ResidentTiming;
	/** Зовётся, когда резидент остановлен насовсем. */
	onStopped?: () => Promise<void>;
}

/**
 * Резидентный процесс одной сборки md-sparrow с очередью запросов.
 *
 * Процесс поднимается по первому запросу, останавливается по простою и
 * поднимается снова по следующему.
 */
export class MdSparrowResident {
	private child: ChildProcess | undefined;
	private ready = false;
	/** Идёт подготовка запуска: процесса ещё нет, но второй запускать не надо. */
	private starting = false;
	/** Процесс попросили завершиться. */
	private exiting = false;
	/** Резидент не принимает новые запросы. */
	private stopping = false;
	/** Очередь доработана, процесс больше не поднимается. */
	private closing = false;
	private readyTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private startedAt = 0;
	private stdoutParts: string[] = [];
	private stderrTail = '';
	private current: Job | undefined;
	private queue: Job[] = [];
	private nextId = 1;
	private exitWaiters: Array<() => void> = [];
	private drainWaiters: Array<() => void> = [];
	private stopPromise: Promise<void> | undefined;

	constructor(private readonly options: ResidentOptions) {}

	/** Идентификатор живого процесса или undefined. */
	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** Сколько запросов ждёт отправки. */
	get queued(): number {
		return this.queue.length;
	}

	/**
	 * Ставит запрос в очередь.
	 *
	 * @throws ResidentUnsupportedError - сборка не прислала готовность
	 * @throws ResidentStoppedError - резидент остановлен
	 */
	run(request: ResidentRequest): Promise<MdSparrowRunResult> {
		if (this.stopping) {
			return Promise.reject(new ResidentStoppedError());
		}
		if (request.token?.isCancellationRequested) {
			return Promise.resolve(cancelledResult());
		}
		clearTimeout(this.idleTimer);
		return new Promise<MdSparrowRunResult>((resolve, reject) => {
			const job: Job = {
				id: this.nextId++,
				request,
				retryable: this.options.retryable(request.args),
				createdAt: Date.now(),
				attempts: 0,
				sentAt: 0,
				cancelRequested: false,
				settled: false,
				settledWaiters: [],
				resolve,
				reject,
			};
			job.cancelSubscription = request.token?.onCancellationRequested(() => this.cancel(job));
			this.queue.push(job);
			this.pump();
		});
	}

	/**
	 * Останавливает процесс; новые запросы резидент больше не принимает.
	 *
	 * @param mode - Дорабатывать ли очередь
	 */
	stop(mode: ResidentStopMode): Promise<void> {
		this.stopPromise ??= this.stopOnce(mode);
		return this.stopPromise;
	}

	private async stopOnce(mode: ResidentStopMode): Promise<void> {
		this.stopping = true;
		clearTimeout(this.idleTimer);
		if (mode === 'now') {
			const queued = this.queue;
			this.queue = [];
			for (const job of queued) {
				this.finish(job, stoppedResult());
			}
		} else {
			await this.drained(this.options.timing.drainMs);
		}
		this.closing = true;
		await this.shutdownProcess();
		const left = [...this.queue, ...(this.current ? [this.current] : [])];
		this.queue = [];
		this.current = undefined;
		for (const job of left) {
			this.finish(job, stoppedResult());
		}
		await this.options.onStopped?.();
	}

	private drained(limitMs: number): Promise<void> {
		if (!this.current && this.queue.length === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const timer = setTimeout(done, limitMs);
			const waiters = this.drainWaiters;
			function done(): void {
				clearTimeout(timer);
				const index = waiters.indexOf(done);
				if (index >= 0) {
					waiters.splice(index, 1);
				}
				resolve();
			}
			waiters.push(done);
		});
	}

	private pump(): void {
		if (this.current) {
			return;
		}
		const next = this.queue[0];
		if (!next) {
			this.releaseDrainWaiters();
			this.armIdleTimer();
			return;
		}
		if (this.exiting || this.starting) {
			return;
		}
		if (!this.child) {
			if (!this.closing) {
				void this.start();
			}
			return;
		}
		if (!this.ready) {
			return;
		}
		this.queue.shift();
		this.send(next);
	}

	private async start(): Promise<void> {
		this.starting = true;
		let launch: ResidentLaunch;
		try {
			launch = await this.options.prepare();
		} catch (error) {
			this.starting = false;
			this.failSpawn(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		this.starting = false;
		// Запросы могли отменить или снять, пока готовился запуск
		if (this.queue.length === 0 || this.closing) {
			this.pump();
			return;
		}
		this.ready = false;
		this.stdoutParts = [];
		this.stderrTail = '';
		this.startedAt = Date.now();
		let child: ChildProcess;
		try {
			child = spawn(launch.command, launch.args, {
				windowsHide: true,
				env: launch.env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			this.failSpawn(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		this.child = child;
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => this.onStdout(child, chunk));
		child.stderr?.on('data', (chunk: string) => this.onStderr(child, chunk));
		child.stdin?.on('error', () => {
			/* процесс закрыл stdin: выход придёт событием close */
		});
		child.on('error', (error) => this.onError(child, error));
		child.on('close', (code, signal) => this.onClose(child, code, signal));
		this.readyTimer = setTimeout(() => this.onReadyTimeout(child), this.options.timing.readyTimeoutMs);
	}

	private onStdout(child: ChildProcess, chunk: string): void {
		let from = 0;
		while (child === this.child) {
			const newline = chunk.indexOf('\n', from);
			if (newline < 0) {
				if (from < chunk.length) {
					this.stdoutParts.push(chunk.slice(from));
				}
				return;
			}
			this.stdoutParts.push(chunk.slice(from, newline));
			const line = this.stdoutParts.join('').replace(/\r$/, '');
			this.stdoutParts = [];
			from = newline + 1;
			if (line.trim() !== '') {
				this.onLine(child, line);
			}
		}
	}

	private onStderr(child: ChildProcess, chunk: string): void {
		if (child !== this.child) {
			return;
		}
		this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
		for (const line of chunk.split(/\r?\n/)) {
			if (line.trim() !== '') {
				this.options.log.trace(`stderr: ${line}`);
			}
		}
	}

	private onLine(child: ChildProcess, line: string): void {
		const message = parseLine(line);
		if (!this.ready) {
			if (isReady(message)) {
				clearTimeout(this.readyTimer);
				this.ready = true;
				const version = message.version ? ` ${message.version}` : '';
				this.options.log.info(
					`резидент md-sparrow${version} запущен за ${Date.now() - this.startedAt} мс, pid ${child.pid}: ${this.options.label}`
				);
				this.pump();
				return;
			}
			this.options.log.info(`сборка не прислала готовность, дальше разовые запуски: ${this.options.label}`);
			this.options.log.debug(`первая строка: ${line.slice(0, 200)}`);
			this.abandon(child);
			return;
		}
		if (!isResponse(message)) {
			this.options.log.warn(`неожиданная строка в ответе md-sparrow: ${line.slice(0, 200)}`);
			return;
		}
		const job = this.current;
		if (!job || job.id !== message.id) {
			this.options.log.warn(`ответ на неизвестный запрос ${message.id}`);
			return;
		}
		this.current = undefined;
		if (message.closing === true) {
			this.options.log.warn(`резидент md-sparrow завершается после сбоя, pid ${child.pid}`);
			this.expectExit(child);
		}
		this.finish(job, {
			exitCode: message.exitCode,
			stdout: message.stdout ?? '',
			stderr: message.stderr ?? '',
		});
		this.pump();
	}

	/** Процесс выходит сам: очередь ждёт нового, а не вышедший вовремя снимается. */
	private expectExit(child: ChildProcess): void {
		clearTimeout(this.idleTimer);
		this.exiting = true;
		const timer = setTimeout(() => this.kill(child), this.options.timing.exitWaitMs);
		timer.unref();
		this.exitWaiters.push(() => clearTimeout(timer));
	}

	private onReadyTimeout(child: ChildProcess): void {
		if (child !== this.child || this.ready) {
			return;
		}
		this.options.log.info(
			`нет готовности за ${this.options.timing.readyTimeoutMs} мс, дальше разовые запуски: ${this.options.label}`
		);
		this.abandon(child);
	}

	/** Сборка не работает резидентом: запросы уходят разовым запускам, процесс снимается. */
	private abandon(child: ChildProcess): void {
		this.detach(child);
		this.kill(child);
		const error = new ResidentUnsupportedError(`md-sparrow не поддерживает резидентный режим: ${this.options.label}`);
		const jobs = [...this.queue, ...(this.current ? [this.current] : [])];
		this.queue = [];
		this.current = undefined;
		for (const job of jobs) {
			this.fail(job, error);
		}
		this.releaseDrainWaiters();
		void this.stop('now');
	}

	private onError(child: ChildProcess, error: Error): void {
		if (child !== this.child || child.pid !== undefined) {
			return;
		}
		this.detach(child);
		this.failSpawn(error);
	}

	private failSpawn(error: Error): void {
		this.options.log.error(`не удалось запустить процесс: ${error.message}`);
		const jobs = this.queue;
		this.queue = [];
		for (const job of jobs) {
			this.fail(job, error);
		}
		this.releaseDrainWaiters();
		void this.stop('now');
	}

	/** Очередь опустела: остановка с доработкой больше её не ждёт. */
	private releaseDrainWaiters(): void {
		for (const waiter of this.drainWaiters.splice(0)) {
			waiter();
		}
	}

	private onClose(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		for (const waiter of this.exitWaiters.splice(0)) {
			waiter();
		}
		if (child !== this.child) {
			return;
		}
		const wasReady = this.ready;
		const intended = this.exiting;
		this.detach(child);
		const exit = code ?? signal ?? -1;
		if (intended) {
			this.options.log.info(`резидент md-sparrow остановлен, pid ${child.pid}`);
			const job = this.current;
			this.current = undefined;
			if (job) {
				this.finish(job, job.cancelRequested ? cancelledResult() : stoppedResult());
			}
			this.pump();
			return;
		}
		if (!wasReady) {
			this.options.log.info(`сборка завершилась с кодом ${exit} до готовности, дальше разовые запуски: ${this.options.label}`);
			this.abandon(child);
			return;
		}
		this.options.log.warn(`резидент md-sparrow завершился с кодом ${exit}, pid ${child.pid}`);
		const job = this.current;
		this.current = undefined;
		if (job) {
			if (job.cancelRequested) {
				this.finish(job, cancelledResult());
			} else if (job.retryable && job.attempts < READ_ATTEMPTS) {
				this.options.log.info(`повтор запроса ${this.describe(job)} на новом процессе`);
				this.queue.unshift(job);
			} else {
				const tail = this.stderrTail.trim();
				this.finish(job, {
					exitCode: typeof code === 'number' && code !== 0 ? code : -1,
					stdout: '',
					stderr: `Процесс md-sparrow завершился во время операции.${tail ? `\n${tail}` : ''}`,
				});
			}
		}
		this.pump();
	}

	/** Отвязывает процесс: его события больше не трогают состояние. */
	private detach(child: ChildProcess): void {
		if (child !== this.child) {
			return;
		}
		clearTimeout(this.readyTimer);
		clearTimeout(this.idleTimer);
		this.child = undefined;
		this.ready = false;
		this.exiting = false;
		this.stdoutParts = [];
	}

	private kill(child: ChildProcess): void {
		try {
			child.kill();
		} catch {
			/* процесс уже завершился */
		}
	}

	private send(job: Job): void {
		job.attempts += 1;
		job.sentAt = Date.now();
		this.current = job;
		const message: { id: number; args: readonly string[]; cwd?: string } = { id: job.id, args: job.request.args };
		if (job.request.cwd) {
			message.cwd = job.request.cwd;
		}
		this.write(message);
	}

	private write(message: unknown): void {
		const stdin = this.child?.stdin;
		if (stdin && stdin.writable) {
			stdin.write(`${asciiJson(message)}\n`);
		}
	}

	private cancel(job: Job): void {
		if (job.settled || job.cancelRequested) {
			return;
		}
		job.cancelRequested = true;
		const index = this.queue.indexOf(job);
		if (index >= 0) {
			this.queue.splice(index, 1);
			this.finish(job, cancelledResult());
			this.pump();
			return;
		}
		if (this.current === job && this.ready) {
			this.write({ id: job.id, cancel: true });
		}
	}

	private finish(job: Job, result: MdSparrowRunResult): void {
		if (job.settled) {
			return;
		}
		job.settled = true;
		job.cancelSubscription?.dispose();
		const now = Date.now();
		const waited = (job.sentAt || now) - job.createdAt;
		const timing = `${job.sentAt ? now - job.sentAt : 0} мс${waited >= QUEUE_WAIT_LOG_MS ? `, ожидание ${waited} мс` : ''}`;
		if (result.exitCode === 0 || result.exitCode === CANCELLED_EXIT_CODE) {
			const outcome = result.exitCode === 0 ? 'готово' : 'отменено';
			this.options.log.debug(`${this.describe(job)}: ${outcome} за ${timing}`);
		} else {
			const firstLine = result.stderr.trim().split('\n')[0];
			this.options.log.warn(
				`${this.describe(job)}: код выхода ${result.exitCode} за ${timing}${firstLine ? `: ${firstLine}` : ''}`
			);
		}
		job.resolve(result);
		this.releaseSettledWaiters(job);
	}

	private fail(job: Job, error: Error): void {
		if (job.settled) {
			return;
		}
		job.settled = true;
		job.cancelSubscription?.dispose();
		job.reject(error);
		this.releaseSettledWaiters(job);
	}

	private releaseSettledWaiters(job: Job): void {
		for (const waiter of job.settledWaiters.splice(0)) {
			waiter();
		}
	}

	/**
	 * Ждёт результата запроса в работе.
	 *
	 * @param limitMs - Дольше не ждать
	 */
	private currentSettled(limitMs: number): Promise<void> {
		const job = this.current;
		if (!job || job.settled) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const timer = setTimeout(done, limitMs);
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
			job.settledWaiters.push(done);
		});
	}

	private describe(job: Job): string {
		return job.request.label ?? job.request.args[0] ?? '';
	}

	private armIdleTimer(): void {
		clearTimeout(this.idleTimer);
		if (!this.child || this.stopping || this.exiting) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			if (!this.current && this.queue.length === 0 && !this.stopping) {
				this.options.log.info('резидент md-sparrow простаивает, останавливаем');
				void this.shutdownProcess();
			}
		}, this.options.timing.idleMs);
		this.idleTimer.unref();
	}

	/** Просит процесс завершиться и ждёт выхода; не дождавшись, снимает его. */
	private async shutdownProcess(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		clearTimeout(this.idleTimer);
		const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
		this.exiting = true;
		if (this.ready) {
			// Процесс дописывает запрос в работе и выходит сам; до конца ввода до него доходит отмена
			this.write({ shutdown: true });
			await Promise.race([exited, this.currentSettled(this.options.timing.drainMs)]);
			child.stdin?.end();
		} else {
			this.kill(child);
		}
		const timer = setTimeout(() => this.kill(child), this.options.timing.exitWaitMs);
		await exited;
		clearTimeout(timer);
	}
}

/** Настройки набора резидентов. */
export interface ResidentPoolOptions {
	/** Команда запуска сборки из указанного файла jar. */
	launch: (runtime: MdSparrowRuntime, jarPath: string) => ResidentLaunch;
	/** Разовый запуск: для сборок без резидентного режима. */
	runOnce: (runtime: MdSparrowRuntime, request: ResidentRequest) => Promise<MdSparrowRunResult>;
	retryable: (args: readonly string[]) => boolean;
	log: ScopedLogger;
	timing?: Partial<ResidentTiming>;
	/** Каталог, в котором создаются копии локальных сборок. */
	tempRoot?: string;
}

interface PoolEntry {
	readonly identity: string;
	readonly resident: MdSparrowResident;
}

/**
 * Резиденты по сборкам md-sparrow.
 *
 * Сборка определяется путями java и jar, размером и временем изменения jar:
 * пересобранный jar получает новый процесс. Новая сборка на том же месте
 * останавливает процесс прежней. Локальная сборка (без тега релиза)
 * запускается с копии, иначе живой процесс не даёт пересобрать jar на Windows.
 */
export class MdSparrowResidentPool {
	private readonly residents = new Map<string, PoolEntry>();
	private readonly unsupported = new Set<string>();
	private readonly timing: ResidentTiming;
	private staleCopiesSwept = false;

	constructor(private readonly options: ResidentPoolOptions) {
		this.timing = { ...RESIDENT_TIMING, ...options.timing };
	}

	/** Выполняет запрос резидентом сборки или разовым запуском. */
	async run(runtime: MdSparrowRuntime, request: ResidentRequest): Promise<MdSparrowRunResult> {
		const identity = await jarIdentity(runtime);
		if (identity === undefined || this.unsupported.has(identity)) {
			return this.options.runOnce(runtime, request);
		}
		const key = slotOf(runtime);
		let entry = this.residents.get(key);
		if (entry && entry.identity !== identity) {
			this.options.log.info(`сменилась сборка или java, перезапускаем резидент: ${runtime.jarPath}`);
			this.residents.delete(key);
			void entry.resident.stop('drain');
			entry = undefined;
		}
		if (!entry) {
			entry = { identity, resident: this.createResident(runtime, identity) };
			this.residents.set(key, entry);
		}
		try {
			return await entry.resident.run(request);
		} catch (error) {
			if (this.residents.get(key) === entry) {
				this.residents.delete(key);
			}
			if (error instanceof ResidentUnsupportedError) {
				this.unsupported.add(identity);
				return this.options.runOnce(runtime, request);
			}
			if (error instanceof ResidentStoppedError) {
				return this.options.runOnce(runtime, request);
			}
			throw error;
		}
	}

	/**
	 * Останавливает все резиденты; следующие запросы поднимут их заново.
	 *
	 * @param mode - Дорабатывать ли очереди
	 */
	async stopAll(mode: ResidentStopMode = 'drain'): Promise<void> {
		const entries = [...this.residents.values()];
		this.residents.clear();
		await Promise.all(entries.map((entry) => entry.resident.stop(mode)));
	}

	/** Процессы живых резидентов. */
	pids(): number[] {
		return [...this.residents.values()]
			.map((entry) => entry.resident.pid)
			.filter((pid): pid is number => pid !== undefined);
	}

	/** Сколько запросов ждёт отправки во всех резидентах. */
	queued(): number {
		return [...this.residents.values()].reduce((sum, entry) => sum + entry.resident.queued, 0);
	}

	dispose(): Promise<void> {
		return this.stopAll('now');
	}

	private createResident(runtime: MdSparrowRuntime, identity: string): MdSparrowResident {
		let copy: Promise<string | undefined> | undefined;
		return new MdSparrowResident({
			prepare: async () => {
				if (runtime.releaseTag) {
					return this.options.launch(runtime, runtime.jarPath);
				}
				copy ??= this.copyJar(runtime.jarPath, identity);
				return this.options.launch(runtime, (await copy) ?? runtime.jarPath);
			},
			retryable: this.options.retryable,
			log: this.options.log,
			label: runtime.jarPath,
			timing: this.timing,
			onStopped: async () => {
				const copied = await copy;
				if (copied) {
					// Снятый процесс отпускает файл не сразу
					await fs
						.rm(path.dirname(copied), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
						.catch(() => undefined);
				}
			},
		});
	}

	/** Копирует локальную сборку; при неудаче процесс запускается с исходного jar. */
	private async copyJar(jarPath: string, identity: string): Promise<string | undefined> {
		const tempRoot = this.options.tempRoot ?? os.tmpdir();
		if (!this.staleCopiesSwept) {
			this.staleCopiesSwept = true;
			await sweepStaleCopies(tempRoot);
		}
		try {
			const dir = await fs.mkdtemp(path.join(tempRoot, `${COPY_DIR_PREFIX}${process.pid}-`));
			const hash = createHash('sha1').update(identity).digest('hex').slice(0, 8);
			const target = path.join(dir, `md-sparrow-${hash}.jar`);
			await fs.copyFile(jarPath, target);
			return target;
		} catch (error) {
			this.options.log.warn(`копия сборки не создана, запуск с исходного jar: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}
}

/**
 * Место процесса в наборе.
 *
 * Jar из кэша релизов и java, выбранная расширением, занимают место независимо от пути:
 * новая версия из кэша сменяет процесс прежней. Сборки из разных путей в настройках
 * живут рядом.
 */
function slotOf(runtime: MdSparrowRuntime): string {
	const java = runtime.autoJava ? 'auto' : `path:${runtime.java}`;
	const jar = runtime.releaseTag === undefined ? `path:${runtime.jarPath}` : 'release';
	return `${java}\n${jar}`;
}

/** Отметка сборки: пути java и jar, размер и время изменения jar. */
async function jarIdentity(runtime: MdSparrowRuntime): Promise<string | undefined> {
	try {
		const stat = await fs.stat(runtime.jarPath);
		return `${runtime.java}|${runtime.jarPath}|${stat.size}|${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** Убирает копии, оставшиеся от завершившихся окон. */
async function sweepStaleCopies(tempRoot: string): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(tempRoot);
	} catch {
		return;
	}
	await Promise.all(
		entries.map(async (entry) => {
			const match = new RegExp(`^${COPY_DIR_PREFIX}(\\d+)-`).exec(entry);
			if (!match || processAlive(Number(match[1]))) {
				return;
			}
			await fs.rm(path.join(tempRoot, entry), { recursive: true, force: true }).catch(() => undefined);
		})
	);
}

function processAlive(pid: number): boolean {
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
