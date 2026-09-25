import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { writeLocalRunner, writeFlakyRunner } from '../fixtures/helpers/vrunnerStub';

/**
 * Схема файла настроек зависит от версии раннера, а версия известна только после
 * детекта. Панели, построенные до него, перестраиваются по событию, поэтому
 * первое определение обязано его поднять.
 */
suite('версия vanessa-runner: событие первого определения', () => {
	const vrunner = VRunnerManager.getInstance();
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrunner-version-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});

	test('первое определение оповещает подписчиков и меняет схему настроек', async () => {
		writeLocalRunner(root, '3.0.0');
		let fired = 0;
		const subscription = vrunner.onDidChangeVRunnerVersion(() => {
			fired++;
		});
		try {
			await vrunner.runWithProjectRoot(root, async () => {
				assert.strictEqual(vrunner.getActiveSettingsSchema(), 'v2', 'до детекта схема считается 2.x');

				await vrunner.getVRunnerVersion();
				assert.strictEqual(fired, 1, 'после первого определения панели должны перестроиться');
				assert.strictEqual(vrunner.getActiveSettingsSchema(), 'v3');

				await vrunner.getVRunnerVersion();
				assert.strictEqual(fired, 1, 'ответ из кэша событие не поднимает');
			});
		} finally {
			subscription.dispose();
		}
	});
});

suite('версия vanessa-runner: переустановка в другом проекте', () => {
	const vrunner = VRunnerManager.getInstance();
	let root: string;
	let other: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrunner-reinstall-'));
		other = fs.mkdtempSync(path.join(os.tmpdir(), 'vrunner-current-'));
	});

	teardown(() => {
		for (const dir of [root, other]) {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	test('смена установки проекта, который сейчас не текущий, обновляет его версию', async () => {
		writeLocalRunner(root, '2.6.0');
		await vrunner.runWithProjectRoot(root, () => vrunner.getVRunnerVersion());
		writeLocalRunner(root, '3.0.0');

		await vrunner.runWithProjectRoot(other, () => vrunner.refreshVRunnerVersion(root));

		assert.strictEqual(await vrunner.runWithProjectRoot(root, async () => vrunner.getCachedVRunnerVersionLabel()), '3.0.0');
	});

	test('версию корня, для которого её не определяли, переустановка не определяет', async () => {
		writeLocalRunner(other, '3.0.0');

		await vrunner.runWithProjectRoot(root, () => vrunner.refreshVRunnerVersion(other));

		assert.strictEqual(await vrunner.runWithProjectRoot(other, async () => vrunner.getCachedVRunnerVersionLabel()), undefined);
	});
});

/**
 * Неудачный детект (например, Docker-контейнер не успел стартовать на холодном
 * старте) не должен залипать на всю сессию: следующий вызов обязан попробовать
 * определить версию заново, а не отдавать зависшую неопределённость навсегда.
 */
suite('версия vanessa-runner: неудачный детект не кэшируется навсегда', () => {
	const vrunner = VRunnerManager.getInstance();
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrunner-flaky-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});

	test('после провалившегося детекта следующий вызов переопределяет версию, а не отдаёт зависший undefined', async () => {
		// Оба способа детекта (--version, version) должны провалиться один раз —
		// имитация: контейнер/раннер ещё не был готов на самом первом вызове.
		writeFlakyRunner(root, '3.0.1', 2);

		await vrunner.runWithProjectRoot(root, async () => {
			const first = await vrunner.getVRunnerVersion();
			assert.strictEqual(first, undefined, 'первый детект должен провалиться (симулируем холодный старт)');

			const second = await vrunner.getVRunnerVersion();
			assert.strictEqual(
				second?.raw,
				'3.0.1',
				'после неудачи следующий вызов должен переопределить версию, а не отдать зависший undefined'
			);
		});
	});
});
