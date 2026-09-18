/**
 * Поиск утилиты администрирования кластера (rac).
 *
 * rac входит в поставку платформы и лежит рядом с остальными бинарями, поэтому
 * каталоги установки и выбор версии берутся из общего поиска платформы.
 *
 * rac запускается локально и общается с сервером администрирования по сети,
 * так что для управления удалённым кластером достаточно локальной платформы.
 */

import {
	listPlatformVersionsInRoots,
	PLATFORM_PATH_SETTING_TITLE,
	platformBinaryFileName,
	resolvePlatformBinaryInRoots,
} from '../../shared/platformBinary';

/** Итог поиска rac. */
export interface RacLookup {
	/** Путь к найденному файлу или undefined. */
	binary?: string;
	/** Каталоги, в которых велся поиск (для сообщения об ошибке). */
	bases: string[];
}

/**
 * Находит rac в каталогах установки платформы.
 *
 * @param roots - Каталоги установки платформы
 * @param requestedVersion - Версия платформы или её префикс (пусто — наибольшая)
 * @param platform - Платформа ОС
 * @returns Найденный путь и перебранные каталоги
 */
export function findRac(
	roots: readonly string[],
	requestedVersion?: string,
	platform: NodeJS.Platform = process.platform
): RacLookup {
	return {
		binary: resolvePlatformBinaryInRoots(roots, 'rac', { requestedVersion: requestedVersion || undefined, platform }),
		bases: [...roots],
	};
}

/**
 * Перечисляет версии платформы, в которых есть rac.
 *
 * Список предлагается в форме подключения: администратор выбирает версию из
 * установленных, а не вспоминает номер. Каталоги те же, что и при поиске
 * утилиты, поэтому предложенная версия точно запустится.
 *
 * @param roots - Каталоги установки платформы
 * @param platform - Платформа ОС
 * @returns Версии от новых к старым, без повторов
 */
export function listRacVersions(roots: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
	return listPlatformVersionsInRoots(roots, 'rac', platform);
}

/**
 * Составляет сообщение о том, что rac не найден.
 *
 * @param lookup - Итог поиска
 * @returns Текст с перечислением проверенных каталогов
 */
export function describeRacNotFound(lookup: RacLookup): string {
	const fileName = platformBinaryFileName('rac', process.platform);
	const bases = lookup.bases.length > 0 ? lookup.bases.join(', ') : 'каталоги установки не определены';
	return (
		`Утилита ${fileName} не найдена. Проверены каталоги: ${bases}. ` +
		`Укажите каталог установки платформы в настройке ${PLATFORM_PATH_SETTING_TITLE}.`
	);
}
