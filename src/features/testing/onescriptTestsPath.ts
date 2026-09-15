import { DEFAULT_TESTING } from '../../shared/pathDefaults';
import { projectConfiguration } from '../../shared/projectConfiguration';
import { testsDirectoryName } from '../../shared/projectLayout';
import { currentRoot } from '../../shared/workspaceProjects';

/**
 * Каталог тестов OneScript относительно корня проекта.
 *
 * Скриптовые тесты маркеров не имеют, поэтому каталог задаётся настройкой
 * `test.path.onescriptTests`; пустая настройка значит каталог тестов.
 *
 * @param root - Корень проекта, чьи настройки читаются
 */
export function resolveOnescriptTestsPath(root: string | undefined = currentRoot()): string {
	const configured = projectConfiguration(root)
		.get<string>('test.path.onescriptTests', DEFAULT_TESTING.onescriptTestsPath)
		.trim();
	return configured.length > 0 ? configured : testsDirectoryName(root);
}
