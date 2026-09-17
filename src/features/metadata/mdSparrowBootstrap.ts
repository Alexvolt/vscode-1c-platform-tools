/**
 * Загрузка fat-JAR md-sparrow с GitHub Releases (через общий {@link githubReleaseLoader})
 * и portable JRE 21 (Eclipse Temurin).
 * @module mdSparrowBootstrap
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import { globSync } from 'glob';
import { logger } from '../../shared/logger';
import { projectConfiguration } from '../../shared/projectConfiguration';
import { currentRoot } from '../../shared/workspaceProjects';
import {
	type ReleaseComponentSpec,
	cachedReleaseComponent,
	cachedReleaseTag,
	checkReleaseUpdateInBackground,
	clearReleaseCache,
	ensureReleaseComponent,
	extractArchive,
	installBaseDir,
	resolveGithubToken,
	showStatus,
	streamDownload,
} from '../../shared/githubReleaseLoader';
import {
	MD_SPARROW_DEFAULT_REPO,
	MD_SPARROW_JAR_REGEX,
	adoptiumBinaryUrl,
} from './mdSparrowConstants';
import { stopMdSparrowResidents } from './mdSparrowRunner';

const log = logger.scope('md-sparrow');

export interface MdSparrowRuntime {
	/** Полный путь к исполняемому java */
	java: string;
	/** Полный путь к md-sparrow-*-all.jar */
	jarPath: string;
	/** Тег релиза (если скачан с GitHub) */
	releaseTag?: string;
	/** Java не указана в настройках: её путь меняется вместе с portable JRE. */
	autoJava?: boolean;
}

const MD_SPARROW_SPEC: ReleaseComponentSpec = {
	repoSlug: MD_SPARROW_DEFAULT_REPO,
	cacheSubdir: 'md-sparrow',
	stampName: '.jar-info.json',
	assetRegex: MD_SPARROW_JAR_REGEX,
	label: 'md-sparrow',
	extract: false,
	beforeReplace: () => stopMdSparrowResidents(),
};

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

async function ensurePortableJre(baseDir: string, download: boolean, javaOverride: string): Promise<string> {
	const trimmed = javaOverride.trim();
	if (trimmed) {
		return trimmed;
	}

	const jreRoot = path.join(baseDir, 'jre-temurin-21');
	const stamp = path.join(jreRoot, '.java-path');
	try {
		const prev = (await fs.readFile(stamp, 'utf8')).trim();
		if (prev && fssync.existsSync(prev)) {
			log.debug(`JRE из кэша: ${prev}`);
			return prev;
		}
	} catch {
		/* fetch fresh */
	}
	if (!download) {
		// автозагрузка выключена намеренно: работаем на java из PATH
		return 'java';
	}

	log.info('загрузка portable JRE 21 (Eclipse Temurin)…');
	const status = showStatus('md-sparrow: загружаем JRE 21...');
	try {
		await stopMdSparrowResidents();
		await fs.rm(jreRoot, { recursive: true, force: true }).catch(() => undefined);
		await fs.mkdir(jreRoot, { recursive: true });

		const dlDir = path.join(jreRoot, '_dl');
		await fs.mkdir(dlDir, { recursive: true });
		const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
		const archivePath = path.join(dlDir, `temurin-jre-21${ext}`);

		await streamDownload(adoptiumBinaryUrl(), archivePath, { 'User-Agent': 'vscode-1c-platform-tools' });

		const unpackDir = path.join(jreRoot, 'unpack');
		await fs.mkdir(unpackDir, { recursive: true });
		await extractArchive(archivePath, unpackDir);
		await fs.rm(archivePath, { force: true }).catch(() => undefined);

		const javaExe = findJavaUnder(unpackDir);
		if (!javaExe) {
			throw new Error('После распаковки JRE не найден bin/java');
		}
		await fs.writeFile(stamp, javaExe, 'utf8');
		log.info(`JRE готова: ${javaExe}`);
		return javaExe;
	} finally {
		status.dispose();
	}
}

