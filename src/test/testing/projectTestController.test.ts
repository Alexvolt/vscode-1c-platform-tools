import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AdapterRunPlan, FileTreeLocation, TestFrameworkAdapter } from '../../features/testing/frameworkAdapter';
import { findProjectFiles } from '../../features/artifacts/projectScan';
import { TestingController } from '../../features/testing/testController';
import type { VRunnerManager } from '../../shared/vrunnerManager';
import { buildProcessCommand } from '../../utils/commandUtils';
import { currentRoot, sameProjectRoot, type ProjectScanRoot } from '../../shared/workspaceProjects';

/** Проект с подпроектом и зависимостями. */
const PROJECT = path.resolve(__dirname, '../../../src/test/fixtures/workspaceScan/проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');

/** Адаптер, который запоминает корень, видимый при обнаружении и прогоне. */
class RecordingAdapter implements TestFrameworkAdapter {
	public readonly id = 'onescript' as const;
	public readonly label = 'OneScript';
	public readonly usesReportDir = false;
	public readonly discoveryRoots: (string | undefined)[] = [];
	public readonly runRoots: (string | undefined)[] = [];

	public async isEnabled(): Promise<boolean> {
		return true;
	}

	public getIncludeGlobs(): string[] {
		this.discoveryRoots.push(currentRoot());
		return ['tests/**/*.os'];
	}

	public parseFile(): undefined {
		return undefined;
	}

	public describeFileLocation(): FileTreeLocation {
		return { segments: [] };
	}

	public async buildRunPlan(): Promise<AdapterRunPlan> {
		this.runRoots.push(currentRoot());
		throw new Error('процесс в проверке не запускается');
	}
}

/** Адаптер, чей прогон исполняет готовую команду оболочки. */
class ShellAdapter extends RecordingAdapter {
	constructor(private readonly command: string, private readonly report: string) {
		super();
	}

	public override async buildRunPlan(): Promise<AdapterRunPlan> {
		return { tool: 'shell', args: [this.command], reportTarget: { format: 'junit', path: this.report } };
	}
}

interface ControllerInternals {
	controller: vscode.TestController;
	runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void>;
}

const scanRootOf = async (root: string): Promise<ProjectScanRoot> => ({
	root,
	excludeDirs: sameProjectRoot(root, PROJECT) ? [SUB_PROJECT] : [],
});

function fileItems(controller: vscode.TestController): vscode.TestItem[] {
	const files: vscode.TestItem[] = [];
	const visit = (item: vscode.TestItem) => {
		if (item.uri && path.extname(item.uri.fsPath) === '.os') {
			files.push(item);
		}
		item.children.forEach(visit);
	};
	controller.items.forEach(visit);
	return files;
}

const labels = (controller: vscode.TestController) => fileItems(controller).map((item) => item.label).sort();

const isRoot = (expected: string) => (root: string | undefined) => root !== undefined && sameProjectRoot(root, expected);

suite('тестирование: дерево текущего проекта', () => {
	test('поиск от корня проекта без подпроекта и зависимостей', async function () {
		this.timeout(60_000);
		const files = await findProjectFiles({ root: PROJECT, excludeDirs: [SUB_PROJECT] }, '**/*.os', ['oscript_modules']);

		assert.deepStrictEqual(
			files.map((uri) => path.relative(PROJECT, uri.fsPath).split(path.sep).join('/')),
			['tests/Проверка.os']
		);
	});

	test('смена проекта пересобирает дерево, адаптеры видят корень проекта', async function () {
		this.timeout(60_000);
		const adapter = new RecordingAdapter();
		const testing = new TestingController([adapter], {} as VRunnerManager, { current: true }, {
			id: '1c-platform-tools-tests-project-switch',
			scanRootOf,
		});
		const internals = testing as unknown as ControllerInternals;
		try {
			testing.setProject(PROJECT);
			await testing.enqueueRebuild();
			assert.deepStrictEqual(labels(internals.controller), ['Проверка.os']);
			assert.ok(adapter.discoveryRoots.length > 0 && adapter.discoveryRoots.every(isRoot(PROJECT)));

			testing.setProject(SUB_PROJECT);
			await testing.enqueueRebuild();
			assert.deepStrictEqual(labels(internals.controller), ['Подпроект.os']);
			assert.ok(isRoot(SUB_PROJECT)(adapter.discoveryRoots.at(-1)));
		} finally {
			testing.dispose();
		}
	});

	test('прогон идёт в проекте, чьи файлы в дереве', async function () {
		this.timeout(60_000);
		const adapter = new RecordingAdapter();
		const testing = new TestingController([adapter], {} as VRunnerManager, { current: true }, {
			id: '1c-platform-tools-tests-run-root',
			scanRootOf,
		});
		const internals = testing as unknown as ControllerInternals;
		const cancellation = new vscode.CancellationTokenSource();
		try {
			testing.setProject(PROJECT);
			await testing.enqueueRebuild();
			const [item] = fileItems(internals.controller);
			assert.ok(item);

			testing.setProject(SUB_PROJECT);
			await internals.runHandler(new vscode.TestRunRequest([item]), cancellation.token);

			assert.strictEqual(adapter.runRoots.length, 1);
			assert.ok(isRoot(PROJECT)(adapter.runRoots[0]));
		} finally {
			cancellation.dispose();
			testing.dispose();
		}
	});

	test('раннер OneScript получает окружение выбранного движка', async function () {
		this.timeout(60_000);
		const output = path.join(os.tmpdir(), `1cpt-onescript-env-${process.pid}.txt`);
		const envRoots: (string | undefined)[] = [];
		const vrunner = {
			oneScriptEnv: async (extra?: NodeJS.ProcessEnv) => {
				envRoots.push(currentRoot());
				return { ...process.env, ...extra, ONESCRIPT_ENGINE: 'выбранный' };
			},
		} as unknown as VRunnerManager;
		const adapter = new ShellAdapter(
			buildProcessCommand('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(output)}, process.env.ONESCRIPT_ENGINE ?? '')`]),
			`${output}.xml`
		);
		const testing = new TestingController([adapter], vrunner, { current: true }, {
			id: '1c-platform-tools-tests-engine-env',
			scanRootOf,
		});
		const internals = testing as unknown as ControllerInternals;
		const cancellation = new vscode.CancellationTokenSource();
		try {
			testing.setProject(PROJECT);
			await testing.enqueueRebuild();
			const [item] = fileItems(internals.controller);
			assert.ok(item);

			await internals.runHandler(new vscode.TestRunRequest([item]), cancellation.token);

			assert.strictEqual(fs.readFileSync(output, 'utf8'), 'выбранный');
			assert.ok(envRoots.length === 1 && isRoot(PROJECT)(envRoots[0]));
		} finally {
			fs.rmSync(output, { force: true });
			cancellation.dispose();
			testing.dispose();
		}
	});
});
