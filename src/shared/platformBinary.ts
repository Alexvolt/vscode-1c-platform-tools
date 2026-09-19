import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cestartConfigValues, readPlatformText, startupDirectory } from './infobaseList';
import { envValue, subdirectoryNames, uniquePaths } from './installPaths';

/**
 * Поиск установленной платформы 1С:Предприятие и её исполняемых файлов.
 *
 * Каталоги установки перечисляет {@link platformInstallRoots}: запуск баз, автономный
 * сервер, rac, отладка и сводка окружения берут их только отсюда.
 *
 * Раскладка бинарей зависит от ОС и способа установки:
 *
 * - Windows: `<база>/<версия>/bin/<имя>` (например `C:/Program Files/1cv8/8.3.27.1936/bin/ibsrv.exe`);
 * - Linux (.deb-пакеты): `<база>/<версия>/<имя>` без каталога `bin`
 *   (например `/opt/1cv8/x86_64/8.5.1.1343/ibsrv`);
 * - Linux (.run-инсталлятор): `<база>/<имя>` — бинарь прямо в каталоге установки,
 *   без подкаталога версии (например `/opt/1C/v8.3/x86_64/ibsrv`);
 * - macOS: как в Linux, но каталог архитектуры чаще `arm64`.
 *
 * Поэтому резолвер проверяет и `bin/<имя>`, и `<имя>` в каждом каталоге версии,
 * а если каталогов версий нет — ищет бинарь прямо в базе.
 */

/** Инструмент платформы, который ищем. */
export type PlatformTool = 'ibsrv' | 'ibcmd' | 'rac' | '1cv8' | '1cv8c';

/** Настройка `platform.path` в сообщениях: с этих слов начинается её описание в package.json. */
export const PLATFORM_PATH_SETTING_TITLE = '«Каталог установки платформы 1С»';

/** Исполняемые файлы, по которым каталог версии считается установленной платформой. */
const INSTALLATION_MARKERS: readonly PlatformTool[] = ['1cv8', '1cv8c', 'ibcmd', 'ibsrv', 'rac'];

/** Каталог версии платформы: ровно четыре числовых сегмента (8.3.27.1936). */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Является ли имя каталога версией платформы (например, '8.3.27.1936').
 *
 * Отсекает служебные каталоги установки (common, conf, srvinfo и т.п.).
 *
 * @param name - Имя каталога
 * @returns true, если это каталог версии платформы
 */
export function is1cVersionDir(name: string): boolean {
	return VERSION_DIR_RE.test(name);
}

/**
 * Сравнивает две версии платформы посегментно (числовое сравнение).
 *
 * @returns -1 если a < b, 0 если равны, 1 если a > b
 */
export function compare1cVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) {
			return da < db ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Имя исполняемого файла инструмента с учётом ОС.
 *
 * @param tool - Инструмент платформы
 * @param platform - Платформа ОС (process.platform)
 * @returns Имя файла (например, 'ibsrv.exe' на Windows, 'ibsrv' иначе)
 */
export function platformBinaryFileName(tool: PlatformTool, platform: NodeJS.Platform): string {
	return platform === 'win32' ? `${tool}.exe` : tool;
}

/**
 * Выбирает версию платформы из доступных.
 *
 * Если запрошена конкретная версия и она есть — возвращается она. Если запрос
 * задан как префикс (например, '8.3.27'), берётся наибольшая подходящая версия.
 * Если запрос не задан — наибольшая из доступных.
 *
 * @param versions - Доступные версии (имена каталогов)
 * @param requested - Запрошенная версия или её префикс (опционально)
 * @returns Выбранная версия или undefined, если подходящей нет
 */
export function pickPlatformVersion(versions: string[], requested?: string): string | undefined {
	const valid = versions.filter(is1cVersionDir);
	if (valid.length === 0) {
		return undefined;
	}

	const sortedDesc = [...valid].sort((a, b) => compare1cVersions(b, a));

	if (requested && requested.trim()) {
		const target = requested.trim();
		if (sortedDesc.includes(target)) {
			return target;
		}
		// Префиксный запрос: '8.3.27' → наибольшая 8.3.27.*
		const prefix = target.endsWith('.') ? target : `${target}.`;
		const prefixed = sortedDesc.find((v) => v.startsWith(prefix));
		return prefixed;
	}

	return sortedDesc[0];
}

/**
 * Разворачивает `${env:NAME}` в пути каталога установки платформы.
 *
 * VS Code подставляет переменные конфигурации отладки уже после
 * resolveDebugConfiguration, поэтому для чтения каталога версий раскрываем
 * `${env:PROGRAMFILES}` и подобные самостоятельно.
 *
 * @param dir - Путь, возможно содержащий `${env:NAME}`
 * @returns Путь с раскрытыми переменными окружения
 */
export function expandEnvPlaceholders(dir: string): string {
	return dir.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? '');
}

