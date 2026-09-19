/**
 * Host-side панель ER-canvas (Cytoscape + ELK).
 *
 * Одна панель на окно: повторный вызов открывает её же, для другого проекта с его графом.
 *
 * @module er/erCanvasPanel
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from '../../../shared/logger';
import { sameProjectRoot } from '../../../shared/workspaceProjects';
import { clearMdSparrowJarCache } from '../mdSparrowBootstrap';
import { MdSparrowOutdatedError } from '../mdSparrowErrors';
import { supportedErFormats } from './erExporters/exporterRegistry';
import { buildSubgraph, listObjectTypes, listRelationKinds } from './erFilters';
import { loadErGraph } from './erGraphService';
import type { ErExportFormat, ErGraph, ErScope, ErSubgraph } from './erTypes';
import { notifyQuiet } from '../../../shared/notify';

const log = logger.scope('er');

/**
 * Жёсткий лимит количества узлов, который мы соглашаемся отрисовать в Cytoscape.
 * 500 выбрано как практический компромисс: при больших графах заметно растут время layout
 * (ELK) и стоимость рендера в webview, что ухудшает отзывчивость UI.
 * При превышении сначала пробуем уменьшить hops, иначе показываем только seeds.
 */
const MAX_RENDER_NODES = 500;

/** Загрузка графа метаданных проекта. */
export type ErGraphLoader = (context: vscode.ExtensionContext, root: string) => Promise<ErGraph>;

interface OpenErCanvasParams {
	readonly context: vscode.ExtensionContext;
	readonly workspaceRoot: string;
	readonly initialScope: ErScope;
	/** По умолчанию граф строит md-sparrow с кэшем */
	readonly loadGraph?: ErGraphLoader;
}

const loadProjectGraph: ErGraphLoader = async (context, root) => (await loadErGraph(context, root, {})).graph;

interface InitPayload {
	readonly subgraph: ErSubgraph;
	readonly scope: ErScope;
	readonly truncated: boolean;
	readonly fullNodeCount: number;
	readonly availableObjectTypes: readonly string[];
	readonly availableRelationKinds: readonly string[];
	readonly catalog: readonly CatalogEntry[];
	readonly availableFormats: readonly ErExportFormat[];
	readonly defaultFormat: ErExportFormat;
	readonly defaultExportDirRel: string;
}

/** Лёгкий каталог объектов проекта для quick-pick «+ Добавить объект» в режиме конструктора. */
interface CatalogEntry {
	readonly key: string;
	readonly objectType: string;
	readonly name: string;
	readonly synonym: string;
}

interface OpenObjectPayload {
	readonly key: string;
	readonly sourceId: string;
	readonly relativePath: string;
}

interface ExportContentPayload {
	readonly format: ErExportFormat;
	readonly fileExtension: string;
	readonly scopeLabel: string;
	readonly content: string;
	readonly base64: boolean;
}

interface InboundMessage {
	readonly type?: string;
	readonly payload?: unknown;
}

interface CanvasInstance {
	readonly panel: vscode.WebviewPanel;
	readonly defaultFormat: ErExportFormat;
	readonly exportDirRel: string;
	/** Проект, чей граф в панели */
	root: string;
	graph: ErGraph;
	/** Граф проекта {@link root} загружается, загружен или не загрузился */
	graphState: 'loading' | 'loaded' | 'failed';
	scope: ErScope;
}

/** Сообщения webview о графе на экране: до загрузки графа проекта панели они относятся к прежнему. */
const GRAPH_MESSAGES = new Set(['openObject', 'exportContent', 'requestScope', 'pickAndAddObject']);

let activeCanvas: CanvasInstance | undefined;

/**
 * Открывает панель ER-canvas; если уже открыта, переиспользует её: для того же проекта
 * обновляет scope, для другого загружает его граф.
 */
