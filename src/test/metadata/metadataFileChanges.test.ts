import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	metadataFileVersion,
	notifyMetadataFileMoved,
	notifyMetadataFilesChanged,
	watchMetadataFile,
	type MetadataFileWatch,
} from '../../features/metadata/metadataFileChanges';

/** Описание объекта, которое показывает панель. */
const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/designer/src/cf/Catalogs/Валюты.xml');

/** Пауза, после которой наблюдатель проверяет версию: в тестах короче, чем в панели. */
const SETTLE_MS = 20;

/** Сколько ждать, что событие не придёт. */
const QUIET_MS = 300;

/** Сколько ждать события файловой системы. */
const WATCHER_MS = 5000;

interface Watched {
	readonly file: string;
	readonly watch: MetadataFileWatch;
	/** Сколько раз наблюдатель сообщил о расхождении. */
	count(): number;
	/** Ждёт следующего сообщения. */
	next(timeoutMs?: number): Promise<void>;
}

async function watched(): Promise<Watched> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-file-changes-'));
	const file = path.join(directory, 'Валюты.xml');
	fs.copyFileSync(FIXTURE, file);
	const watch = watchMetadataFile(file, await metadataFileVersion(file), SETTLE_MS);
	let fired = 0;
	let waiter: (() => void) | undefined;
	watch.onDidChange(() => {
		fired += 1;
		waiter?.();
	});
	cleanups.push(() => {
		watch.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return {
		file,
		watch,
		count: () => fired,
		next: (timeoutMs = WATCHER_MS) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('наблюдатель промолчал')), timeoutMs);
				waiter = () => {
					clearTimeout(timer);
					waiter = undefined;
					resolve();
				};
			}),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const cleanups: Array<() => void> = [];

suite('изменения файлов описаний', () => {
	teardown(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	test('правка через md-sparrow будит наблюдателя, та же запись повторно нет', async () => {
		const { file, count, next } = await watched();
		await sleep(QUIET_MS);
		assert.strictEqual(count(), 0, 'без правок сообщений нет');

		const changed = next();
		fs.appendFileSync(file, '\n');
		notifyMetadataFilesChanged([file]);
		await changed;
		assert.strictEqual(count(), 1);

		notifyMetadataFilesChanged([file]);
		await sleep(QUIET_MS);
		assert.strictEqual(count(), 1, 'версия уже сообщена');
	});

	test('своя операция с запоминанием версии не будит наблюдателя', async () => {
		const { file, watch, count } = await watched();
		await watch.run(async () => {
			fs.appendFileSync(file, '\n');
			notifyMetadataFilesChanged([file]);
			await sleep(QUIET_MS);
			await watch.remember();
		});
		await sleep(QUIET_MS);
		assert.strictEqual(count(), 0);
	});

	test('чужая запись во время своей операции видна после неё', async () => {
		const { file, watch, count, next } = await watched();
		const changed = next();
		await watch.run(async () => {
			await watch.remember();
			fs.appendFileSync(file, '\n');
			notifyMetadataFilesChanged([file]);
			await sleep(QUIET_MS);
			assert.strictEqual(count(), 0, 'во время операции сообщение откладывается');
		});
		await changed;
		assert.strictEqual(count(), 1);
	});

	test('удаление файла тоже изменение', async () => {
		const { file, next } = await watched();
		const changed = next();
		fs.rmSync(file);
		notifyMetadataFilesChanged([file]);
		await changed;
	});

	test('файл, вернувшийся тем же содержимым, будит наблюдателя, если отсутствие запомнили', async () => {
		const { file, watch, next } = await watched();
		const content = fs.readFileSync(file);
		const deleted = next();
		fs.rmSync(file);
		notifyMetadataFilesChanged([file]);
		await deleted;
		await watch.remember();
		const restored = next();
		fs.writeFileSync(file, content);
		notifyMetadataFilesChanged([file]);
		await restored;
	});

	test('переименование объекта помнится, пока файла нет на месте', async () => {
		const { file, watch } = await watched();
		const renamed = path.join(path.dirname(file), 'Деньги.xml');
		const directory = path.dirname(file);
		const from = path.join(directory, '..', path.basename(directory), 'Валюты.xml');
		notifyMetadataFileMoved({ from, to: renamed });
		assert.strictEqual(watch.moved()?.to, renamed, 'путь сравнивается после нормализации');
		const content = fs.readFileSync(file);
		fs.rmSync(file);
		await watch.remember();
		assert.strictEqual(watch.moved()?.to, renamed);
		fs.writeFileSync(file, content);
		await watch.remember();
		assert.strictEqual(watch.moved(), undefined, 'файл снова на месте');
	});

	test('запись на диск со стороны ловит наблюдатель файловой системы', async () => {
		const { file, next } = await watched();
		// Наблюдатель файловой системы заводится не сразу
		await sleep(QUIET_MS);
		const changed = next();
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Валюты', 'Валюты2'), 'utf8');
		await changed;
	});
});
