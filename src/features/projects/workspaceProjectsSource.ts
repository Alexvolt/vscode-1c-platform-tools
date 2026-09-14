/**
 * Проекты окна для панелей и команд «1С: Проекты».
 * @module projects/workspaceProjectsSource
 */

import * as vscode from 'vscode';
import {
	createProjectFile,
	currentRoot,
	listCandidates,
	listProjects,
	onDidChangeCurrentProject,
	onDidChangeProjects,
	outsideProject,
	projectsSnapshot,
	refreshProjects,
	selectProject,
	type CreateProjectFileOptions,
	type CurrentProjectChange,
	type ProjectCandidate,
	type WorkspaceFolderRef,
	type WorkspaceProject,
	type WorkspaceProjects,
	type WorkspaceProjectsSnapshot,
} from '../../shared/workspaceProjects';

/** Проекты, не проекты и выбор текущего проекта. */
export interface WorkspaceProjectsSource {
	snapshotNow(): WorkspaceProjectsSnapshot;
	listProjects(): Promise<WorkspaceProject[]>;
	listCandidates(): Promise<ProjectCandidate[]>;
	/** Выбранный корень без корня вызова. */
	selectedRoot(): string | undefined;
	selectProject(root: string): Promise<boolean>;
	createProjectFile(dir: string, options?: CreateProjectFileOptions): Promise<string>;
	/** Находит проекты заново. */
	refresh(): Promise<void>;
	/** Папки рабочей области. */
	folders(): WorkspaceFolderRef[];
	readonly onDidChangeProjects: vscode.Event<void>;
	readonly onDidChangeCurrentProject: vscode.Event<CurrentProjectChange>;
}

function windowFolders(): WorkspaceFolderRef[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === 'file')
		.map((folder) => ({ name: folder.name, root: folder.uri.fsPath }));
}

/** Проекты окна расширения. */
export function workspaceProjectsSource(): WorkspaceProjectsSource {
	return {
		snapshotNow: projectsSnapshot,
		listProjects,
		listCandidates,
		selectedRoot: () => outsideProject(currentRoot),
		selectProject,
		createProjectFile,
		refresh: refreshProjects,
		folders: windowFolders,
		onDidChangeProjects,
		onDidChangeCurrentProject,
	};
}

/**
 * Проекты отдельного экземпляра.
 *
 * @param instance - Экземпляр со своими папками
 * @param folders - Папки экземпляра
 */
export function instanceProjectsSource(
	instance: WorkspaceProjects,
	folders: () => readonly WorkspaceFolderRef[]
): WorkspaceProjectsSource {
	return {
		snapshotNow: () => instance.snapshotNow(),
		listProjects: () => instance.listProjects(),
		listCandidates: () => instance.listCandidates(),
		selectedRoot: () => outsideProject(() => instance.currentRoot()),
		selectProject: (root) => instance.selectProject(root),
		createProjectFile: (dir, options) => instance.createProjectFile(dir, options),
		refresh: async () => {
			await instance.refresh();
		},
		folders: () => [...folders()],
		onDidChangeProjects: instance.onDidChangeProjects,
		onDidChangeCurrentProject: instance.onDidChangeCurrentProject,
	};
}