export async function openErCanvasPanel(params: OpenErCanvasParams): Promise<void> {
	const { context, workspaceRoot, initialScope } = params;
	const loadGraph = params.loadGraph ?? loadProjectGraph;
	if (activeCanvas) {
		const instance = activeCanvas;
		instance.panel.reveal(vscode.ViewColumn.Active);
		if (sameProjectRoot(instance.root, workspaceRoot) && instance.graphState !== 'failed') {
			if (instance.graphState === 'loaded') {
				await postScopeChange(instance, initialScope);
			} else {
				instance.scope = initialScope;
			}
			return;
		}
		instance.root = workspaceRoot;
		instance.graph = emptyGraph(workspaceRoot);
		instance.graphState = 'loading';
		instance.scope = initialScope;
		await instance.panel.webview.postMessage({
			type: 'init',
			payload: emptyInitPayload(initialScope, instance.defaultFormat, instance.exportDirRel),
		});
		void loadAndInitCanvas(instance, context, loadGraph);
		return;
	}

	const cfg = vscode.workspace.getConfiguration('1c-platform-tools');
	const defaultFormat = (cfg.get<string>('metadata.er.defaultExportFormat', 'mermaid') as ErExportFormat) || 'mermaid';
	const exportDirRel = (cfg.get<string>('metadata.er.path.export', 'docs/schemas') || 'docs/schemas').trim();

	const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview');
	const outRoot = vscode.Uri.joinPath(context.extensionUri, 'out', 'webviews', 'metadataErCanvas');
	const panel = vscode.window.createWebviewPanel(
		'1cMetadataErCanvas',
		'ER: диаграмма',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [webviewRoot, outRoot],
		}
	);
	const instance: CanvasInstance = {
		panel,
		defaultFormat,
		exportDirRel,
		root: workspaceRoot,
		graph: emptyGraph(workspaceRoot),
		graphState: 'loading',
		scope: initialScope,
	};
	activeCanvas = instance;

	panel.onDidDispose(() => {
		if (activeCanvas?.panel === panel) {
			activeCanvas = undefined;
		}
	});

	// Панель показывается мгновенно с пустым состоянием — граф грузится в фоне
	const emptyInit = emptyInitPayload(initialScope, defaultFormat, exportDirRel);
	const nonce = randomUUID();
	panel.webview.html = await loadCanvasHtml(panel.webview, context.extensionUri, emptyInit, nonce);

	panel.webview.onDidReceiveMessage(
		(message: InboundMessage) => {
			void handleMessage(message, instance, exportDirRel);
		},
		undefined,
		context.subscriptions
	);

	// Загружаем граф в фоне — webview видит статус в своей footer-строке
	void loadAndInitCanvas(instance, context, loadGraph);
}

/**
 * Загружает граф проекта панели в фоне и отправляет данные в webview через graphReady.
 * Граф проекта, для которого панель открыли заново за время загрузки, не показывается.
 */
async function loadAndInitCanvas(
	instance: CanvasInstance,
	context: vscode.ExtensionContext,
	loadGraph: ErGraphLoader
): Promise<void> {
	const root = instance.root;
	await instance.panel.webview.postMessage({
		type: 'loading',
		payload: { message: 'Загрузка графа метаданных…' },
	});
	try {
		const graph = await loadGraph(context, root);
		if (!sameProjectRoot(instance.root, root)) {
			return;
		}
		instance.graph = graph;
		instance.graphState = 'loaded';
		const subgraphResult = computeSubgraphForRender(graph, instance.scope);
		await instance.panel.webview.postMessage({
			type: 'graphReady',
			payload: {
				subgraph: subgraphResult.subgraph,
				scope: subgraphResult.scope,
				truncated: subgraphResult.truncated,
				fullNodeCount: subgraphResult.fullNodeCount,
				availableObjectTypes: listObjectTypes(graph),
				availableRelationKinds: listRelationKinds(graph),
				catalog: buildCatalog(graph),
			},
		});
	} catch (e) {
		if (!sameProjectRoot(instance.root, root)) {
			return;
		}
		const message = e instanceof Error ? e.message : String(e);
		log.error(`не удалось загрузить граф: ${message}`);
		await instance.panel.webview.postMessage({
			type: 'loadError',
			payload: { message },
		});
		if (e instanceof MdSparrowOutdatedError) {
			try {
				await clearMdSparrowJarCache(context);
			} catch (clearError) {
				log.warn(`кэш md-sparrow не очищен: ${clearError instanceof Error ? clearError.message : String(clearError)}`);
				instance.graphState = 'failed';
				return;
			}
			void loadAndInitCanvas(instance, context, loadGraph);
			return;
		}
		instance.graphState = 'failed';
	}
}

