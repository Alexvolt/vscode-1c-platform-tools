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
 * Сборка и разборка файлов (`cf.build`, `cf.decompileFile`, `cfe.buildCfe`)
 * сюда не входит: vanessa-runner выполняет их во временной базе, базу проекта
 * такие команды не трогают. Команды кластера (`session.*`, `jobs.*`) работают
 * с серверными базами, к файловой они неприменимы.
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
	'cfe.decompileCfeFile',
	'epf.build',
	'epf.decompile',
	'run.designer',
	'run.enterprise',
	'test.vanessa',
	'test.xunit',
	'validate.syntaxCheck',
]);

/**
 * Нужен ли намерению монопольный доступ к информационной базе.
 *
 * @param kind - Вид намерения vrunner
 * @returns true, если на время выполнения базу нужно освободить
 */
export function needsExclusiveInfobase(kind: VRunnerIntent['kind']): boolean {
	return EXCLUSIVE_INTENT_KINDS.has(kind);
}

/**
 * Нужен ли монопольный доступ хотя бы одному намерению цепочки.
 *
 * @param intents - Намерения, которые выполнит команда
 * @returns true, если базу нужно освободить на время всей цепочки
 */
export function anyNeedsExclusiveInfobase(intents: readonly VRunnerIntent[]): boolean {
	return intents.some((intent) => needsExclusiveInfobase(intent.kind));
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