/**
 * Выбирает конкретную версию платформы (каталог `8.3.27.1936`) в каталоге
 * установки, учитывая запрошенную версию или её префикс.
 *
 * В отличие от {@link resolvePlatformBinary} не проверяет наличие бинаря —
 * нужен просто выбор версии (например, для поля `platformVersion` отладчика).
 *
 * @param baseDir - Каталог с версиями платформ (может содержать `${env:NAME}`)
 * @param requested - Запрошенная версия или префикс (опционально)
 * @returns Конкретная версия или undefined, если каталог недоступен/пуст
 */
export function resolvePlatformVersion(baseDir: string, requested?: string): string | undefined {
	return pickPlatformVersion(subdirectoryNames(expandEnvPlaceholders(baseDir)), requested);
}

/**
 * Каталог архитектуры в путях установки платформы.
 *
 * 1С называет каталоги по своей схеме, отличной от `process.arch`: `x86_64`
 * вместо `x64` и `i386` вместо `ia32`. Имя `arm64` совпадает.
 *
 * @param arch - Архитектура процессора (process.arch)
 * @returns Имя каталога архитектуры
 */
export function platformArchDir(arch: string): string {
	if (arch === 'arm64') {
		return 'arm64';
	}
	if (arch === 'ia32' || arch === 'x86') {
		return 'i386';
	}
	return 'x86_64';
}

/**
 * Каталоги установки платформы по умолчанию (перебираются по порядку).
 *
 * В Windows установщик ставит платформу «для компьютера» в `1cv8` внутри Program Files,
 * а «для пользователя» в `%LOCALAPPDATA%\Programs`, где 64-разрядной сборке
 * достаётся каталог `1cv8_x64`.
 *
 * На Linux и macOS раскладка зависит от способа установки, поэтому кандидатов
 * несколько: `/opt/1cv8/<арх>` (.deb-пакеты и macOS, версии подкаталогами) и
 * `/opt/1C/v8.3/<арх>` (.run-инсталлятор, бинари прямо в каталоге). Первым идёт
 * каталог архитектуры текущей машины, затем `x86_64` — на нём стоит платформа,
 * запущенная через трансляцию.
 *
 * @param platform - Платформа ОС (по умолчанию process.platform)
 * @param arch - Архитектура процессора (по умолчанию process.arch)
 * @param env - Окружение (по умолчанию process.env)
 * @returns Список каталогов-кандидатов
 */
export function defaultPlatformBasePaths(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	env: NodeJS.ProcessEnv = process.env
): string[] {
	if (platform === 'win32') {
		const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
		const programFilesX86 = envValue(env, 'ProgramFiles(x86)');
		const userProfile = envValue(env, 'USERPROFILE');
		const localAppData =
			envValue(env, 'LOCALAPPDATA') ?? (userProfile ? path.join(userProfile, 'AppData', 'Local') : undefined);
		const candidates = [path.join(programFiles, '1cv8')];
		if (programFilesX86) {
			candidates.push(path.join(programFilesX86, '1cv8'));
		}
		if (localAppData) {
			candidates.push(path.join(localAppData, 'Programs', '1cv8_x64'), path.join(localAppData, 'Programs', '1cv8'));
		}
		return uniquePaths(candidates, platform);
	}
	const archDir = platformArchDir(arch);
	const candidates = [
		`/opt/1cv8/${archDir}`,
		'/opt/1cv8/x86_64',
		`/opt/1C/v8.3/${archDir}`,
		'/opt/1C/v8.3/x86_64',
	];
	return [...new Set(candidates)];
}

/**
 * Файлы настроек стартера, куда установщик пишет каталог установки (`InstalledLocation`).
 *
 * Установка «для компьютера» пишет в общий файл, «для пользователя» в файл профиля.
 *
 * @param platform - Платформа ОС
 * @param env - Окружение
 * @param home - Домашний каталог
 * @returns Пути к `1cestart.cfg`, общий первым
 */
export function cestartConfigFiles(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir()
): string[] {
	const own = path.join(startupDirectory(platform, home, env), '1cestart.cfg');
	if (platform !== 'win32') {
		return [own];
	}
	const allUsers = envValue(env, 'ALLUSERSPROFILE') ?? envValue(env, 'ProgramData');
	return allUsers ? [path.join(allUsers, '1C', '1CEStart', '1cestart.cfg'), own] : [own];
}

