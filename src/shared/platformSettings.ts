/**
 * Каталоги установки платформы 1С с учётом настройки проекта.
 *
 * @module platformSettings
 */

import { platformInstallRoots } from './platformBinary';
import { projectConfiguration } from './projectConfiguration';
import { currentRoot } from './workspaceProjects';

/**
 * Каталоги установки платформы для проекта: настройка `platform.path` или найденные расширением.
 *
 * @param root - Корень проекта; по умолчанию текущий
 * @returns Каталоги по порядку проверки
 */
export function projectPlatformRoots(root: string | undefined = currentRoot()): string[] {
	return platformInstallRoots({ configured: projectConfiguration(root).get<string>('platform.path', '') });
}
