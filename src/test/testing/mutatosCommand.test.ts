import * as assert from 'node:assert';
import * as path from 'node:path';
import { runMutationTesting } from '../../features/testing/mutatos/mutatosCommand';
import type { StructuredCommandResult } from '../../shared/commandExecutionTypes';
import type { VRunnerManager } from '../../shared/vrunnerManager';

/**
 * Проекты с установленным mutatos: на 1testrunner (раннер OneUnit в проекте не
 * стоит) и на OneUnit без каталога исходников.
 */
const FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/mutatos');

/** Менеджер проекта: до запуска задачи у него спрашивают только пути. */
function vrunnerOf(root: string): VRunnerManager {
	return {
		getWorkspaceRoot: () => root,
		getOutPath: () => 'build/out',
		getDistPath: () => 'build/dist',
	} as unknown as VRunnerManager;
}

async function runIn(fixture: string): Promise<StructuredCommandResult> {
	const result = await runMutationTesting(vrunnerOf(path.join(FIXTURES, fixture)), { wait: true });
	assert.ok(result, 'ответ агенту не получен');
	return result;
}

suite('mutatos: отказы до запуска задачи', () => {
	test('проект на 1testrunner: мутанты проверять нечем', async () => {
		const result = await runIn('onetest');

		assert.strictEqual(result.success, false);
		assert.match(result.stderr, /1testrunner/);
	});

	test('исходников OneScript нет: прогон не запускается', async () => {
		const result = await runIn('nosources');

		assert.strictEqual(result.success, false);
		assert.match(result.stderr, /Исходников OneScript в проекте нет/);
	});
});
