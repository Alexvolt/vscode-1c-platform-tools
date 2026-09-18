import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	findProjectFiles,
	projectRelativePath,
	searchExcludeGlob,
	splitGlobBase,
} from '../../features/artifacts/projectScan';

/** Проект с подпроектом и зависимостями. */
const PROJECT = path.resolve(__dirname, '../../../src/test/fixtures/workspaceScan/проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');

const relative = (uris: vscode.Uri[]) => uris.map((uri) => projectRelativePath(PROJECT, uri.fsPath)).sort();

suite('поиск файлов проекта', () => {
	test('маска делится на каталог без символов маски и остаток', () => {
		assert.deepStrictEqual(splitGlobBase('features/**/*.feature'), { base: 'features', pattern: '**/*.feature' });
		assert.deepStrictEqual(splitGlobBase('./tests/cfe/Тесты/CommonModules/*/Ext/Module.bsl'), {
			base: 'tests/cfe/Тесты/CommonModules',
			pattern: '*/Ext/Module.bsl',
		});
		assert.deepStrictEqual(splitGlobBase('**/*.{bsl,os}'), { base: '', pattern: '**/*.{bsl,os}' });
		assert.deepStrictEqual(splitGlobBase('{src,tests}/**/*.bsl'), { base: '', pattern: '{src,tests}/**/*.bsl' });
		assert.deepStrictEqual(splitGlobBase('tests\\Проверка.os'), { base: 'tests', pattern: 'Проверка.os' });
	});

	test('исключение из сегментов и каталогов других проектов ниже каталога поиска', () => {
		const scanRoot = { root: PROJECT, excludeDirs: [SUB_PROJECT, path.join(PROJECT, 'a[1]')] };
		assert.strictEqual(
			searchExcludeGlob(PROJECT, scanRoot, ['oscript_modules', 'build/out', 'x,y', '']),
			'{**/oscript_modules/**,**/build/out/**,подпроект/**}'
		);
		assert.strictEqual(searchExcludeGlob(path.join(PROJECT, 'tests'), scanRoot, []), undefined);
	});

	test('поиск не заходит в исключённые каталоги', async function () {
		this.timeout(60_000);
		const scanRoot = { root: PROJECT, excludeDirs: [SUB_PROJECT] };
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(vscode.Uri.file(PROJECT), '**/*.os'),
			searchExcludeGlob(PROJECT, scanRoot, ['oscript_modules'])
		);
		assert.deepStrictEqual(relative(uris), ['tests/Проверка.os']);
	});

	test('поиск от каталога в начале маски, без отсутствующего каталога и пути выше корня', async function () {
		this.timeout(60_000);
		const scanRoot = { root: PROJECT, excludeDirs: [SUB_PROJECT] };
		assert.deepStrictEqual(relative(await findProjectFiles(scanRoot, 'tests/**/*.os', [])), ['tests/Проверка.os']);
		assert.deepStrictEqual(await findProjectFiles(scanRoot, 'нет/**/*.os', []), []);
		assert.deepStrictEqual(await findProjectFiles(scanRoot, '../**/*.os', []), []);
		assert.deepStrictEqual(await findProjectFiles(scanRoot, 'oscript_modules/**/*.os', ['oscript_modules']), []);
	});
});
