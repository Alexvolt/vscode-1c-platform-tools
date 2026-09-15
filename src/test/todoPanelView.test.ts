import * as assert from 'node:assert';
import * as path from 'node:path';
import { TodoPanelTreeDataProvider } from '../features/todo/todoPanelView';
import { scanWorkspaceForTodos, type TodoScanResult } from '../features/todo/todoScanner';
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

async function waitUntil(condition: () => boolean, message = 'не дождались'): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
