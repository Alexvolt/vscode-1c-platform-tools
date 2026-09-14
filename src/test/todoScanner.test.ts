import * as assert from 'node:assert';
import * as path from 'node:path';
import { projectRelativePath } from '../features/artifacts/projectScan';
import { scanWorkspaceForTodos, type TodoEntry } from '../features/todo/todoScanner';

/** Проект с подпроектом и зависимостями. */
const PROJECT = path.resolve(__dirname, '../../src/test/fixtures/workspaceScan/проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');

const describe = (entries: TodoEntry[], root: string) =>
	entries
		.filter((entry) => entry.root === root)
		.map((entry) => `${entry.tag} ${projectRelativePath(root, entry.uri.fsPath)}:${entry.line}`);

suite('список дел: скан проектов', () => {
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
