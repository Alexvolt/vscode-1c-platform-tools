import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { projectRelativePath } from '../features/artifacts/projectScan';
import {
	scanTodoDocument,
	scanTodoPaths,
	scanWorkspaceForTodos,
	type TodoEntry,
} from '../features/todo/todoScanner';

/** Проект с подпроектом и зависимостями. */
const PROJECT = path.resolve(__dirname, '../../src/test/fixtures/workspaceScan/проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');

const describe = (entries: TodoEntry[], root: string) =>
	entries
		.filter((entry) => entry.root === root)
		.map((entry) => `${entry.tag} ${projectRelativePath(root, entry.uri.fsPath)}:${entry.line}`);

suite('список дел: скан проектов', () => {
	teardown(async () => {
		await vscode.workspace.getConfiguration('1c-platform-tools').update('todo.include', undefined, vscode.ConfigurationTarget.Workspace);
	});

	test('маска с ./ или обратной косой чертой: файл сверяется с ней так же, как ищет скан', async function () {
		this.timeout(60_000);
		const scanRoot = { root: PROJECT, excludeDirs: [SUB_PROJECT] };
		const file = vscode.Uri.file(path.join(PROJECT, 'tests', 'Проверка.os'));
		const saved = { uri: file, getText: () => '// FIXME: сохранённое\n' } as unknown as vscode.TextDocument;
		for (const mask of ['./tests/**/*.os', String.raw`.\tests\**\*.os`]) {
			await vscode.workspace.getConfiguration('1c-platform-tools').update('todo.include', [mask], vscode.ConfigurationTarget.Workspace);

			const { entries } = await scanWorkspaceForTodos([scanRoot]);
			assert.deepStrictEqual(describe(entries, PROJECT), ['TODO tests/Проверка.os:1'], mask);
			assert.deepStrictEqual(describe(scanTodoDocument(scanRoot, saved) ?? [], PROJECT), ['FIXME tests/Проверка.os:1'], mask);
			const changed = await scanTodoPaths(scanRoot, [{ uri: file, tree: false }]);
			assert.deepStrictEqual(describe(changed, PROJECT), ['TODO tests/Проверка.os:1'], mask);
		}
	});

	test('дела подпроекта только у него, зависимости не сканируются', async function () {
		this.timeout(60_000);
		const { roots, entries } = await scanWorkspaceForTodos([
			{ root: PROJECT, excludeDirs: [SUB_PROJECT] },
			{ root: SUB_PROJECT, excludeDirs: [] },
		]);

		assert.deepStrictEqual(roots, [PROJECT, SUB_PROJECT]);
		assert.deepStrictEqual(describe(entries, PROJECT), ['TODO tests/Проверка.os:1']);
		assert.deepStrictEqual(describe(entries, SUB_PROJECT), ['FIXME tests/Подпроект.os:1']);
		assert.strictEqual(entries.length, 2);
	});

	test('без проектов нечего сканировать', async () => {
		assert.deepStrictEqual(await scanWorkspaceForTodos([]), { roots: [], entries: [] });
	});
});
