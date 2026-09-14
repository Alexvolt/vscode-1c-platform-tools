import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openErCanvasPanel, type ErGraphLoader } from '../../features/metadata/er/erCanvasPanel';
import type { ErGraph, ErScope } from '../../features/metadata/er/erTypes';
import { sameProjectRoot } from '../../shared/workspaceProjects';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';

const EXTENSION_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_GRAPH = path.join(EXTENSION_ROOT, 'src', 'test', 'fixtures', 'er', 'ssl31-anketirovanie.json');
const ANKETA_DOC = 'Document.Анкета';

interface PostedMessage {
	readonly type: string;
	readonly payload?: {
		readonly catalog?: readonly { readonly key: string }[];
		readonly subgraph?: { readonly nodes: readonly { readonly key: string }[] };
		readonly scope?: { readonly seeds: readonly string[] };
	};
}

interface FakePanel {
	readonly posted: PostedMessage[];
	send(message: unknown): void;
	dispose(): void;
}

/** Панели webview без окна: сообщения в webview копятся, из webview шлёт тест. */
function stubWebviewPanels(): { panels: FakePanel[]; restore: () => void } {
	const original = Object.getOwnPropertyDescriptor(vscode.window, 'createWebviewPanel');
	const panels: FakePanel[] = [];
	const create = (): vscode.WebviewPanel => {
		const posted: PostedMessage[] = [];
		let receive: (message: unknown) => void = () => undefined;
		const disposeListeners: (() => void)[] = [];
		const webview = {
			html: '',
			cspSource: 'test',
			asWebviewUri: (uri: vscode.Uri) => uri,
			postMessage: async (message: PostedMessage) => {
				posted.push(message);
				return true;
			},
			onDidReceiveMessage: (listener: (message: unknown) => void) => {
				receive = listener;
				return new vscode.Disposable(() => undefined);
			},
		};
		const dispose = () => {
			for (const listener of disposeListeners) {
				listener();
			}
		};
		panels.push({ posted, send: (message) => receive(message), dispose });
		return {
			webview,
			reveal: () => undefined,
			onDidDispose: (listener: () => void) => {
				disposeListeners.push(listener);
				return new vscode.Disposable(() => undefined);
			},
			dispose,
		} as unknown as vscode.WebviewPanel;
	};
	Object.defineProperty(vscode.window, 'createWebviewPanel', { value: create, configurable: true, writable: true });
	return {
		panels,
		restore: () => {
			if (original) {
				Object.defineProperty(vscode.window, 'createWebviewPanel', original);
			}
		},
	};
}

