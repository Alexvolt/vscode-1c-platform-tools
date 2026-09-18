import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	cachedReleaseComponent,
	clearReleaseCache,
	ensureReleaseComponent,
	installReleaseAsset,
	type ReleaseComponentSpec,
} from '../../shared/githubReleaseLoader';
import { ComponentBusyError } from '../../shared/cacheDir';

async function waitFor(condition: () => boolean, limitMs = 5000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('условие не выполнилось вовремя');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite('кэш внешнего компонента', () => {
	const spec: ReleaseComponentSpec = {
		repoSlug: 'yellow-hammer/проба',
		cacheSubdir: 'проба',
		stampName: '.проба.json',
		assetRegex: /^файл\.bin$/i,
		label: 'Проба',
		extract: false,
	};

	let baseDir = '';
	let sourceFile = '';

	const versions = (): string[] =>
		fs
			.readdirSync(path.join(baseDir, spec.cacheSubdir))
			.filter((entry) => entry !== spec.stampName)
			.sort();

	setup(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'components-'));
		sourceFile = path.join(baseDir, 'файл.bin');
		fs.writeFileSync(sourceFile, 'содержимое', 'utf8');
	});

	teardown(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	test('артефакт ложится в кэш и находится по штампу', async () => {
		const installed = await installReleaseAsset(baseDir, spec, {
			tag: 'v1.0.0',
			assetName: 'файл.bin',
			sourceFile,
		});
		assert.ok(fs.existsSync(installed.assetPath), 'артефакта нет в кэше');
		const cached = await cachedReleaseComponent(baseDir, spec);
		assert.strictEqual(cached?.tag, 'v1.0.0');
		assert.strictEqual(cached?.assetPath, installed.assetPath);
	});

	test('прежняя версия убирается, когда встала новая', async () => {
		await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });
		await installReleaseAsset(baseDir, spec, { tag: 'v1.1.0', assetName: 'файл.bin', sourceFile });
		assert.deepStrictEqual(versions(), ['v1.1.0']);
	});

	test('файлы кэша освобождаются до замены и до очистки', async () => {
		const versionsSeen: string[][] = [];
		const cacheDir = path.join(baseDir, spec.cacheSubdir);
		const holding: ReleaseComponentSpec = {
			...spec,
			beforeReplace: async () => {
				versionsSeen.push(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((entry) => entry !== spec.stampName) : []);
			},
		};

		await installReleaseAsset(baseDir, holding, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });
		await installReleaseAsset(baseDir, holding, { tag: 'v1.1.0', assetName: 'файл.bin', sourceFile });
		await clearReleaseCache(baseDir, holding);

		assert.deepStrictEqual(versionsSeen, [[], ['v1.0.0'], ['v1.1.0']]);
		assert.ok(!fs.existsSync(cacheDir));
	});

	test('запущенную версию очистка не трогает', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const installed = await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });
		const held = fs.openSync(installed.assetPath, 'r');
		try {
			await assert.rejects(clearReleaseCache(baseDir, spec), ComponentBusyError);

			assert.deepStrictEqual(await cachedReleaseComponent(baseDir, spec), installed);
			assert.strictEqual(fs.readFileSync(installed.assetPath, 'utf8'), 'содержимое');
		} finally {
			fs.closeSync(held);
		}
	});

	test('та же версия, уже поставленная другим окном, не ставится заново', async () => {
		const first = await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });
		fs.writeFileSync(sourceFile, 'загружено вторым окном', 'utf8');

		const second = await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });

		assert.deepStrictEqual(second, first);
		assert.strictEqual(fs.readFileSync(first.assetPath, 'utf8'), 'содержимое');
	});

	test('загрузки живых окон остаются, завершившихся убираются', async () => {
		const cacheDir = path.join(baseDir, spec.cacheSubdir);
		const live = `_dl-${process.ppid}-live`;
		for (const entry of [live, '_dl-999999999-dead', '_dl']) {
			fs.mkdirSync(path.join(cacheDir, entry), { recursive: true });
			fs.writeFileSync(path.join(cacheDir, entry, 'файл.bin'), 'часть', 'utf8');
		}

		await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });

		assert.deepStrictEqual(versions(), [live, 'v1.0.0']);
	});

	test('первое обращение к кэшу за сеанс убирает прежние версии', async () => {
		const cacheDir = path.join(baseDir, spec.cacheSubdir);
		const assetPath = path.join(cacheDir, 'v1.1.0', 'файл.bin');
		for (const file of [assetPath, path.join(cacheDir, 'v1.0.0', 'файл.bin'), path.join(cacheDir, '_dl-999999999-dead', 'файл.bin')]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'содержимое', 'utf8');
		}
		const stamp = { tag: 'v1.1.0', assetPath, assetName: 'файл.bin', lastCheckMs: Date.now() };
		fs.writeFileSync(path.join(cacheDir, spec.stampName), JSON.stringify(stamp), 'utf8');

		const cached = await ensureReleaseComponent(baseDir, spec, '');

		assert.deepStrictEqual(cached, { tag: 'v1.1.0', assetPath });
		await waitFor(() => versions().length === 1);
		assert.deepStrictEqual(versions(), ['v1.1.0']);
	});

	test('запущенная версия не перезаписывается: та же версия без штампа ложится рядом, прежняя остаётся целой', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const first = await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });
		fs.rmSync(path.join(baseDir, spec.cacheSubdir, spec.stampName));
		fs.writeFileSync(sourceFile, 'новое содержимое', 'utf8');
		const held = fs.openSync(first.assetPath, 'r');
		try {
			const second = await installReleaseAsset(baseDir, spec, { tag: 'v1.0.0', assetName: 'файл.bin', sourceFile });

			assert.notStrictEqual(second.assetPath, first.assetPath);
			assert.deepStrictEqual(await cachedReleaseComponent(baseDir, spec), second);
			assert.strictEqual(fs.readFileSync(first.assetPath, 'utf8'), 'содержимое');
			assert.strictEqual(fs.readFileSync(second.assetPath, 'utf8'), 'новое содержимое');
		} finally {
			fs.closeSync(held);
		}
	});
});
