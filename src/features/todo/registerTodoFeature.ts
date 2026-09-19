import * as vscode from 'vscode';
import {
	onDidChangeCurrentProject,
	onDidChangeProjects,
	projectScanRoots,
} from '../../shared/workspaceProjects';
import {
	TodoPanelTreeDataProvider,
	type FilterScope,
} from './todoPanelView';
import { configuredTodoTags } from './todoScanner';

export interface RegisterTodoFeatureParams {
	todoPanelProvider: TodoPanelTreeDataProvider;
	isProjectRef: { current: boolean };
}

/**
 * Регистрирует команды и обработчики панели «1С: Список дел».
 */
export function registerTodoFeature(
	params: RegisterTodoFeatureParams
): vscode.Disposable[] {
	const { todoPanelProvider, isProjectRef } = params;

	const todoOpenLocationCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.openLocation',
		async (uriArg: string | vscode.Uri, line: number) => {
			const uri = typeof uriArg === 'string' ? vscode.Uri.parse(uriArg) : uriArg;
			const doc = await vscode.workspace.openTextDocument(uri);
			const lineIndex = Math.max(0, (line ?? 1) - 1);
			const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
			await vscode.window.showTextDocument(doc, { selection: range, preview: false });
		}
	);

	const todoShowPanelCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.showPanel',
		async () => {
			await vscode.commands.executeCommand('workbench.view.extension.1c-platform-tools-todo');
			await todoPanelProvider.refresh();
		}
	);

	const todoRefreshCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.refresh',
		async () => {
			await todoPanelProvider.refresh();
		}
	);

	const todoGroupByHierarchyKey = '1c-platform-tools.todo.groupByHierarchy';
	const updateTodoGroupByContext = (): void => {
		const groupBy = todoPanelProvider.getGroupByFile();
		void vscode.commands.executeCommand('setContext', todoGroupByHierarchyKey, groupBy);
	};

	const todoToggleGroupByCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.toggleGroupBy',
		async () => {
			const next = !todoPanelProvider.getGroupByFile();
			await todoPanelProvider.setGroupByFile(next);
			updateTodoGroupByContext();
		}
	);

	const todoViewAsListCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.viewAsList',
		async () => {
			await todoPanelProvider.setGroupByFile(false);
			updateTodoGroupByContext();
		}
	);

	const todoViewAsHierarchyCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.viewAsHierarchy',
		async () => {
			await todoPanelProvider.setGroupByFile(true);
			updateTodoGroupByContext();
		}
	);

	const todoClearFilterCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.clearFilter',
		async () => {
			await todoPanelProvider.clearAllFilters();
		}
	);

	type ScopeQuickPickItem = vscode.QuickPickItem & { scope: FilterScope };
	type TagQuickPickItem = vscode.QuickPickItem & { tag: string };
	const scopeItems: ScopeQuickPickItem[] = [
		{
			label: '$(folder-opened)  Весь проект',
			description: 'Все файлы по маске сканирования',
			scope: 'all',
		},
		{
			label: '$(file-text)  Текущий открытый файл',
			description: 'Только дела в активном редакторе',
			scope: 'currentFile',
		},
		{ label: '$(markdown)  Markdown', description: 'Файлы .md', scope: 'md' },
		{ label: '$(code)  BSL', description: 'Модули .bsl', scope: 'bsl' },
		{ label: '$(file-code)  OScript', description: 'Файлы .os', scope: 'os' },
		{
			label: '$(beaker)  Feature',
			description: 'Сценарии Gherkin .feature',
			scope: 'feature',
		},
	];
	const todoFilterByScopeCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.filterByScope',
		async () => {
			const tags = configuredTodoTags(projectScanRoots().map((scanRoot) => scanRoot.root));
			const scopeSet = new Set(scopeItems.map((i) => i.scope));
			const tagItems: TagQuickPickItem[] = tags.map((tag) => ({
				label: `$(tag)  ${tag}`,
				description: '',
				tag,
			}));
			const items: (
				| ScopeQuickPickItem
				| TagQuickPickItem
				| vscode.QuickPickItem
			)[] = [
				{ label: 'Область', kind: vscode.QuickPickItemKind.Separator },
				scopeItems[0],
				scopeItems[1],
				{ label: 'По типу файла', kind: vscode.QuickPickItemKind.Separator },
				...scopeItems.slice(2),
				{ label: 'Теги', kind: vscode.QuickPickItemKind.Separator },
				...tagItems,
			];
			const chosen = await vscode.window.showQuickPick(items, {
				title: 'Список дел: область или тег',
				placeHolder: 'Выберите одну область, тип файла или один тег',
				matchOnDescription: true,
			});
			if (chosen === undefined) {
				return;
			}
			if ('scope' in chosen && scopeSet.has(chosen.scope)) {
				await todoPanelProvider.setFilterScope(chosen.scope);
				await todoPanelProvider.setFilterTags(null);
			} else if ('tag' in chosen) {
				await todoPanelProvider.setFilterScope('all');
				await todoPanelProvider.setFilterTags([chosen.tag]);
			}
		}
	);

	const todoFilterByTagCommand = vscode.commands.registerCommand(
		'1c-platform-tools.todo.filterByTag',
		async () => {
			await vscode.commands.executeCommand('1c-platform-tools.todo.filterByScope');
		}
	);

	const onTodoActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(() => {
		if (todoPanelProvider.getFilterScope() === 'currentFile') {
			todoPanelProvider.refreshView();
		}
	});

	const onTodoRelevantSave = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (isProjectRef.current && doc.uri.scheme === 'file') {
			todoPanelProvider.documentSaved(doc);
		}
	});

	const pathsChanged = (uris: readonly vscode.Uri[], tree: boolean): void => {
		if (isProjectRef.current) {
			todoPanelProvider.pathsChanged(uris, tree);
		}
	};
	// Созданный, удалённый или переименованный каталог приходит одним событием без файлов под ним
	const todoFilesWatcher = vscode.workspace.createFileSystemWatcher('**/*');
	const onTodoFileCreate = todoFilesWatcher.onDidCreate((uri) => pathsChanged([uri], true));
	const onTodoFileChange = todoFilesWatcher.onDidChange((uri) => pathsChanged([uri], false));
	const onTodoFileDelete = todoFilesWatcher.onDidDelete((uri) => pathsChanged([uri], true));
	const onTodoFilesCreate = vscode.workspace.onDidCreateFiles((event) => pathsChanged(event.files, true));
	const onTodoFilesDelete = vscode.workspace.onDidDeleteFiles((event) => pathsChanged(event.files, true));
	const onTodoFilesRename = vscode.workspace.onDidRenameFiles((event) =>
		pathsChanged(event.files.flatMap((file) => [file.oldUri, file.newUri]), true)
	);

	const onProjectsChange = onDidChangeProjects(() => todoPanelProvider.projectsChanged());
	const onCurrentProjectChange = onDidChangeCurrentProject(() => todoPanelProvider.currentProjectChanged());

	return [
		todoOpenLocationCommand,
		todoShowPanelCommand,
		todoRefreshCommand,
		todoToggleGroupByCommand,
		todoViewAsListCommand,
		todoViewAsHierarchyCommand,
		todoFilterByTagCommand,
		todoFilterByScopeCommand,
		todoClearFilterCommand,
		todoPanelProvider.onDidChangeTreeData(updateTodoGroupByContext),
		onTodoActiveEditorChange,
		onTodoRelevantSave,
		todoFilesWatcher,
		onTodoFileCreate,
		onTodoFileChange,
		onTodoFileDelete,
		onTodoFilesCreate,
		onTodoFilesDelete,
		onTodoFilesRename,
		onProjectsChange,
		onCurrentProjectChange,
		todoPanelProvider,
	];
}