async function ensureJar(
	baseDir: string,
	download: boolean,
	jarOverride: string,
	githubToken: string
): Promise<{ jarPath: string; tag?: string }> {
	const trimmed = jarOverride.trim();
	if (trimmed) {
		if (trimmed.includes('${')) {
			throw new Error('components.path.metadataJar: укажите полный путь к md-sparrow-*-all.jar.');
		}
		if (!fssync.existsSync(trimmed)) {
			throw new Error(
				`components.path.metadataJar не найден: ${trimmed}. Соберите артефакт: в каталоге md-sparrow выполните ./gradlew shadowJar (build/libs/md-sparrow-*-all.jar).`
			);
		}
		return { jarPath: trimmed };
	}
	if (!download) {
		const cached = await cachedReleaseComponent(baseDir, MD_SPARROW_SPEC);
		if (cached) {
			return { jarPath: cached.assetPath, tag: cached.tag };
		}
		throw new Error('Укажите components.path.metadataJar или включите components.autoload.metadataJar.');
	}

	const ensured = await ensureReleaseComponent(baseDir, MD_SPARROW_SPEC, githubToken);
	return { jarPath: ensured.assetPath, tag: ensured.tag };
}

/**
 * Гарантирует наличие JRE и JAR согласно настройкам проекта.
 *
 * @param context - Контекст расширения
 * @param root - Корень проекта, для которого читаются настройки компонентов
 * @returns Пути к java и jar с тегом релиза
 */
export async function ensureMdSparrowRuntime(
	context: vscode.ExtensionContext,
	root: string | undefined = currentRoot()
): Promise<MdSparrowRuntime> {
	const cfg = projectConfiguration(root);
	const download = cfg.get<boolean>('components.autoload.metadataJar', true);
	const downloadJre = cfg.get<boolean>('components.autoload.java', true);
	const jarPathSetting = cfg.get<string>('components.path.metadataJar', '').trim();
	const javaPathSetting = cfg.get<string>('components.path.java', '').trim();
	if (javaPathSetting.includes('${')) {
		throw new Error('components.path.java: укажите полный путь к java или оставьте поле пустым.');
	}

	const base = installBaseDir(context);
	// Параллельные обращения с одинаковыми настройками ждут одну подготовку
	const java = await preparedOnce(`jre|${base}|${downloadJre}|${javaPathSetting}`, async () => {
		await fs.mkdir(base, { recursive: true });
		return ensurePortableJre(base, downloadJre, javaPathSetting);
	});
	const { jarPath, tag } = await preparedOnce(`jar|${base}|${download}|${jarPathSetting}`, () =>
		ensureJar(base, download, jarPathSetting, resolveGithubToken())
	);

	return { java, jarPath, releaseTag: tag, autoJava: javaPathSetting === '' };
}

/** Идущие сейчас подготовки по ключу настроек. */
const preparationsInFlight = new Map<string, Promise<unknown>>();

/**
 * Запускает подготовку, если с тем же ключом она ещё не идёт.
 *
 * @param key - Что готовится и с какими настройками
 * @param prepare - Подготовка
 */
function preparedOnce<T>(key: string, prepare: () => Promise<T>): Promise<T> {
	const running = preparationsInFlight.get(key) as Promise<T> | undefined;
	if (running !== undefined) {
		return running;
	}
	const started = prepare().finally(() => {
		preparationsInFlight.delete(key);
	});
	preparationsInFlight.set(key, started);
	return started;
}

/**
 * Фоновая проверка наличия нового релиза md-sparrow; при обнаружении чистит кэш JAR и зовёт колбэк.
 *
 * @param context - Контекст расширения
 * @param onUpdateApplied - Вызывается после очистки кэша
 * @param root - Корень проекта, для которого читаются настройки компонентов
 */