/** Откуда брать каталоги установки платформы. */
export interface PlatformRootsOptions {
	/** Каталог из настройки: если задан, ищем только в нём. */
	readonly configured?: string;
	/** Платформа ОС (по умолчанию process.platform). */
	readonly platform?: NodeJS.Platform;
	/** Архитектура процессора (по умолчанию process.arch). */
	readonly arch?: string;
	/** Окружение (по умолчанию process.env). */
	readonly env?: NodeJS.ProcessEnv;
	/** Домашний каталог (по умолчанию os.homedir()). */
	readonly home?: string;
}

/**
 * Каталоги установки платформы по порядку проверки.
 *
 * Заданный в настройке каталог единственный. Без него сначала идут каталоги из
 * `InstalledLocation` файлов стартера, затем места установки по умолчанию.
 *
 * @param options - Настройка и окружение
 * @returns Каталоги без повторов; существование не проверяется
 */
export function platformInstallRoots(options: PlatformRootsOptions = {}): string[] {
	const configured = options.configured?.trim();
	if (configured) {
		return [configured];
	}
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const fromStarter = cestartConfigFiles(platform, env, options.home ?? os.homedir()).flatMap((file) => {
		const text = readPlatformText(file);
		return text === undefined ? [] : cestartConfigValues(text, 'InstalledLocation');
	});
	return uniquePaths([...fromStarter, ...defaultPlatformBasePaths(platform, options.arch ?? process.arch, env)], platform);
}

/**
 * Ищет бинарь в конкретном каталоге, учитывая опциональный подкаталог `bin`.
 *
 * @param dir - Каталог (базовый или версии)
 * @param fileName - Имя файла бинаря
 * @returns Полный путь или undefined
 */
function binaryInDir(dir: string, fileName: string): string | undefined {
	const withBin = path.join(dir, 'bin', fileName);
	if (fsSync.existsSync(withBin)) {
		return withBin;
	}
	const direct = path.join(dir, fileName);
	if (fsSync.existsSync(direct)) {
		return direct;
	}
	return undefined;
}

/**
 * Перечисляет установленные версии платформы, у которых есть нужный бинарь.
 *
 * Нужно там, где версию выбирает пользователь: предлагать список установленных
 * честнее, чем просить вспомнить номер. Версии без бинаря не показываются —
 * выбрать их всё равно нельзя.
 *
 * @param baseDir - Каталог установки платформы
 * @param tool - Инструмент платформы
 * @param platform - Платформа ОС (по умолчанию process.platform)
 * @returns Версии от новых к старым
 */
export function listPlatformVersions(
	baseDir: string,
	tool: PlatformTool,
	platform: NodeJS.Platform = process.platform
): string[] {
	return [...versionBinaries(baseDir, platformBinaryFileName(tool, platform)).keys()].sort((a, b) =>
		compare1cVersions(b, a)
	);
}

/**
 * Каталоги версий с нужным бинарём.
 *
 * @param baseDir - Каталог установки
 * @param fileName - Имя файла бинаря
 * @returns Версия и путь к бинарю
 */
function versionBinaries(baseDir: string, fileName: string): Map<string, string> {
	const byVersion = new Map<string, string>();
	for (const name of subdirectoryNames(baseDir).filter(is1cVersionDir)) {
		const found = binaryInDir(path.join(baseDir, name), fileName);
		if (found) {
			byVersion.set(name, found);
		}
	}
	return byVersion;
}

/**
 * Версии с нужным бинарём во всех каталогах установки.
 *
 * @param roots - Каталоги установки
 * @param tool - Инструмент платформы
 * @param platform - Платформа ОС
 * @returns Версии от новых к старым, без повторов
 */
export function listPlatformVersionsInRoots(
	roots: readonly string[],
	tool: PlatformTool,
	platform: NodeJS.Platform = process.platform
): string[] {
	const versions = new Set(roots.flatMap((root) => listPlatformVersions(root, tool, platform)));
	return [...versions].sort((a, b) => compare1cVersions(b, a));
}

/**
 * Находит бинарь среди нескольких каталогов установки.
 *
 * Версия выбирается сразу по всем каталогам: платформа, поставленная для
 * пользователя, и платформа в Program Files равноправны. Одна и та же версия в
 * двух каталогах берётся из того, что идёт раньше. Каталог без каталогов версий
 * проверяется как раскладка .run-инсталлятора.
 *
 * @param roots - Каталоги установки по порядку
 * @param tool - Инструмент платформы
 * @param options - Версия и ОС
 * @returns Полный путь к бинарю или undefined
 */
