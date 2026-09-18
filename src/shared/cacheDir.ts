/**
 * Каталоги кэша внешних компонентов. Кэш общий для всех окон, и файлы компонента
 * может держать процесс другого окна.
 * @module cacheDir
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Префикс имени, под которым каталог ждёт удаления. */
const TRASH_PREFIX = '.trash-';

/** Коды, с которыми Windows не переименовывает каталог, пока в нём открыт файл. */
const BUSY_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Только что завершённый процесс отпускает файлы не сразу. */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 100;

/** Файлы компонента заняты процессом, которому они нужны. */
export class ComponentBusyError extends Error {
	constructor(label: string) {
		super(`Файлы ${label} заняты другим процессом, например в другом окне. Повторите позже.`);
		this.name = 'ComponentBusyError';
	}
}

/**
 * Удаляет каталог целиком или оставляет нетронутым.
 *
 * Каталог сначала переименовывается, удаляется уже отложенная копия. На Windows переименование
 * не проходит, пока в каталоге открыт хоть один файл, а удаление по файлам оставило бы
 * запущенному процессу полкаталога.
 *
 * @param dir - Каталог или файл
 * @returns false, если каталог занят
 */
export async function removeUnlessBusy(dir: string): Promise<boolean> {
	const trash = path.join(path.dirname(dir), `${TRASH_PREFIX}${randomBytes(6).toString('hex')}`);
	for (let attempt = 1; ; attempt++) {
		try {
			await fs.rename(dir, trash);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (code === 'ENOENT') {
				return true;
			}
			if (process.platform !== 'win32' || !BUSY_CODES.has(code)) {
				throw error;
			}
			if (attempt >= RENAME_ATTEMPTS) {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
		}
	}
	await fs.rm(trash, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
	return true;
}

/**
 * Жив ли процесс.
 *
 * @param pid - Идентификатор процесса
 */
export function processAlive(pid: number): boolean {
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
