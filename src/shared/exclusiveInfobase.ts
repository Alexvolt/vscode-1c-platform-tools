/**
 * Монопольный доступ к файловой информационной базе.
 *
 * Пока базу держит автономный сервер, конфигуратор её не откроет: загрузка,
 * выгрузка и обновление конфигурации БД падают. Держатель базы регистрируется
 * тем, кто её занял, а команды на время работы просят освободить ту базу, с
 * которой работают сами.
 *
 * @module exclusiveInfobase
 */

import * as path from 'node:path';
import type { VRunnerIntent } from './vrunnerCli/intents';

/** Тот, кто держит файловую базу открытой. */
export interface InfobaseHolder {
	/** Название для сообщений: «Автономный сервер остановлен на время загрузки». */
	readonly label: string;
	/** Абсолютный путь базы, которую держатель занимает сейчас; undefined, когда не держит. */
	heldInfobase(): string | undefined;
	/** Отпускает базу; false - отпустить не удалось. */
	release(): Promise<boolean>;
	/** Занимает базу снова после команды. */
	restore(): Promise<void>;
}

const holders = new Set<InfobaseHolder>();

/**
 * Регистрирует держателя базы.
 *
 * @param holder - Держатель
 * @returns Отмена регистрации
 */
export function registerInfobaseHolder(holder: InfobaseHolder): { dispose(): void } {
	holders.add(holder);
	return {
		dispose: () => {
			holders.delete(holder);
		},
	};
}

/**
 * Ключ базы: абсолютный путь, на Windows без учёта регистра.
 *
 * @param infobase - Каталог файловой базы
 */
export function infobaseKey(infobase: string): string {
	const resolved = path.resolve(infobase);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Держатель, который занимает эту базу сейчас.
 *
 * @param infobase - Абсолютный путь каталога файловой базы
 */
export function infobaseHolder(infobase: string): InfobaseHolder | undefined {
	const key = infobaseKey(infobase);
	for (const holder of holders) {
		const held = holder.heldInfobase();
		if (held !== undefined && infobaseKey(held) === key) {
			return holder;
		}
	}
	return undefined;
}

/**
 * Строка журнала перед командой, которой нужна база: с чем она работает.
 *
 * @param project - Имя проекта
 * @param profile - Файл настроек профиля запуска
 * @param connection - Строка подключения к базе
 */
export function exclusiveInfobaseLogLine(project: string, profile: string, connection: string): string {
	return `Проект: ${project}, профиль: ${profile}, база: ${connection}`;
}

/**
 * Виды намерений, которым нужен монопольный доступ к базе: платформа открывает
 * базу проекта своим процессом, а занятую другим процессом она не откроет.
 *
 * Команды кластера (`session.*`, `jobs.*`) работают с серверными базами, к
 * файловой они неприменимы.
 */
const EXCLUSIVE_INTENT_KINDS: ReadonlySet<VRunnerIntent['kind']> = new Set([
	'infobase.init',
	'infobase.updateDb',
	'infobase.updateExtension',
	'infobase.dumpDt',
	'infobase.restoreDt',
	'infobase.listExtensions',
	'cf.loadFromSrc',
	'cf.loadFileToIb',
	'cf.dumpIbToSrc',
	'cf.unloadIbToCf',
	'cf.makeDist',
	'cfe.loadFromSrc',
	'cfe.loadFromCfeFile',
	'cfe.dumpIbToSrc',
	'cfe.unloadIbToCfe',
	'run.designer',
	'run.enterprise',
	'test.vanessa',
	'test.xunit',
	'validate.syntaxCheck',
]);

/**
 * Сборка и разборка файлов: vanessa-runner выполняет их в базе из строки
 * подключения, а без строки создаёт временную.
 */
const FILE_INTENT_KINDS: ReadonlySet<VRunnerIntent['kind']> = new Set([
	'cf.build',
	'cf.decompileFile',
	'cfe.buildCfe',
	'cfe.decompileCfeFile',
	'epf.build',
	'epf.decompile',
]);

/** Сборка cf и cfe и разборка cf-файла, которые CLI 2.x всегда ведёт во временной базе. */
const CLI2_TEMPORARY_INTENT_KINDS: ReadonlySet<VRunnerIntent['kind']> = new Set([
	'cf.build',
	'cf.decompileFile',
	'cfe.buildCfe',
]);

/** Установленный vanessa-runner и подключение команды. */
export interface InfobaseRun {
	/** Команды строятся для CLI 3.x. */
	readonly cli3: boolean;
	/** Строка подключения задана вызовом, перекрытием профиля или файлом настроек. */
	readonly connectionSet: boolean;
}

/**
 * Нужен ли намерению монопольный доступ к информационной базе.
 *
 * Разбор cfe-файла CLI 2.x выполняет загрузкой расширения в базу проекта.
 *
 * @param kind - Вид намерения vrunner
 * @param run - Установленный vanessa-runner и подключение команды
 * @returns true, если на время выполнения базу нужно освободить
 */
export function needsExclusiveInfobase(kind: VRunnerIntent['kind'], run: InfobaseRun): boolean {
	if (!run.cli3 && CLI2_TEMPORARY_INTENT_KINDS.has(kind)) {
		return false;
	}
	if (!run.cli3 && kind === 'cfe.decompileCfeFile') {
		return true;
	}
	if (FILE_INTENT_KINDS.has(kind)) {
		return run.connectionSet;
	}
	return EXCLUSIVE_INTENT_KINDS.has(kind);
}

/**
 * Нужен ли монопольный доступ хотя бы одному намерению цепочки.
 *
 * @param intents - Намерения, которые выполнит команда
 * @param run - Установленный vanessa-runner и подключение команды
 * @returns true, если базу нужно освободить на время всей цепочки
 */
export function anyNeedsExclusiveInfobase(intents: readonly VRunnerIntent[], run: InfobaseRun): boolean {
	return intents.some((intent) => needsExclusiveInfobase(intent.kind, run));
}

/**
 * Останется ли база занятой после завершения команды.
 *
 * `--no-wait` отпускает конфигуратор или предприятие жить дальше: vrunner
 * завершается сразу, а базу продолжает держать само приложение 1С.
 *
 * @param intents - Намерения, которые выполнит команда
 * @returns true, если возвращать базу держателю по завершении команды нельзя
 */
export function keepsInfobaseAfterRun(intents: readonly VRunnerIntent[]): boolean {
	return intents.some((intent) => 'noWait' in intent && intent.noWait === true);
}
