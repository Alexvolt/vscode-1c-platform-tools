import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Значение переменной окружения без учёта регистра имени: на Windows PATH
 * хранится как `Path`.
 *
 * @param env - Окружение
 * @param name - Имя переменной
 * @returns Значение или undefined
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

/** Запускаемый файл: на POSIX нужен бит исполнения. */
function isExecutableFile(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) {
			return false;
		}
		if (process.platform !== 'win32') {
			fs.accessSync(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Находит программу так, как её находит оболочка: каталоги PATH по порядку, на
 * Windows имя дополняется расширениями из PATHEXT.
 *
 * Путь с каталогом не ищется в PATH, а берётся от каталога запуска и тоже
 * дополняется расширениями, если своего у него нет.
 *
 * @param name - Имя программы или путь к ней
 * @param env - Окружение, чей PATH просматривается
 * @param cwd - Каталог, от которого считается относительный путь
 * @returns Абсолютный путь к файлу или undefined, если программы нет
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string | undefined {
	const extensions = process.platform === 'win32'
		? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
		: [];
	const candidates = (base: string): string[] =>
		process.platform === 'win32' && path.extname(base) === ''
			? extensions.map((ext) => base + ext.toLowerCase())
			: [base];

	if (path.isAbsolute(name) || name.includes('/') || name.includes(path.sep)) {
		return candidates(path.resolve(cwd, name)).find(isExecutableFile);
	}

	for (const dir of (envValue(env, 'PATH') ?? '').split(path.delimiter)) {
		if (dir.trim() === '') {
			continue;
		}
		const found = candidates(path.join(dir.replace(/^"(.*)"$/, '$1'), name)).find(isExecutableFile);
		if (found) {
			return found;
		}
	}
	return undefined;
}
