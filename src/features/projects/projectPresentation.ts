/**
 * Подписи проектов для панелей, окна выбора и строки состояния.
 * @module projects/projectPresentation
 */

import { SOURCE_FORMAT_LABELS } from '../../shared/activeConfiguration';
import type { SourceRoot } from '../../shared/projectLayout';
import {
	projectDisplayName,
	sameProjectRoot,
	type ProjectCandidate,
	type WorkspaceProject,
} from '../../shared/workspaceProjects';

const SEPARATOR = ' · ';

/** Проект текущий: корень выбора совпадает с корнем проекта. */
export function isCurrentProject(project: WorkspaceProject, selectedRoot: string | undefined): boolean {
	return selectedRoot !== undefined && sameProjectRoot(project.root, selectedRoot);
}

/** Формат и имя конфигурации. */
export function configurationParts(configuration: SourceRoot | undefined): string[] {
	if (!configuration) {
		return [];
	}
	return [SOURCE_FORMAT_LABELS[configuration.format], configuration.name].filter((part) => part.length > 0);
}

/** Что добавить в описание строки проекта. */
export interface ProjectDescriptionDetails {
	/** Путь подпроекта от корневого проекта. */
	location?: string;
	/** Имя активного профиля. */
	profile?: string;
}

/**
 * Описание строки проекта: «текущий», путь от корневого проекта, формат, конфигурация, профиль.
 *
 * @param project - Проект
 * @param current - Проект текущий
 * @param details - Путь и профиль
 */
export function projectDescription(project: WorkspaceProject, current: boolean, details: ProjectDescriptionDetails = {}): string {
	return [
		...(current ? ['текущий'] : []),
		...(details.location ? [details.location] : []),
		...configurationParts(project.configuration),
		...(details.profile ? [details.profile] : []),
	].join(SEPARATOR);
}

/** Подсказка проекта: путь, формат, конфигурация. */
export function projectTooltip(project: WorkspaceProject): string {
	const lines = [project.root];
	if (project.configuration) {
		lines.push(`Формат: ${SOURCE_FORMAT_LABELS[project.configuration.format]}`);
		if (project.configuration.name) {
			lines.push(`Конфигурация: ${project.configuration.name}`);
		}
	}
	return lines.join('\n');
}

/** Имя не проекта для показа: совпадающие имена различаются. */
export function candidateName(candidate: ProjectCandidate): string {
	return candidate.displayName ?? candidate.name;
}

/** Описание не проекта. */
export function candidateDescription(candidate: ProjectCandidate): string {
	return [
		...(candidate.kind === 'extraConfiguration' ? ['вторая конфигурация'] : []),
		...configurationParts(candidate.configuration),
	].join(SEPARATOR);
}

/** Подсказка не проекта: каталог packagedef и каталог конфигурации. */
export function candidateTooltip(candidate: ProjectCandidate): string {
	const lines = [candidate.root];
	if (!sameProjectRoot(candidate.configuration.dir, candidate.root)) {
		lines.push(`Конфигурация: ${candidate.configuration.dir}`);
	}
	return lines.join('\n');
}

/**
 * Текущий проект окна среди найденных.
 *
 * @param projects - Проекты окна
 * @param selectedRoot - Выбранный корень
 */
export function findCurrentProject(
	projects: readonly WorkspaceProject[],
	selectedRoot: string | undefined
): WorkspaceProject | undefined {
	return projects.find((project) => isCurrentProject(project, selectedRoot));
}

/** Имя текущего проекта, когда проектов больше одного. */
export function multipleProjectsCurrentName(
	projects: readonly WorkspaceProject[],
	selectedRoot: string | undefined
): string | undefined {
	if (projects.length <= 1) {
		return undefined;
	}
	const project = findCurrentProject(projects, selectedRoot);
	return project ? projectDisplayName(project, projects) : undefined;
}
