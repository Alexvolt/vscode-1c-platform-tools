import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AdapterRunPlan, FileTreeLocation, TestFrameworkAdapter } from '../../features/testing/frameworkAdapter';
import { findProjectTestFiles, TestingController } from '../../features/testing/testController';
import type { VRunnerManager } from '../../shared/vrunnerManager';
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
		const files = await findProjectTestFiles({ root: PROJECT, excludeDirs: [SUB_PROJECT] }, '**/*.os', ['oscript_modules']);

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
});