/** Пустая панель: граф ещё не загружен. */
function emptyInitPayload(scope: ErScope, defaultFormat: ErExportFormat, exportDirRel: string): InitPayload {
	return {
		subgraph: { nodes: [], edges: [] },
		scope,
		truncated: false,
		fullNodeCount: 0,
		availableObjectTypes: [],
		availableRelationKinds: [],
		catalog: [],
		availableFormats: supportedErFormats(),
		defaultFormat,
		defaultExportDirRel: exportDirRel,
	};
}

/** Считает подграф под scope; если узлов > MAX_RENDER_NODES — поэтапно снижает hops, иначе fallback на seeds. */
function computeSubgraphForRender(
	graph: ErGraph,
	scope: ErScope
): { subgraph: ErSubgraph; scope: ErScope; truncated: boolean; fullNodeCount: number } {
	const subgraph = buildSubgraph(graph, scope);
	if (subgraph.nodes.length <= MAX_RENDER_NODES) {
		return { subgraph, scope, truncated: false, fullNodeCount: subgraph.nodes.length };
	}
	const fullNodeCount = subgraph.nodes.length;

	// Для selection-scope пробуем уменьшать hops до тех пор, пока не уложимся в лимит.
	if (scope.kind === 'selection' && scope.hops > 0) {
		for (let hops = scope.hops - 1; hops >= 0; hops--) {
			const reducedScope = { ...scope, hops };
			const reduced = buildSubgraph(graph, reducedScope);
			if (reduced.nodes.length <= MAX_RENDER_NODES) {
				return { subgraph: reduced, scope: reducedScope, truncated: true, fullNodeCount };
			}
		}
	}

	// Последний резерв: только seed-узлы с рёбрами между ними.
	const seedSet = new Set(scope.seeds);
	const fallbackNodes = subgraph.nodes.filter((n) => seedSet.has(n.key));
	const fallbackKeys = new Set(fallbackNodes.map((n) => n.key));
	const fallbackEdges = subgraph.edges.filter(
		(e) => fallbackKeys.has(e.sourceKey) && fallbackKeys.has(e.targetKey)
	);
	return {
		subgraph: { nodes: fallbackNodes, edges: fallbackEdges },
		scope,
		truncated: true,
		fullNodeCount,
	};
}

function buildCatalog(graph: ErGraph): CatalogEntry[] {
	return graph.nodes
		.map((node) => ({
			key: node.key,
			objectType: node.objectType,
			name: node.name,
			synonym: node.synonym,
		}))
		.sort((a, b) => a.key.localeCompare(b.key, 'ru'));
}

async function postScopeChange(instance: CanvasInstance, scope: ErScope): Promise<void> {
	const result = computeSubgraphForRender(instance.graph, scope);
	instance.scope = result.scope;
	await instance.panel.webview.postMessage({
		type: 'setSubgraph',
		payload: {
			subgraph: result.subgraph,
			scope: result.scope,
			truncated: result.truncated,
			fullNodeCount: result.fullNodeCount,
		},
	});
}

function emptyGraph(projectRoot: string): ErGraph {
	return {
		projectRoot,
		mainSchemaVersion: '',
		mainSchemaVersionFlag: '',
		nodeCount: 0,
		edgeCount: 0,
		nodes: [],
		edges: [],
	};
}

