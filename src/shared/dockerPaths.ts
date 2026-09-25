/**
 * Пути запуска vrunner в контейнере: что видит раннер и где это лежит на хосте.
 *
 * Каталог проекта монтируется в `/workspace`, другие каталоги хоста контейнеру
 * не видны, если их не смонтировать отдельно.
 *
 * @module dockerPaths
 */

import * as path from 'node:path';

/** Каталог проекта внутри контейнера. */
export const CONTAINER_WORKSPACE = '/workspace';

/** Каталог хоста, смонтированный в контейнер. */
export interface DockerMount {
	/** Путь на хосте */
	host: string;
	/** Путь в контейнере */
	container: string;
}

/**
 * Лежит ли путь внутри каталога или совпадает с ним.
 *
 * @param dir - Каталог
 * @param target - Проверяемый путь
 */
export function isInsideDir(dir: string, target: string): boolean {
	const relative = path.relative(dir, target);
	return relative === '' || (relative.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
	return value.replaceAll('\\', '/');
}

/**
 * Путь хоста так, как его видит контейнер.
 *
 * @param hostPath - Абсолютный путь на хосте
 * @param mounts - Смонтированные каталоги
 * @returns Путь в контейнере или undefined, если каталог не смонтирован
 */
export function containerPath(hostPath: string, mounts: readonly DockerMount[]): string | undefined {
	for (const mount of mounts) {
		if (isInsideDir(mount.host, hostPath)) {
			const relative = toPosix(path.relative(mount.host, hostPath));
			return relative === '' ? mount.container : `${mount.container}/${relative}`;
		}
	}
	return undefined;
}

/** Значение в строке параметров платформы: путь в кавычках или слово. */
const TEXT_TOKEN = /"([^"]*)"|[^\s"]+/g;

/**
 * Значения строки параметров платформы (`--additional`): пути в кавычках и слова.
 *
 * @param text - Строка параметров
 */
export function textTokens(text: string): string[] {
	return [...text.matchAll(TEXT_TOKEN)].map((match) => match[1] ?? match[0]);
}

/**
 * Переводит пути хоста внутри строки параметров платформы (`--additional`) в пути контейнера.
 *
 * @param text - Строка параметров: путь с пробелами стоит в кавычках
 * @param mounts - Смонтированные каталоги
 * @returns Строка с путями контейнера
 */
export function containerPathsInText(text: string, mounts: readonly DockerMount[]): string {
	return text.replace(TEXT_TOKEN, (token: string, quoted: string | undefined) => {
		const value = quoted ?? token;
		const inContainer = path.isAbsolute(value) ? containerPath(value, mounts) : undefined;
		if (inContainer === undefined) {
			return token;
		}
		return quoted === undefined ? inContainer : `"${inContainer}"`;
	});
}

/**
 * Путь хоста вне смонтированных каталогов, на который указывает аргумент.
 *
 * Путём считается только то, что есть на хосте само или своим каталогом:
 * ключи платформы вида `/DisableStartupMessages` под это не попадают.
 *
 * @param arg - Аргумент команды
 * @param mounts - Смонтированные каталоги
 * @param exists - Проверка существования пути на хосте
 * @returns Путь, недоступный контейнеру, или undefined
 */
export function hostPathOutside(
	arg: string,
	mounts: readonly DockerMount[],
	exists: (target: string) => boolean
): string | undefined {
	if (!path.isAbsolute(arg)) {
		return undefined;
	}
	const posix = toPosix(arg);
	if (mounts.some((mount) => posix === mount.container || posix.startsWith(`${mount.container}/`))) {
		return undefined;
	}
	if (containerPath(arg, mounts) !== undefined) {
		return undefined;
	}
	const parent = path.dirname(arg);
	const onHost = exists(arg) || (parent !== path.parse(arg).root && exists(parent));
	return onHost ? arg : undefined;
}

/**
 * Каталог файловой базы из строки подключения, если он лежит вне каталога проекта.
 *
 * @param connection - Строка подключения: `/F./build/ib`, `/FC:\bases\erp`, `/Ssrv\erp`
 * @param root - Каталог проекта, от него отсчитывается относительный путь базы
 * @returns Путь базы из строки подключения или undefined
 */
export function fileInfobaseOutside(connection: string, root: string): string | undefined {
	const match = /^\/F\s*"?([^";]+?)"?\s*;?\s*$/i.exec(connection.trim());
	if (!match) {
		return undefined;
	}
	return isInsideDir(root, path.resolve(root, match[1])) ? undefined : match[1];
}

/**
 * Путь каталога проекта для тома `docker run`.
 *
 * При docker-outside-of-docker демон видит пути хоста, а не контейнера разработки;
 * путь папки рабочей области на хосте приходит в `LOCAL_WORKSPACE_FOLDER`.
 *
 * @param root - Каталог проекта
 * @param folderRoot - Папка рабочей области, в которой лежит проект
 * @param localWorkspaceFolder - Значение `LOCAL_WORKSPACE_FOLDER`
 */
export function dockerMountSource(
	root: string,
	folderRoot: string | undefined,
	localWorkspaceFolder: string | undefined
): string {
	if (!localWorkspaceFolder || folderRoot === undefined || !isInsideDir(folderRoot, root)) {
		return root;
	}
	const relative = path.relative(folderRoot, root);
	if (relative === '') {
		return localWorkspaceFolder;
	}
	const windowsHost = /^[A-Za-z]:[\\/]/.test(localWorkspaceFolder) || localWorkspaceFolder.startsWith('\\\\');
	return windowsHost
		? path.win32.join(localWorkspaceFolder, relative)
		: path.posix.join(localWorkspaceFolder, toPosix(relative));
}
