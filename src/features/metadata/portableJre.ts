/**
 * Кэш portable JRE, общий для всех окон.
 *
 * Каждая загрузка ложится в свой каталог, а штамп с путём к java переключается, когда JRE
 * распакована целиком: JRE, запущенную в другом окне, новая не задевает. Каталог назван
 * номером процесса, который его заполняет; пока процесс жив, другие окна каталог не убирают.
 * @module portableJre
 */

import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { ComponentBusyError, processAlive, removeUnlessBusy } from '../../shared/cacheDir';
import { logger } from '../../shared/logger';

const log = logger.scope('md-sparrow');

/** Файл с путём к java текущей JRE. */
const JAVA_STAMP = '.java-path';

/** Каталоги, которые этот процесс сейчас заполняет. */
const installing = new Set<string>();

/** Кэши, которые этот процесс уже убирал. */
const tidied = new Set<string>();

/**
 * Кладёт JRE в пустой каталог.
 *
 * @param dir - Каталог установки
 */
export type JreUnpack = (dir: string) => Promise<void>;

function readStamp(jreRoot: string): string | undefined {
	try {
		const java = fssync.readFileSync(path.join(jreRoot, JAVA_STAMP), 'utf8').trim();
		return java === '' ? undefined : java;
	} catch {
		return undefined;
	}
}

/**
 * Путь к java текущей JRE.
 *
 * @param jreRoot - Каталог кэша JRE
 * @returns Путь или undefined, если JRE не загружена
 */
export function cachedJava(jreRoot: string): string | undefined {
	const java = readStamp(jreRoot);
	return java !== undefined && fssync.existsSync(java) ? java : undefined;
}

/**
 * Версия текущей JRE.
 *
 * Берётся из имени распакованного каталога (`jdk-21.0.12.1+1-jre`): отдельного
 * файла с версией у сборки нет.
 *
 * @param jreRoot - Каталог кэша JRE
 * @returns Версия или undefined, если JRE не загружена
 */
export function cachedJreVersion(jreRoot: string): string | undefined {
	const installDir = installDirOf(jreRoot, cachedJava(jreRoot));
	if (installDir === undefined) {
		return undefined;
	}
	try {
		const entry = fssync.readdirSync(installDir).find((name) => name.startsWith('jdk-'));
		return entry?.replace(/^jdk-/, '').replace(/-jre$/, '');
	} catch {
		return undefined;
	}
}

/**
 * Ставит JRE в новый каталог и делает её текущей.
 *
 * @param jreRoot - Каталог кэша JRE
 * @param unpack - Кладёт JRE в каталог установки
 * @returns Путь к java новой JRE
 */
export async function installJre(jreRoot: string, unpack: JreUnpack): Promise<string> {
	await fs.mkdir(jreRoot, { recursive: true });
	const stampBefore = readStamp(jreRoot);
	const installDir = await fs.mkdtemp(path.join(jreRoot, `${process.pid}-`));
	installing.add(installDir);
	try {
		let java: string | undefined;
		try {
			await unpack(installDir);
			java = findJavaUnder(installDir);
			if (java === undefined) {
				throw new Error('После распаковки JRE не найден bin/java');
			}
		} catch (error) {
			await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
		// Пока шла загрузка, JRE могло поставить другое окно: своя копия не нужна
		const installedMeanwhile = cachedJava(jreRoot);
		if (installedMeanwhile !== undefined && installedMeanwhile !== stampBefore) {
			log.info(`JRE уже поставлена другим окном: ${installedMeanwhile}`);
			await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
			return installedMeanwhile;
		}
		await writeStamp(jreRoot, java);
		await dropUnused(jreRoot, installDir);
		return java;
	} finally {
		installing.delete(installDir);
	}
}

/**
 * Забывает текущую JRE и убирает её каталог.
 *
 * @param jreRoot - Каталог кэша JRE
 * @throws ComponentBusyError - JRE запущена, кэш не тронут
 */
export async function clearJre(jreRoot: string): Promise<void> {
	const current = installDirOf(jreRoot, readStamp(jreRoot));
	if (current !== undefined && !(await removeUnlessBusy(current))) {
		throw new ComponentBusyError('JRE');
	}
	await fs.rm(path.join(jreRoot, JAVA_STAMP), { force: true });
	await dropUnused(jreRoot, undefined);
}

/** Штамп читают другие окна: он заменяется целиком. */
async function writeStamp(jreRoot: string, java: string): Promise<void> {
	const stamp = path.join(jreRoot, JAVA_STAMP);
	const draft = `${stamp}.${process.pid}`;
	await fs.writeFile(draft, java, 'utf8');
	await fs.rename(draft, stamp);
}

/** Каталог установки, в котором лежит java. */
function installDirOf(jreRoot: string, java: string | undefined): string | undefined {
	if (java === undefined) {
		return undefined;
	}
	const relative = path.relative(jreRoot, java);
	if (relative === '' || path.isAbsolute(relative) || relative.startsWith('..')) {
		return undefined;
	}
	return path.join(jreRoot, relative.split(path.sep)[0]);
}

/**
 * Раз за сеанс убирает в фоне каталоги завершившихся окон и оборванных установок.
 *
 * @param jreRoot - Каталог кэша JRE
 */
export function tidyJreCache(jreRoot: string): void {
	if (!tidied.has(jreRoot)) {
		void dropUnused(jreRoot, undefined).catch(() => undefined);
	}
}

/**
 * Убирает каталоги, кроме текущей JRE и заполняемых сейчас. Занятые остаются до следующей уборки.
 *
 * @param jreRoot - Каталог кэша JRE
 * @param keep - Каталог, который остаётся в любом случае
 */
async function dropUnused(jreRoot: string, keep: string | undefined): Promise<void> {
	tidied.add(jreRoot);
	let entries: fssync.Dirent[];
	try {
		entries = await fs.readdir(jreRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(jreRoot, entry.name);
		if (!entry.isDirectory() || full === keep || installing.has(full) || filledByOtherProcess(entry.name)) {
			continue;
		}
		// Штамп перечитывается: другое окно могло переключить его на свой каталог
		if (full === installDirOf(jreRoot, readStamp(jreRoot))) {
			continue;
		}
		if (!(await removeUnlessBusy(full).catch(() => false))) {
			log.debug(`JRE: каталог оставлен: ${full}`);
		}
	}
}

/** Каталог назван номером другого живого процесса. */
function filledByOtherProcess(name: string): boolean {
	const owner = /^(\d+)-/.exec(name);
	if (!owner) {
		return false;
	}
	const pid = Number(owner[1]);
	return pid !== process.pid && processAlive(pid);
}

function findJavaUnder(extractRoot: string): string | undefined {
	if (process.platform === 'win32') {
		const hits = globSync('**/bin/java.exe', { cwd: extractRoot, absolute: true, nocase: true });
		return hits[0];
	}
	const hits = globSync('**/bin/java', { cwd: extractRoot, absolute: true });
	for (const p of hits) {
		try {
			if (fssync.statSync(p).isFile()) {
				return p;
			}
		} catch {
			/* skip */
		}
	}
	return undefined;
}
