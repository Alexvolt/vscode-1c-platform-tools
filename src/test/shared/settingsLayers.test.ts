import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { syntaxCheckAllurePathsFromEnv, syntaxCheckJUnitPathFromEnv } from '../../features/testing/projectTestConfig';
import { writeLocalRunner } from '../fixtures/helpers/vrunnerStub';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'settingsLayers');

/**
 * vanessa-runner 3 накладывает именованный профиль на autumn-properties.json
 * проекта: расширение читает значения профиля так же.
 */
suite('именованный профиль vanessa-runner 3 поверх autumn-properties.json', () => {
	const vrunner = VRunnerManager.getInstance();
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-layers-'));
		fs.cpSync(FIXTURE, root, { recursive: true });
		writeLocalRunner(root, '3.0.0');
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});

	async function withDevProfile(body: () => Promise<void>): Promise<void> {
		await vrunner.runWithProjectRoot(root, async () => {
			await vrunner.getVRunnerVersion();
			await vrunner.setActiveEnvProfileId('dev');
			await body();
		});
	}

	test('чего нет в профиле, берётся из файла проекта', async () => {
		await withDevProfile(async () => {
			assert.strictEqual(vrunner.getActiveEnvFile(), 'autumn-properties.dev.json');
			assert.deepStrictEqual(vrunner.settingsLayerFiles('autumn-properties.dev.json'), [
				'autumn-properties.dev.json',
				'autumn-properties.json',
			]);
			assert.deepStrictEqual(vrunner.settingsLayerFiles('autumn-properties.json'), ['autumn-properties.json']);
			assert.strictEqual(vrunner.readActiveProfileSettingSync('ibconnection'), '/F./build/base');
			assert.strictEqual(await vrunner.getActiveV8Version(), '8.3.27');
			assert.deepStrictEqual(vrunner.getActiveEnvOverrideArgs(), ['--db-user', 'user-${gitBranch}']);

			const { settings, schema } = await vrunner.readSettingsLayers('autumn-properties.dev.json');
			assert.strictEqual(schema, 'v3');
			assert.deepStrictEqual(
				(settings as { vrunner: { validate: { 'syntax-check': unknown } } }).vrunner.validate['syntax-check'],
				{ 'report-format': ['junit', 'allure'], 'report-path': 'build/out/sc' }
			);
		});
	});

	test('строка подключения из файла проекта задана и под именованным профилем', async () => {
		await withDevProfile(async () => {
			assert.strictEqual(await vrunner.getConfiguredIbConnection(), '/F./build/base');
			assert.strictEqual(await vrunner.getConfiguredIbConnection('autumn-properties.dev.json'), '/F./build/base');
		});
	});

	test('отчёт синтаксического контроля ищется там, куда его пишет vanessa-runner', async () => {
		await withDevProfile(async () => {
			const { settings, schema } = await vrunner.readActiveSettings();
			assert.strictEqual(syntaxCheckJUnitPathFromEnv(settings, schema), 'build/out/sc/junit.xml');
			assert.deepStrictEqual(syntaxCheckAllurePathsFromEnv(settings, schema), ['build/out/sc/allure']);
		});
	});
});