function graphOf(root: string, keys?: readonly string[]): ErGraph {
	const fixture = JSON.parse(fs.readFileSync(FIXTURE_GRAPH, 'utf8')) as ErGraph;
	const nodes = keys ? fixture.nodes.filter((node) => keys.includes(node.key)) : fixture.nodes;
	const edges = keys ? [] : fixture.edges;
	return { ...fixture, projectRoot: root, nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
}

function selection(seeds: readonly string[], hops: number): ErScope {
	return { kind: 'selection', label: seeds.join(', '), seeds, hops, objectTypes: [], relationKinds: null };
}

const catalogs = (panel: FakePanel) =>
	panel.posted
		.filter((message) => message.type === 'graphReady')
		.map((message) => (message.payload?.catalog ?? []).map((entry) => entry.key));

const subgraphs = (panel: FakePanel) =>
	panel.posted
		.filter((message) => message.type === 'setSubgraph')
		.map((message) => (message.payload?.subgraph?.nodes ?? []).map((node) => node.key));

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'не дождались');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite('ER-диаграмма: смена проекта', () => {
	let stub: { panels: FakePanel[]; restore: () => void };
	let temp: string;
	let first: string;
	let second: string;
	const context = createMockExtensionContext(undefined, EXTENSION_ROOT);

	setup(() => {
		stub = stubWebviewPanels();
		temp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-canvas-'));
		first = path.join(temp, 'учёт');
		second = path.join(temp, 'склад');
	});

	teardown(() => {
		for (const panel of stub.panels) {
			panel.dispose();
		}
		stub.restore();
		fs.rmSync(temp, { recursive: true, force: true });
	});

	test('открытая панель показывает граф другого проекта и сохраняет экспорт в него', async () => {
		const loaded: string[] = [];
		const loadGraph: ErGraphLoader = async (_context, root) => {
			loaded.push(root);
			return sameProjectRoot(root, first) ? graphOf(first) : graphOf(second, [ANKETA_DOC]);
		};

		await openErCanvasPanel({ context, workspaceRoot: first, initialScope: selection([], 0), loadGraph });
		const [panel] = stub.panels;
		await waitFor(() => catalogs(panel).length === 1);
		await openErCanvasPanel({ context, workspaceRoot: second, initialScope: selection([ANKETA_DOC], 1), loadGraph });
		await waitFor(() => catalogs(panel).length === 2);

		assert.strictEqual(stub.panels.length, 1);
		assert.deepStrictEqual(loaded, [first, second]);
		assert.deepStrictEqual(catalogs(panel).at(-1), [ANKETA_DOC]);

		panel.send({
			type: 'exportContent',
			payload: { format: 'mermaid', fileExtension: 'md', scopeLabel: 'Анкета', content: 'flowchart LR', base64: false },
		});
		const exportDir = path.join(second, 'docs', 'schemas');
		await waitFor(() => fs.existsSync(exportDir) && fs.readdirSync(exportDir).length === 1);
		assert.ok(!fs.existsSync(first));
	});

	test('до загрузки графа другого проекта панель пуста, действия над прежним графом не выполняются', async () => {
		let releaseSecond: () => void = () => undefined;
		const secondLoaded = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const loadGraph: ErGraphLoader = async (_context, root) => {
			if (sameProjectRoot(root, first)) {
				return graphOf(first);
			}
			await secondLoaded;
			return graphOf(second, [ANKETA_DOC]);
		};
		const opened: string[] = [];
		const openTextDocument = Object.getOwnPropertyDescriptor(vscode.workspace, 'openTextDocument');
		Object.defineProperty(vscode.workspace, 'openTextDocument', {
			value: async (uri: vscode.Uri) => {
				opened.push(uri.fsPath);
				throw new Error('открытие файла в тесте');
			},
			configurable: true,
			writable: true,
		});
		try {
			await openErCanvasPanel({ context, workspaceRoot: first, initialScope: selection([], 0), loadGraph });
			const [panel] = stub.panels;
			await waitFor(() => catalogs(panel).length === 1);
			await openErCanvasPanel({ context, workspaceRoot: second, initialScope: selection([ANKETA_DOC], 1), loadGraph });

			const resets = panel.posted.filter((message) => message.type === 'init');
			assert.strictEqual(resets.length, 1);
			assert.deepStrictEqual(resets[0].payload?.catalog, []);
			assert.deepStrictEqual(resets[0].payload?.subgraph?.nodes, []);
			assert.deepStrictEqual(resets[0].payload?.scope?.seeds, [ANKETA_DOC]);

			panel.send({ type: 'openObject', payload: { key: ANKETA_DOC, sourceId: '', relativePath: 'src/cf/Documents/Анкета.xml' } });
			panel.send({
				type: 'exportContent',
				payload: { format: 'mermaid', fileExtension: 'md', scopeLabel: 'Анкета', content: 'flowchart LR', base64: false },
			});
			panel.send({ type: 'requestScope', payload: { scope: selection(['Catalog.Прежний'], 0) } });
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.deepStrictEqual(opened, []);
			assert.ok(!fs.existsSync(second));
			assert.deepStrictEqual(subgraphs(panel), []);

			releaseSecond();
			await waitFor(() => catalogs(panel).length === 2);
			const ready = panel.posted.filter((message) => message.type === 'graphReady').at(-1);
			assert.deepStrictEqual(ready?.payload?.scope?.seeds, [ANKETA_DOC]);
			assert.deepStrictEqual(ready?.payload?.subgraph?.nodes.map((node) => node.key), [ANKETA_DOC]);
		} finally {
			if (openTextDocument) {
				Object.defineProperty(vscode.workspace, 'openTextDocument', openTextDocument);
			}
		}
	});

	test('граф прежнего проекта, загруженный позже, в панель не попадает', async () => {
		let releaseFirst: () => void = () => undefined;
		const firstLoaded = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstDone = false;
		const loadGraph: ErGraphLoader = async (_context, root) => {
			if (sameProjectRoot(root, first)) {
				await firstLoaded;
				firstDone = true;
				return graphOf(first);
			}
			return graphOf(second, [ANKETA_DOC]);
		};

		await openErCanvasPanel({ context, workspaceRoot: first, initialScope: selection([], 0), loadGraph });
		const [panel] = stub.panels;
		await openErCanvasPanel({ context, workspaceRoot: second, initialScope: selection([ANKETA_DOC], 1), loadGraph });
		await waitFor(() => catalogs(panel).length === 1);
		releaseFirst();
		await waitFor(() => firstDone);
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.deepStrictEqual(catalogs(panel), [[ANKETA_DOC]]);
		panel.send({ type: 'requestScope', payload: { scope: selection([ANKETA_DOC], 1) } });
		await waitFor(() => subgraphs(panel).length === 1);
		assert.deepStrictEqual(subgraphs(panel), [[ANKETA_DOC]]);
	});
});