export function checkMdSparrowUpdateInBackground(
	context: vscode.ExtensionContext,
	onUpdateApplied: () => void,
	root: string | undefined = currentRoot()
): void {
	// Компоненты не качаются в недоверенной папке: дальше их запускает Java
	if (!vscode.workspace.isTrusted) {
		return;
	}
	const cfg = projectConfiguration(root);
	if (cfg.get<string>('components.path.metadataJar', '').trim()) {
		return;
	}
	if (!cfg.get<boolean>('components.autoload.metadataJar', true)) {
		return;
	}
	checkReleaseUpdateInBackground(installBaseDir(context), MD_SPARROW_SPEC, resolveGithubToken(), onUpdateApplied);
}

/**
 * Загружает jar md-sparrow, не глядя на `components.path.metadataJar` и автозагрузку.
 *
 * @param context - Контекст расширения
 * @returns Путь к загруженному jar
 */
export async function downloadMdSparrowJar(context: vscode.ExtensionContext): Promise<string> {
	const ensured = await ensureReleaseComponent(installBaseDir(context), MD_SPARROW_SPEC, resolveGithubToken());
	return ensured.assetPath;
}

/**
 * Загружает portable JRE, не глядя на `components.path.java` и автозагрузку.
 *
 * @param context - Контекст расширения
 * @returns Путь к java
 */
export async function downloadPortableJre(context: vscode.ExtensionContext): Promise<string> {
	const base = installBaseDir(context);
	await fs.mkdir(base, { recursive: true });
	return ensurePortableJre(base, true, '');
}

/** Тег релиза md-sparrow в кэше; undefined — не загружен. */
export async function cachedMdSparrowTag(context: vscode.ExtensionContext): Promise<string | undefined> {
	return cachedReleaseTag(installBaseDir(context), MD_SPARROW_SPEC);
}

/** Путь JAR md-sparrow в кэше; undefined — не загружен. */
export async function cachedMdSparrowPath(context: vscode.ExtensionContext): Promise<string | undefined> {
	return (await cachedReleaseComponent(installBaseDir(context), MD_SPARROW_SPEC))?.assetPath;
}

/** Сброс кэша JAR — следующий вызов ensure скачает заново. */
export async function clearMdSparrowJarCache(context: vscode.ExtensionContext): Promise<void> {
	await clearReleaseCache(installBaseDir(context), MD_SPARROW_SPEC);
}

/** Есть ли в кэше portable JRE. */
export function portableJreCached(context: vscode.ExtensionContext): boolean {
	return fssync.existsSync(path.join(installBaseDir(context), 'jre-temurin-21', '.java-path'));
}

/**
 * Версия загруженной portable JRE или undefined.
 *
 * Берётся из имени распакованного каталога (`jdk-21.0.12.1+1-jre`): отдельного
 * файла с версией у сборки нет.
 *
 * @param context - Контекст расширения
 * @returns Версия JRE или undefined, если она не загружена
 */
export function portableJreVersion(context: vscode.ExtensionContext): string | undefined {
	const unpackDir = path.join(installBaseDir(context), 'jre-temurin-21', 'unpack');
	try {
		const entry = fssync.readdirSync(unpackDir).find((name) => name.startsWith('jdk-'));
		return entry?.replace(/^jdk-/, '').replace(/-jre$/, '');
	} catch {
		return undefined;
	}
}

/**
 * Путь к java загруженной portable JRE.
 *
 * @param context - Контекст расширения
 * @returns Путь или undefined, если JRE не загружена
 */
export function portableJreJavaPath(context: vscode.ExtensionContext): string | undefined {
	const stamp = path.join(installBaseDir(context), 'jre-temurin-21', '.java-path');
	try {
		const previous = fssync.readFileSync(stamp, 'utf8').trim();
		return previous !== '' && fssync.existsSync(previous) ? previous : undefined;
	} catch {
		return undefined;
	}
}

/** Сброс кэша portable JRE — скачается заново при следующем использовании дерева метаданных. */
export async function clearPortableJreCache(context: vscode.ExtensionContext): Promise<void> {
	await stopMdSparrowResidents();
	await fs.rm(path.join(installBaseDir(context), 'jre-temurin-21'), { recursive: true, force: true }).catch(() => undefined);
}
