import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cachedJava, cachedJreVersion, clearJre, installJre, tidyJreCache } from '../../features/metadata/portableJre';
import { ComponentBusyError } from '../../shared/cacheDir';

/** Распакованная JRE из минимума файлов. */
const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/portableJre');
const JDK = 'jdk-21.0.0+1-jre';
const JAVA = process.platform === 'win32' ? 'java.exe' : 'java';

async function waitFor(condition: () => boolean, limitMs = 5000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('условие не выполнилось вовремя');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite('кэш portable JRE', () => {
	let jreRoot = '';

	const unpack = (dir: string): Promise<void> => fs.promises.cp(FIXTURE, dir, { recursive: true });
	const brokenDownload = async (dir: string): Promise<void> => {
		await unpack(dir);
		throw new Error('обрыв загрузки');
	};
	const dirs = (): string[] =>
		fs
			.readdirSync(jreRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	const installDirName = (java: string): string => path.relative(jreRoot, java).split(path.sep)[0];
	const files = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).sort();

	setup(() => {
		jreRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jre-cache-')), 'jre-temurin-21');
	});

	teardown(() => {
		fs.rmSync(path.dirname(jreRoot), { recursive: true, force: true });
	});

	test('JRE ложится в свой каталог и находится по штампу', async () => {
		const java = await installJre(jreRoot, unpack);

		assert.strictEqual(cachedJava(jreRoot), java);
		assert.strictEqual(cachedJreVersion(jreRoot), '21.0.0+1');
		assert.match(installDirName(java), new RegExp(`^${process.pid}-`));
	});

	test('новая JRE сменяет прежнюю, прежний каталог убирается', async () => {
		const first = await installJre(jreRoot, unpack);
		const second = await installJre(jreRoot, unpack);

		assert.notStrictEqual(installDirName(second), installDirName(first));
		assert.strictEqual(cachedJava(jreRoot), second);
		assert.deepStrictEqual(dirs(), [installDirName(second)]);
	});

	test('оборванная загрузка оставляет прежнюю JRE', async () => {
		const first = await installJre(jreRoot, unpack);

		await assert.rejects(installJre(jreRoot, brokenDownload), /обрыв загрузки/);

		assert.strictEqual(cachedJava(jreRoot), first);
		assert.deepStrictEqual(dirs(), [installDirName(first)]);
	});

	test('каталог живого процесса остаётся, завершившегося убирается', async () => {
		const live = path.join(jreRoot, `${process.ppid}-live`);
		const dead = path.join(jreRoot, '999999999-dead');
		await unpack(live);
		await unpack(dead);

		const java = await installJre(jreRoot, unpack);

		assert.deepStrictEqual(dirs(), [installDirName(java), path.basename(live)].sort());
	});

	test('JRE, поставленная другим окном во время загрузки, берётся вместо своей копии', async () => {
		const other = path.join(jreRoot, `${process.ppid}-other`);
		const otherJava = path.join(other, JDK, 'bin', JAVA);
		const downloadWhileOtherInstalls = async (dir: string): Promise<void> => {
			await unpack(dir);
			await unpack(other);
			fs.writeFileSync(path.join(jreRoot, '.java-path'), otherJava, 'utf8');
		};

		const java = await installJre(jreRoot, downloadWhileOtherInstalls);

		assert.strictEqual(java, otherJava);
		assert.deepStrictEqual(dirs(), [path.basename(other)]);
	});

	test('первое обращение к кэшу за сеанс убирает каталоги завершившихся окон', async () => {
		const current = path.join(jreRoot, '999999998-current');
		const live = path.join(jreRoot, `${process.ppid}-live`);
		for (const dir of [current, live, path.join(jreRoot, '999999999-dead')]) {
			await unpack(dir);
		}
		fs.writeFileSync(path.join(jreRoot, '.java-path'), path.join(current, JDK, 'bin', JAVA), 'utf8');

		tidyJreCache(jreRoot);

		await waitFor(() => dirs().length === 2);
		assert.deepStrictEqual(dirs(), [path.basename(current), path.basename(live)].sort());
	});

	test('JRE прежней раскладки находится и убирается новой установкой', async () => {
		const legacy = path.join(jreRoot, 'unpack');
		await unpack(legacy);
		fs.mkdirSync(path.join(jreRoot, '_dl'));
		const legacyJava = path.join(legacy, JDK, 'bin', JAVA);
		fs.writeFileSync(path.join(jreRoot, '.java-path'), legacyJava, 'utf8');

		assert.strictEqual(cachedJava(jreRoot), legacyJava);
		assert.strictEqual(cachedJreVersion(jreRoot), '21.0.0+1');
		const java = await installJre(jreRoot, unpack);

		assert.deepStrictEqual(dirs(), [installDirName(java)]);
	});

	test('очистка забывает JRE и убирает каталоги', async () => {
		await installJre(jreRoot, unpack);

		await clearJre(jreRoot);

		assert.strictEqual(cachedJava(jreRoot), undefined);
		assert.deepStrictEqual(dirs(), []);
	});

	test('запущенную JRE очистка не трогает', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const java = await installJre(jreRoot, unpack);
		const installDir = path.join(jreRoot, installDirName(java));
		const before = files(installDir);
		const held = fs.openSync(java, 'r');
		try {
			await assert.rejects(clearJre(jreRoot), ComponentBusyError);

			assert.strictEqual(cachedJava(jreRoot), java);
			assert.deepStrictEqual(files(installDir), before);
		} finally {
			fs.closeSync(held);
		}
	});

	test('запущенная прежняя JRE остаётся целой, новая ставится рядом', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const first = await installJre(jreRoot, unpack);
		const firstDir = path.join(jreRoot, installDirName(first));
		const before = files(firstDir);
		const held = fs.openSync(first, 'r');
		try {
			const second = await installJre(jreRoot, unpack);

			assert.strictEqual(cachedJava(jreRoot), second);
			assert.deepStrictEqual(files(firstDir), before);
		} finally {
			fs.closeSync(held);
		}
	});
});
