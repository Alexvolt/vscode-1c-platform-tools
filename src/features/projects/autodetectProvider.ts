/**
 * TreeDataProvider для вкладки «Все проекты» (автообнаружение по packagedef).
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { OneCLocator } from './oneCLocator';
import type { ProjectsStack } from './stack';
import { sortProjects } from './sorter';
import { ProjectNode } from './nodes';
import type { ProjectKinds } from './projectKinds';
import { PROJECT_KIND_LABELS, type ProjectKind } from '../../shared/projectKind';
import { currentRoot, outsideProject, projectByRoot, sameProjectRoot } from '../../shared/workspaceProjects';

/**
 * Описание найденного проекта: открыт ли он в этом окне, вид проекта и различитель одинаковых имён.
 *
 * @param projectPath - Каталог проекта
 * @param selectedRoot - Текущий проект окна
 * @param duplicateHint - Различитель одинаковых имён
 * @param kind - Вид проекта
 */
export function autodetectDetail(
	projectPath: string,
	selectedRoot: string | undefined,
	duplicateHint: string | undefined,
	kind?: ProjectKind
): string | undefined {
	const inWindow = projectByRoot(projectPath) !== undefined;
	const marker = !inWindow
		? undefined
		: selectedRoot !== undefined && sameProjectRoot(projectPath, selectedRoot)
			? 'текущий'
			: 'в этом окне';
	const parts = [marker, kind && PROJECT_KIND_LABELS[kind], duplicateHint].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

function getDuplicateLabels(labels: string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const lb of labels) {
		const key = lb.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [key, n] of counts) {
		if (n > 1) {duplicates.add(key);}
	}
	return duplicates;
}

export class AutodetectProvider implements vscode.TreeDataProvider<ProjectNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly locator: OneCLocator,
		private readonly stack: ProjectsStack,
		private readonly kinds?: Pick<ProjectKinds, 'kindOf'>
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ProjectNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
		if (element) {
			return [];
		}
		const list = this.locator.projectList;
		if (list.length === 0) {
			return [];
		}
		const items = list.map((fullPath) => {
			const name = path.basename(fullPath) || fullPath;
			return { label: name, description: fullPath };
		});
		const sorted = sortProjects(items);
		const duplicateNames = getDuplicateLabels(sorted.map((p) => p.label));
		const selectedRoot = outsideProject(currentRoot);
		return sorted.map((prj) => {
			const kind = this.kinds?.kindOf(prj.description);
			return new ProjectNode(prj.label, vscode.TreeItemCollapsibleState.None, {
				name: prj.label,
				path: prj.description,
				detail: autodetectDetail(
					prj.description,
					selectedRoot,
					duplicateNames.has(prj.label.toLowerCase()) ? path.basename(path.dirname(prj.description)) : undefined,
					kind
				),
				kind,
			}, {
				command: '1c-platform-tools.projects.open',
				title: '',
				arguments: [prj.description, prj.label],
			});
		});
	}
}
