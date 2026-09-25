import * as assert from 'node:assert';
import * as path from 'node:path';
import { debugSourceFields } from '../../features/debug/debugConfigurations';
import { projectPaths } from '../../shared/projectPaths';

const DESIGNER = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/designer');

suite('отладка: каталоги исходного кода проекта', () => {
	test('кроме конфигурации адаптер получает расширения и внешние обработки с их сборками', async () => {
		const fields = debugSourceFields(await projectPaths(DESIGNER), './build/out', (relative) => relative.replace(/\\/g, '/'));

		assert.strictEqual(fields.rootProject, 'src/cf');
		assert.ok((fields.extensions as string[]).includes('src/cfe/МоёРасширение'));
		assert.ok((fields.extensions as string[]).includes('tests/cfe/Тесты'));
		assert.deepStrictEqual((fields.externalFilesSrc as string[]).slice(0, 2), ['src/epf', 'src/erf']);
		assert.deepStrictEqual(fields.externalFilesBuilds, ['build/out/epf', 'build/out/erf', 'build/out/tests/epf']);
	});
});
