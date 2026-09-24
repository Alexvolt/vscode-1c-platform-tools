import * as assert from 'node:assert';
import * as path from 'node:path';
import { serviceFolderDecoration } from '../../features/serviceFiles/serviceFolderDecoration';

suite('метка каталога .1cpt', () => {
	const root = path.join(path.sep, 'work', 'erp');

	test('метку получает только сам каталог', () => {
		assert.strictEqual(serviceFolderDecoration(path.join(root, '.1cpt'))?.badge, '1С');
		assert.strictEqual(serviceFolderDecoration(path.join(root, '.1cpt', 'pipelines.json')), undefined);
		assert.strictEqual(serviceFolderDecoration(path.join(root, '.1cpt', 'hooks.json')), undefined);
	});

	test('прочие пути без метки', () => {
		assert.strictEqual(serviceFolderDecoration(path.join(root, 'env.json')), undefined);
		assert.strictEqual(serviceFolderDecoration(path.join(root, '.1cpt', 'notes.md')), undefined);
		assert.strictEqual(serviceFolderDecoration(path.join(root, '.1cpt', 'sub', 'a.json')), undefined);
		assert.strictEqual(serviceFolderDecoration(path.join(root, 'x.1cpt')), undefined);
	});
});
