import * as assert from 'node:assert';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { debugProjectRoot, debugRootProjectDir, type DebugProjectLookup } from '../../features/debug/debugConfigurations';

const FOLDER = path.resolve('/w/папка');
const PROJECT = path.join(FOLDER, 'проект');
const SUB_PROJECT = path.join(PROJECT, 'подпроект');
const OTHER_FOLDER = path.resolve('/w/другая');

/** Проекты рабочей области: самый глубокий по пути. */
function lookup(current: string | undefined): DebugProjectLookup {
	const projects = [PROJECT, SUB_PROJECT, OTHER_FOLDER];
	return {
		current,
		projectOf: (target) =>
			projects
				.filter((root) => target === root || target.startsWith(root + path.sep))
				.sort((left, right) => right.length - left.length)[0],
	};
}

function config(rootProject: unknown): vscode.DebugConfiguration {
	return { type: 'onec', request: 'launch', name: 'Отладка', rootProject };
}

suite('отладка: проект конфигурации отладки', () => {
	test('без папки берётся текущий проект', () => {
		assert.strictEqual(debugProjectRoot(undefined, undefined, lookup(OTHER_FOLDER)), OTHER_FOLDER);
	});

	test('rootProject ведёт в самый глубокий проект, где лежит каталог', () => {
		const rootProject = path.join(SUB_PROJECT, 'src', 'cf');
		assert.strictEqual(debugProjectRoot(FOLDER, rootProject, lookup(PROJECT)), SUB_PROJECT);
	});

	test('без rootProject текущий проект из той же папки важнее проекта папки', () => {
		assert.strictEqual(debugProjectRoot(FOLDER, undefined, lookup(SUB_PROJECT)), SUB_PROJECT);
	});

	test('текущий проект из другой папки уступает проекту папки', () => {
		assert.strictEqual(debugProjectRoot(PROJECT, undefined, lookup(OTHER_FOLDER)), PROJECT);
	});

	test('папка вне проектов без rootProject оставляет текущий проект', () => {
		const outside = path.resolve('/w/без-проекта');
		assert.strictEqual(debugProjectRoot(outside, undefined, lookup(OTHER_FOLDER)), OTHER_FOLDER);
	});

	test('rootProject с ${workspaceFolder} разворачивается от папки', () => {
		assert.strictEqual(
			debugRootProjectDir(config('${workspaceFolder}/проект/src/cf'), FOLDER),
			path.join(PROJECT, 'src', 'cf')
		);
		assert.strictEqual(debugRootProjectDir(config('проект'), FOLDER), PROJECT);
		assert.strictEqual(debugRootProjectDir(config(PROJECT), undefined), PROJECT);
	});

	test('rootProject с другими переменными или без значения не используется', () => {
		assert.strictEqual(debugRootProjectDir(config('${env:HOME}/cf'), FOLDER), undefined);
		assert.strictEqual(debugRootProjectDir(config(''), FOLDER), undefined);
		assert.strictEqual(debugRootProjectDir(config(undefined), FOLDER), undefined);
		assert.strictEqual(debugRootProjectDir(config('src/cf'), undefined), undefined);
	});
});
