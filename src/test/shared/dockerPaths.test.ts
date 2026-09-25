import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	containerPath,
	containerPathsInText,
	fileInfobaseOutside,
	hostPathOutside,
	isInsideDir,
	textTokens,
} from '../../shared/dockerPaths';

const ROOT = path.join(os.tmpdir(), 'проект');
const WORKSPACE = [{ host: ROOT, container: '/workspace' }];

suite('Docker: пути контейнера', () => {
	test('соседний каталог с тем же началом имени проекту не принадлежит', () => {
		assert.ok(isInsideDir(ROOT, path.join(ROOT, 'build', 'ib')));
		assert.ok(isInsideDir(ROOT, ROOT));
		assert.ok(!isInsideDir(ROOT, `${ROOT}2`));
		assert.ok(!isInsideDir(ROOT, path.dirname(ROOT)));
	});

	(process.platform === 'win32' ? test : test.skip)('регистр буквы диска путь из проекта не выносит', () => {
		assert.ok(isInsideDir('C:\\proj', 'c:\\proj\\build'));
	});

	test('путь хоста переводится в путь контейнера', () => {
		assert.strictEqual(containerPath(path.join(ROOT, 'build', 'report.xml'), WORKSPACE), '/workspace/build/report.xml');
		assert.strictEqual(containerPath(ROOT, WORKSPACE), '/workspace');
		assert.strictEqual(containerPath(path.join(os.tmpdir(), 'другой'), WORKSPACE), undefined);
	});

	test('файл вне проекта, каталог которого есть на хосте, контейнеру не виден', () => {
		const outside = path.join(os.tmpdir(), 'Рабочий стол', '1Cv8.cf');
		const exists = (target: string): boolean => target === path.dirname(outside);
		assert.strictEqual(hostPathOutside(outside, WORKSPACE, exists), outside);
	});

	test('ключи платформы, пути контейнера и относительные пути путями хоста не считаются', () => {
		assert.strictEqual(hostPathOutside('/DisableStartupMessages', WORKSPACE, fs.existsSync), undefined);
		assert.strictEqual(hostPathOutside('/workspace/build/report.xml', WORKSPACE, () => true), undefined);
		assert.strictEqual(hostPathOutside('./build/ib', WORKSPACE, () => true), undefined);
		assert.strictEqual(hostPathOutside(path.join(ROOT, 'src'), WORKSPACE, () => true), undefined);
	});

	test('база из строки подключения вне проекта', () => {
		assert.strictEqual(fileInfobaseOutside('/F./build/ib', ROOT), undefined);
		assert.strictEqual(fileInfobaseOutside('/F"./build/ib"', ROOT), undefined);
		assert.strictEqual(fileInfobaseOutside('/F../bases/erp', ROOT), '../bases/erp');
		const absolute = path.join(os.tmpdir(), 'bases', 'erp');
		assert.strictEqual(fileInfobaseOutside(`/F${absolute}`, ROOT), absolute);
		assert.strictEqual(fileInfobaseOutside('/Ssrv-1c\\erp', ROOT), undefined);
	});

	test('пути внутри строки параметров платформы переводятся, ключи остаются', () => {
		const src = path.join(ROOT, 'build', 'edt export');
		const list = path.join(ROOT, 'build', 'objlist.txt');
		const additional = `/LoadConfigFromFiles "${src}" -listFile ${list} /DisableStartupMessages`;
		assert.strictEqual(
			containerPathsInText(additional, WORKSPACE),
			'/LoadConfigFromFiles "/workspace/build/edt export" -listFile /workspace/build/objlist.txt /DisableStartupMessages'
		);
		assert.deepStrictEqual(textTokens(additional), ['/LoadConfigFromFiles', src, '-listFile', list, '/DisableStartupMessages']);
	});
});
