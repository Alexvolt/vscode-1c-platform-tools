import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TodoPanelTreeDataProvider } from '../features/todo/todoPanelView';
import { scanWorkspaceForTodos, type TodoEntry, type TodoScanResult } from '../features/todo/todoScanner';
import type { ProjectScanRoot } from '../shared/workspaceProjects';
import { createMockExtensionContext } from './fixtures/mocks/vscodeMocks';

/** Проект с подпроектом и зависимостями. */
const PROJECT = path.resolve(__dirname, '../../src/test/fixtures/workspaceScan/проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');

const WITHOUT_SUB_PROJECT: ProjectScanRoot[] = [{ root: PROJECT, excludeDirs: [] }];
const WITH_SUB_PROJECT: ProjectScanRoot[] = [
	{ root: PROJECT, excludeDirs: [SUB_PROJECT] },
	{ root: SUB_PROJECT, excludeDirs: [] },
];

suite('список дел: панель', () => {
	test('новый проект во время скана: скан повторяется с новым списком проектов', async function () {
		this.timeout(60_000);
		let roots = WITHOUT_SUB_PROJECT;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scanned: string[][] = [];
		const scan = async (): Promise<TodoScanResult> => {
			const scanRoots = roots;
			scanned.push(scanRoots.map((scanRoot) => scanRoot.root));
			if (scanned.length === 2) {
				await gate;
			}
			return scanWorkspaceForTodos(scanRoots);
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => roots);

		await provider.refresh();
		const running = provider.refresh();
		roots = WITH_SUB_PROJECT;
		provider.projectsChanged();
		release();
		await running;

		assert.deepStrictEqual(scanned, [[PROJECT], [PROJECT], [PROJECT, SUB_PROJECT]]);
		const groups = provider.getChildren().map((node) =>
			node.kind === 'project' ? [node.root, node.entries.map((entry) => entry.tag)] : node.kind
		);
		assert.deepStrictEqual(groups, [
			[PROJECT, ['TODO']],
			[SUB_PROJECT, ['FIXME']],
		]);
	});

	test('обновление во время скана с тем же списком проектов: найденное показывается, скан повторяется', async function () {
		this.timeout(60_000);
		const gates: (() => void)[] = [];
		let scans = 0;
		const scan = async (): Promise<TodoScanResult> => {
			scans += 1;
			await new Promise<void>((resolve) => gates.push(resolve));
			return scanWorkspaceForTodos(WITH_SUB_PROJECT);
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITH_SUB_PROJECT);

		const running = provider.refresh();
		void provider.refresh();
		await waitUntil(() => gates.length === 1);
		gates[0]();
		await waitUntil(() => gates.length === 2);

		assert.strictEqual(provider.getLastFilteredCount(), 2);
		gates[1]();
		await running;
		assert.strictEqual(scans, 2);
	});

	test('сохранённый файл: его дела заменяются без скана проектов', async function () {
		this.timeout(60_000);
		let scans = 0;
		const scan = (): Promise<TodoScanResult> => {
			scans += 1;
			return scanWorkspaceForTodos(WITH_SUB_PROJECT);
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITH_SUB_PROJECT);
		await provider.refresh();

		provider.documentSaved(savedDocument(path.join(PROJECT, 'tests', 'Проверка.os'), '// FIXME: первое\n\n// HACK: второе\n'));
		provider.documentSaved(savedDocument(path.join(SUB_PROJECT, 'tests', 'Подпроект.os'), 'Процедура Пусто()\n'));
		provider.documentSaved(savedDocument(path.join(PROJECT, 'oscript_modules', 'пакет', 'tests', 'Пакет.os'), '// TODO: зависимость\n'));

		assert.strictEqual(scans, 1);
		const groups = provider.getChildren().map((node) =>
			node.kind === 'project' ? [node.root, node.entries.map((entry) => `${entry.tag}:${entry.line}`)] : node.kind
		);
		assert.deepStrictEqual(groups, [[PROJECT, ['FIXME:1', 'HACK:3']]]);
	});

	test('сохранение до первого скана ничего не сканирует', () => {
		let scans = 0;
		const scan = async (): Promise<TodoScanResult> => {
			scans += 1;
			return { roots: [], entries: [] };
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITH_SUB_PROJECT);

		provider.documentSaved(savedDocument(path.join(PROJECT, 'tests', 'Проверка.os'), '// TODO: дело\n'));
		provider.pathsChanged([vscode.Uri.file(path.join(PROJECT, 'tests'))], true);

		assert.strictEqual(scans, 0);
		assert.strictEqual(provider.getLastFilteredCount(), 0);
		provider.dispose();
	});

	test('удалённые файл и каталог: их дела убираются без скана проектов', async function () {
		this.timeout(60_000);
		const found = await scanWorkspaceForTodos([WITH_SUB_PROJECT[0]]);
		const removed = (file: string): TodoEntry => ({ ...found.entries[0], uri: vscode.Uri.file(file) });
		let scans = 0;
		const scan = async (): Promise<TodoScanResult> => {
			scans += 1;
			return {
				roots: found.roots,
				entries: [
					...found.entries,
					removed(path.join(PROJECT, 'удалённое', 'Модуль.bsl')),
					removed(path.join(PROJECT, 'Удалённый.bsl')),
				],
			};
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITH_SUB_PROJECT);
		await provider.refresh();
		assert.strictEqual(provider.getLastFilteredCount(), 3);

		provider.pathsChanged([vscode.Uri.file(path.join(PROJECT, 'удалённое'))], true);
		provider.pathsChanged([vscode.Uri.file(path.join(PROJECT, 'Удалённый.bsl'))], true);
		provider.pathsChanged([vscode.Uri.file(path.join(PROJECT, 'tests'))], false);
		await waitUntil(() => provider.getLastFilteredCount() === 1);

		assert.strictEqual(scans, 1);
		assert.deepStrictEqual(projectGroups(provider), [['tests/Проверка.os', ['TODO:1']]]);
		provider.dispose();
	});

	test('созданный каталог и изменённый файл: их дела читаются без скана проектов', async function () {
		this.timeout(60_000);
		let scans = 0;
		const scan = async (): Promise<TodoScanResult> => {
			scans += 1;
			return { roots: [PROJECT, SUB_PROJECT], entries: [] };
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITH_SUB_PROJECT);
		await provider.refresh();

		provider.pathsChanged(
			[vscode.Uri.file(path.join(PROJECT, 'tests')), vscode.Uri.file(path.join(PROJECT, 'oscript_modules'))],
			true
		);
		provider.pathsChanged([vscode.Uri.file(path.join(SUB_PROJECT, 'tests', 'Подпроект.os'))], false);
		await waitUntil(() => provider.getLastFilteredCount() === 2);

		assert.strictEqual(scans, 1);
		assert.deepStrictEqual(projectGroups(provider), [
			[PROJECT, ['TODO:1']],
			[SUB_PROJECT, ['FIXME:1']],
		]);
		provider.dispose();
	});

	test('изменения на диске во время скана читаются после него', async function () {
		this.timeout(60_000);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scans = 0;
		const scan = async (): Promise<TodoScanResult> => {
			scans += 1;
			if (scans === 2) {
				await gate;
			}
			return { roots: [PROJECT], entries: [] };
		};
		const provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITHOUT_SUB_PROJECT);
		await provider.refresh();

		const running = provider.refresh();
		provider.pathsChanged([vscode.Uri.file(path.join(PROJECT, 'tests', 'Проверка.os'))], false);
		release();
		await running;
		await waitUntil(() => provider.getLastFilteredCount() === 1);

		assert.strictEqual(scans, 2);
		provider.dispose();
	});

	test('обновление сразу после конца скана не теряется', async function () {
		this.timeout(60_000);
		const result: TodoScanResult = { roots: [PROJECT], entries: [] };
		for (let depth = 0; depth <= 8; depth++) {
			let scans = 0;
			let provider: TodoPanelTreeDataProvider | undefined;
			const scan = (): Promise<TodoScanResult> => {
				scans += 1;
				const done = Promise.resolve(result);
				if (scans === 1) {
					let tick = done.then(() => undefined);
					for (let step = 0; step < depth; step++) {
						tick = tick.then(() => undefined);
					}
					void tick.then(() => provider?.refresh());
				}
				return done;
			};
			provider = new TodoPanelTreeDataProvider(createMockExtensionContext(), scan, () => WITHOUT_SUB_PROJECT);

			await provider.refresh();
			await waitUntil(() => scans === 2, `обновление через ${depth} микрозадач потеряно`);
		}
	});
});

/** Группы по проектам или файлам: корень или путь и дела как «тег:строка». */
function projectGroups(provider: TodoPanelTreeDataProvider): unknown[] {
	return provider.getChildren().map((node) => {
		if (node.kind === 'project' || node.kind === 'file') {
			return [node.kind === 'project' ? node.root : node.path, node.entries.map((entry) => `${entry.tag}:${entry.line}`)];
		}
		return node.kind;
	});
}

/** Сохранённый документ с текстом, которого нет на диске. */
function savedDocument(file: string, text: string): vscode.TextDocument {
	return { uri: vscode.Uri.file(file), languageId: 'bsl', getText: () => text } as unknown as vscode.TextDocument;
}

async function waitUntil(condition: () => boolean, message = 'не дождались'): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
