/**
 * Общее для поиска установленных программ: переменные окружения, повторы путей, подкаталоги.
 *
 * @module installPaths
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Имена подкаталогов, включая ссылки на каталоги: у ссылки и junction `isDirectory()` ложно.
 *
 * @param directory - Каталог
 * @returns Имена; недоступный каталог даёт пустой список
 */
export function subdirectoryNames(directory: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => {
			if (entry.isDirectory()) {
				return true;
			}
			if (!entry.isSymbolicLink()) {
				return false;
			}
			try {
				return fs.statSync(path.join(directory, entry.name)).isDirectory();
			} catch {
				return false;
			}
		})
		.map((entry) => entry.name);
}

/**
 * Переменная окружения без учёта регистра имени: так её читает Windows.
 *
 * @param env - Окружение
 * @param name - Имя переменной
 * @returns Непустое значение или undefined
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const wanted = name.toLowerCase();
	const key = Object.keys(env).find((item) => item.toLowerCase() === wanted);
	const value = key === undefined ? undefined : env[key]?.trim();
	return value ? value : undefined;
}

/**
 * Убирает повторы путей: в Windows регистр, вид разделителя и завершающий разделитель не различаются.
 *
 * @param paths - Пути по порядку
 * @param platform - Платформа ОС
 * @returns Первые вхождения без завершающего разделителя
 */
export function uniquePaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of paths) {
		const trimmed = item.trim().replace(/(.)[\\/]+$/, '$1');
		const key = platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
		if (trimmed && !seen.has(key)) {
			seen.add(key);
			out.push(trimmed);
		}
	}
	return out;
}