async function handleMessage(
	message: InboundMessage,
	instance: CanvasInstance,
	defaultExportDirRel: string
): Promise<void> {
	if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
		return;
	}
	if (message.type === 'ready') {
		return;
	}
	if (message.type === 'log') {
		const payload = message.payload as { level?: string; message?: string } | undefined;
		const text = String(payload?.message ?? '');
		if (payload?.level === 'error' || payload?.level === 'warn') {
			log.warn(`webview: ${text}`);
		} else {
			log.debug(`webview: ${text}`);
		}
		return;
	}
	if (instance.graphState !== 'loaded' && GRAPH_MESSAGES.has(message.type)) {
		return;
	}
	if (message.type === 'openObject') {
		const payload = message.payload as OpenObjectPayload | undefined;
		if (!payload?.relativePath) {
			void vscode.window.showInformationMessage(`Файл объекта не найден для ${payload?.key ?? ''}.`);
			return;
		}
		const abs = path.resolve(instance.root, payload.relativePath);
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			void vscode.window.showErrorMessage(`Не удалось открыть ${payload.relativePath}: ${msg}`);
		}
		return;
	}
	if (message.type === 'exportContent') {
		const payload = message.payload as ExportContentPayload | undefined;
		if (!payload) {
			return;
		}
		await saveExport(payload, instance.root, defaultExportDirRel);
		return;
	}
	if (message.type === 'requestScope') {
		const payload = message.payload as { scope?: ErScope } | undefined;
		if (payload?.scope) {
			await postScopeChange(instance, payload.scope);
		}
		return;
	}
	if (message.type === 'pickAndAddObject') {
		await pickAndAddObject(instance);
		return;
	}
}

async function pickAndAddObject(instance: CanvasInstance): Promise<void> {
	const items = instance.graph.nodes
		.map((node) => ({
			label: node.name,
			description: node.synonym && node.synonym !== node.name ? `«${node.synonym}»` : '',
			detail: node.relativePath || '',
			filterText: `${node.key} ${node.name} ${node.synonym} ${node.objectType}`,
			key: node.key,
		}))
		.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
	const picked = await vscode.window.showQuickPick(items, {
		title: 'ER: добавить объект на схему',
		placeHolder: 'Начните вводить имя объекта (например, Catalog.Контрагенты)…',
		matchOnDescription: true,
		matchOnDetail: true,
		canPickMany: false,
	});
	if (!picked) {
		return;
	}
	const seeds = uniqueArray([...instance.scope.seeds, picked.key]);
	const nextScope: ErScope = {
		...instance.scope,
		kind: 'selection',
		label: seeds.length === 1 ? seeds[0] : `выбрано: ${seeds.length}`,
		seeds,
		hops: instance.scope.kind === 'selection' ? instance.scope.hops : 0,
	};
	await postScopeChange(instance, nextScope);
}

function uniqueArray(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

async function saveExport(payload: ExportContentPayload, workspaceRoot: string, defaultExportDirRel: string): Promise<void> {
	const dirAbs = path.resolve(workspaceRoot, defaultExportDirRel);
	await fs.mkdir(dirAbs, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
	const safeLabel = sanitizeLabel(payload.scopeLabel);
	const fileName = `${stamp}-${safeLabel}.${payload.fileExtension}`;
	const fileAbs = path.join(dirAbs, fileName);
	if (payload.base64) {
		await fs.writeFile(fileAbs, Buffer.from(payload.content, 'base64'));
	} else {
		await fs.writeFile(fileAbs, payload.content, 'utf8');
	}
	const rel = path.relative(workspaceRoot, fileAbs).replaceAll('\\', '/');
	notifyQuiet(`ER: ${payload.format.toUpperCase()} сохранён: ${rel}`);
}

function sanitizeLabel(label: string): string {
	const value = label.trim().replaceAll(/[^A-Za-z0-9А-Яа-я_\-.]+/g, '_');
	return value.length > 0 ? value : 'scope';
}

async function loadCanvasHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	init: InitPayload,
	nonce: string
): Promise<string> {
	const templateUri = vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'metadata-er-canvas.html');
	const bytes = await vscode.workspace.fs.readFile(templateUri);
	const template = new TextDecoder('utf-8').decode(bytes);
	const cssUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'metadata-er-canvas.css')
	);
	const jsUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'out', 'webviews', 'metadataErCanvas', 'index.js')
	);
	const initialJson = JSON.stringify(init).replaceAll('<', String.raw`\u003c`);
	return template
		.replaceAll('{{CSP_SOURCE}}', webview.cspSource)
		.replaceAll('{{NONCE}}', nonce)
		.replaceAll('{{CSS_URI}}', cssUri.toString())
		.replaceAll('{{JS_URI}}', jsUri.toString())
		.replaceAll('{{INITIAL_JSON}}', initialJson)
		.replaceAll('{{TITLE}}', 'ER: диаграмма');
}
