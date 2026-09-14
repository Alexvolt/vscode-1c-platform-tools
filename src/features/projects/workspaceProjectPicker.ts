/**
 * Окно выбора текущего проекта.
 * @module projects/workspaceProjectPicker
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	projectDisplayName,
	projectRootKey,
	type ProjectCandidate,
	type WorkspaceProject,
	type WorkspaceProjectsSnapshot,
} from '../../shared/workspaceProjects';
import { candidateDescription, candidateName, isCurrentProject, projectDescription } from './projectPresentation';
import type { WorkspaceProjectsSource } from './workspaceProjectsSource';

/** Что выбрано в окне. */
export type WorkspaceProjectPick =
	| { kind: 'project'; root: string }
	| { kind: 'candidate'; candidate: ProjectCandidate };

/** Пункт окна выбора. */
export interface WorkspaceProjectPickItem extends vscode.QuickPickItem {
	pick?: WorkspaceProjectPick;
}

/** Корневой проект и его подпроекты. */
interface ProjectGroup {
	root: WorkspaceProject;
	subProjects: WorkspaceProject[];
}

/** Проекты по корневым проектам в порядке списка. */
function projectGroups(projects: readonly WorkspaceProject[]): ProjectGroup[] {
	const byKey = new Map(projects.map((project) => [projectRootKey(project.root), project]));
	const topOf = (project: WorkspaceProject): WorkspaceProject => {
		let top = project;
		while (top.parent !== undefined) {
			const parent = byKey.get(projectRootKey(top.parent));
			if (!parent || parent === top) {
				break;
			}
			top = parent;
		}
		return top;
	};
	const groups = new Map<string, ProjectGroup>();
	for (const project of projects) {
		const top = topOf(project);
		const key = projectRootKey(top.root);
		const group = groups.get(key) ?? { root: top, subProjects: [] };
		groups.set(key, group);
		if (project !== top) {
			group.subProjects.push(project);
		}
	}
	return [...groups.values()];
}

/** Путь подпроекта от корневого проекта через `/`. */
function locationIn(root: WorkspaceProject, project: WorkspaceProject): string {
	return path.relative(root.root, project.root).split(path.sep).join('/');
}

/**
 * Проекты окна по корневым проектам с отметкой текущего.
 *
 * @param snapshot - Найденное
 * @param selectedRoot - Выбранный корень
 * @param separators - Разделитель с именем корневого проекта, когда их несколько
 */
export function workspaceProjectItems(
	snapshot: WorkspaceProjectsSnapshot,
	selectedRoot: string | undefined,
	separators = true
): WorkspaceProjectPickItem[] {
	const items: WorkspaceProjectPickItem[] = [];
	const groups = projectGroups(snapshot.projects);
	const projectItem = (project: WorkspaceProject, group: ProjectGroup): WorkspaceProjectPickItem => {
		const current = isCurrentProject(project, selectedRoot);
		const top = project === group.root;
		return {
			label: top ? projectDisplayName(project, snapshot.projects) : project.name,
			description: projectDescription(project, current, top ? {} : { location: locationIn(group.root, project) }),
			iconPath: new vscode.ThemeIcon(current ? 'check' : top ? 'repo' : 'file-submodule'),
			pick: { kind: 'project', root: project.root },
		};
	};
	for (const group of groups) {
		if (separators && groups.length > 1) {
			items.push({ label: projectDisplayName(group.root, snapshot.projects), kind: vscode.QuickPickItemKind.Separator });
		}
		items.push(projectItem(group.root, group), ...group.subProjects.map((project) => projectItem(project, group)));
	}
	return items;
}

/**
 * Пункты окна выбора: проекты по корневым проектам, затем не проекты за разделителем.
 *
 * @param snapshot - Найденное
 * @param selectedRoot - Выбранный корень
 */
export function projectPickItems(
	snapshot: WorkspaceProjectsSnapshot,
	selectedRoot: string | undefined
): WorkspaceProjectPickItem[] {
	const items = workspaceProjectItems(snapshot, selectedRoot);
	if (snapshot.candidates.length > 0) {
		items.push({ label: 'Не проекты', kind: vscode.QuickPickItemKind.Separator });
		for (const candidate of snapshot.candidates) {
			items.push({
				label: candidateName(candidate),
				description: candidateDescription(candidate),
				iconPath: new vscode.ThemeIcon(candidate.kind === 'extraConfiguration' ? 'warning' : 'folder'),
				pick: { kind: 'candidate', candidate },
			});
		}
	}
	return items;
}

/**
 * Показывает окно выбора сразу с известными проектами и дополняет его, когда обнаружение закончится.
 *
 * @param source - Проекты окна
 * @returns выбранное; undefined, если окно закрыто или выбирать нечего
 */
export async function pickWorkspaceProject(
	source: WorkspaceProjectsSource,
	onEmpty: () => void
): Promise<WorkspaceProjectPick | undefined> {
	const initial = source.snapshotNow();
	const quickPick = vscode.window.createQuickPick<ReturnType<typeof projectPickItems>[number]>();
	quickPick.title = 'Выбрать проект';
	quickPick.placeholder = 'Проект, с которым работают команды и панели';
	quickPick.matchOnDescription = true;
	quickPick.items = projectPickItems(initial, source.selectedRoot());
	quickPick.busy = !initial.complete;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (pick: WorkspaceProjectPick | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			quickPick.dispose();
			resolve(pick);
		};
		quickPick.onDidAccept(() => finish(quickPick.selectedItems[0]?.pick));
		quickPick.onDidHide(() => finish(undefined));
		void Promise.all([source.listProjects(), source.listCandidates()]).then(
			() => {
				if (settled) {
					return;
				}
				quickPick.items = projectPickItems(source.snapshotNow(), source.selectedRoot());
				quickPick.busy = false;
				if (quickPick.items.length === 0) {
					finish(undefined);
					onEmpty();
				}
			},
			() => {
				quickPick.busy = false;
			}
		);
		quickPick.show();
	});
}