export function resolvePlatformBinaryInRoots(
	roots: readonly string[],
	tool: PlatformTool,
	options: ResolvePlatformBinaryOptions = {}
): string | undefined {
	const fileName = platformBinaryFileName(tool, options.platform ?? process.platform);
	const byVersion = new Map<string, string>();
	for (const root of roots) {
		for (const [version, binary] of versionBinaries(root, fileName)) {
			if (!byVersion.has(version)) {
				byVersion.set(version, binary);
			}
		}
	}
	const version = pickPlatformVersion([...byVersion.keys()], options.requestedVersion);
	if (version) {
		return byVersion.get(version);
	}
	for (const root of roots) {
		const direct = binaryInDir(root, fileName);
		if (direct) {
			return direct;
		}
	}
	return undefined;
}

/** Выбранная версия и каталог установки, в котором она лежит. */
export interface PlatformVersionLocation {
	/** Каталог установки с каталогами версий. */
	readonly root: string;
	/** Имя каталога версии. */
	readonly version: string;
}

/**
 * Выбирает версию платформы среди каталогов установки.
 *
 * Отладчик получает каталог с версиями и имя версии, а не путь к бинарю, поэтому
 * здесь нужен каталог, где выбранная версия лежит.
 *
 * @param roots - Каталоги установки по порядку
 * @param requested - Версия или её префикс; пусто: наибольшая
 * @returns Каталог и версия или undefined
 */
export function resolvePlatformVersionInRoots(
	roots: readonly string[],
	requested?: string
): PlatformVersionLocation | undefined {
	const rootByVersion = new Map<string, string>();
	for (const root of roots) {
		for (const name of subdirectoryNames(root).filter(is1cVersionDir)) {
			if (!rootByVersion.has(name)) {
				rootByVersion.set(name, root);
			}
		}
	}
	const version = pickPlatformVersion([...rootByVersion.keys()], requested);
	const root = version === undefined ? undefined : rootByVersion.get(version);
	return version === undefined || root === undefined ? undefined : { root, version };
}

/** Найденная установка платформы для сводки. */
export interface PlatformInstallation {
	/** Каталог установки. */
	readonly root: string;
	/** Версии от новых к старым; пусто у раскладки без каталогов версий. */
	readonly versions: string[];
}

/**
 * Установки платформы в каталогах: версии, где есть хотя бы один исполняемый файл платформы.
 *
 * @param roots - Каталоги установки
 * @param platform - Платформа ОС
 * @returns Только каталоги, где платформа нашлась
 */
export function describePlatformInstallations(
	roots: readonly string[],
	platform: NodeJS.Platform = process.platform
): PlatformInstallation[] {
	const out: PlatformInstallation[] = [];
	for (const root of roots) {
		const versions = new Set(INSTALLATION_MARKERS.flatMap((tool) => listPlatformVersions(root, tool, platform)));
		if (versions.size > 0) {
			out.push({ root, versions: [...versions].sort((a, b) => compare1cVersions(b, a)) });
		} else if (INSTALLATION_MARKERS.some((tool) => binaryInDir(root, platformBinaryFileName(tool, platform)))) {
			out.push({ root, versions: [] });
		}
	}
	return out;
}

/** Опции поиска бинаря платформы. */
export interface ResolvePlatformBinaryOptions {
	/** Запрошенная версия платформы или её префикс (пусто — наибольшая доступная). */
	requestedVersion?: string;
	/** Платформа ОС (по умолчанию process.platform). */
	platform?: NodeJS.Platform;
}

/**
 * Находит путь к исполняемому файлу платформы в каталоге установки.
 *
 * Сначала перебирает каталоги версий (у которых реально присутствует нужный
 * бинарь — в `bin/` или напрямую) и выбирает версию через
 * {@link pickPlatformVersion}. Если каталогов версий нет, ищет бинарь прямо в
 * базе (раскладка .run-инсталлятора на Linux, где версия из пути не читается).
 *
 * @param baseDir - Каталог установки платформы (например, `C:\Program Files\1cv8`)
 * @param tool - Инструмент платформы (ibsrv/ibcmd)
 * @param options - Опции (версия, ОС)
 * @returns Полный путь к бинарю или undefined, если не найден
 */
export function resolvePlatformBinary(
	baseDir: string,
	tool: PlatformTool,
	options: ResolvePlatformBinaryOptions = {}
): string | undefined {
	return resolvePlatformBinaryInRoots([baseDir], tool, options);
}
