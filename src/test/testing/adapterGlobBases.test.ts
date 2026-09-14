import * as assert from 'node:assert';
import * as path from 'node:path';
import { activeSourceGlobBases, testProcessorGlobBases } from '../../features/testing/adapters/adapterUtils';
import { invalidateProjectLayout } from '../../shared/projectLayout';
import type { VRunnerManager } from '../../shared/vrunnerManager';

/** Рабочая область с проектами EDT. */
const EDT_WORKSPACE = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/edt-workspace');

/** Менеджер vrunner с корнем в фикстуре и путями по умолчанию. */
function vrunnerAt(workspaceRoot: string): VRunnerManager {
	return {
		getWorkspaceRoot: () => workspaceRoot,
	} as unknown as VRunnerManager;
}

suite('базы поиска тестов в раскладке EDT', () => {
	setup(() => {
		invalidateProjectLayout();
	});

	test('базы берутся у конфигурации проекта и всех его расширений', async () => {
		const bases = await activeSourceGlobBases(vrunnerAt(EDT_WORKSPACE));

		assert.deepStrictEqual(bases.sort(), ['ssl31', 'ssl31._ДемоРасширение', 'учёт.РасширениеУчёта'].sort());
	});

	test('проекты с тестовыми обработками отдаются отдельно, обработки решения панели не нужны', async () => {
		const bases = await testProcessorGlobBases(vrunnerAt(EDT_WORKSPACE));

		assert.deepStrictEqual(bases, ['tests/epf/Тесты_Арифметика']);
	});

	test('в раскладке конфигуратора баз проектов нет', async () => {
		const designer = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/designer');

		assert.deepStrictEqual(await activeSourceGlobBases(vrunnerAt(designer)), []);
	});
});
