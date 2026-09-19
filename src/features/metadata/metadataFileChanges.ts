/**
 * Изменения файлов описаний метаданных для тех, кто показывает прочитанное.
 *
 * Сигнал приходит двумя путями. Правка через md-sparrow сообщает о своих файлах
 * сразу после записи: дерево, палитра и панели пишут одним каналом. Запись со
 * стороны (git, внешний редактор, конфигуратор) ловит наблюдатель файловой
 * системы. Своё от чужого отличает версия содержимого: её запоминают перед
 * чтением, и событие без расхождения с ней ничего не значит. Переименование и
 * удаление объекта сообщают ещё и куда ушёл его файл.
 *
 * @module metadataFileChanges
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { directoryKey } from '../../shared/projectLayout';

const changed = new vscode.EventEmitter<readonly string[]>();

/** Файлы описаний, которые записала правка через md-sparrow. */
export const onDidChangeMetadataFiles: vscode.Event<readonly string[]> = changed.event;

/**
 * Сообщает о записанных файлах описаний.
 *
 * @param files - Пути к файлам; пустые пропускаются
 */
export function notifyMetadataFilesChanged(files: readonly (string | undefined)[]): void {
	const written = files.filter((file): file is string => typeof file === 'string' && file.length > 0);
	if (written.length > 0) {
		changed.fire(written);
	}
}

/** Файл описания ушёл с места по правке через md-sparrow. */
export interface MetadataFileMove {
	readonly from: string;
	/** Новый путь переименованного объекта; у удалённого его нет. */
	readonly to?: string;
}

const moved = new vscode.EventEmitter<MetadataFileMove>();

/**
 * Сообщает, что объект переименован или удалён: о записи его файлов сообщают отдельно.
 *
 * @param move - Прежний путь к описанию и новый, если объект переименован
 */
export function notifyMetadataFileMoved(move: MetadataFileMove): void {
	moved.fire(move);
}

/** Запись идёт пачкой событий: проверяем версию, когда они стихли. */
const SETTLE_MS = 300;

/** Версия отсутствующего файла: удаление и переименование тоже изменение. */
const MISSING = 'нет файла';

/**
 * Версия содержимого файла: хеш байтов. Запись того же содержимого версию не меняет.
 *
 * @param file - Путь к файлу
 */
export async function metadataFileVersion(file: string): Promise<string> {
	try {
		return createHash('sha1').update(await fs.readFile(file)).digest('hex');
	} catch {
		return MISSING;
	}
}

/** Слежение за файлом описания, который показывает панель. */
export interface MetadataFileWatch extends vscode.Disposable {
	/** Содержимое на диске разошлось с запомненной версией. */
	readonly onDidChange: vscode.Event<void>;
	/** Запоминает версию на диске: зовётся перед каждым чтением, в том числе когда файла нет. */
	remember(): Promise<void>;
	/** Переименование или удаление объекта, после которого файла нет на месте. */
	moved(): MetadataFileMove | undefined;
	/**
	 * Своя операция над файлом: события в это время откладываются и проверяются
	 * после неё, когда версия уже запомнена заново.
	 */
	run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Следит за файлом описания: правки через md-sparrow и запись на диск со стороны.
 *
 * О расхождении сообщает один раз на версию: повторные события той же записи
 * не будят подписчика снова. Первая проверка идёт сразу: файл мог измениться,
 * пока его читали.
 *
 * @param file - Путь к файлу описания
 * @param known - Версия, с которой читали файл, от {@link metadataFileVersion}
 * @param settleMs - Пауза, после которой проверяется версия
 */
export function watchMetadataFile(file: string, known: string, settleMs = SETTLE_MS): MetadataFileWatch {
	const key = directoryKey(file);
	const emitter = new vscode.EventEmitter<void>();
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file))
	);
	let version = known;
	let reported: string | undefined;
	let move: MetadataFileMove | undefined;
	let busy = 0;
	let missed = false;
	let disposed = false;
	let timer: NodeJS.Timeout | undefined;

	const check = async (): Promise<void> => {
		timer = undefined;
		if (disposed) {
			return;
		}
		if (busy > 0) {
			missed = true;
			return;
		}
		const current = await metadataFileVersion(file);
		if (disposed) {
			return;
		}
		// Своя операция началась, пока читали файл: проверка повторится после неё
		if (busy > 0) {
			missed = true;
			return;
		}
		if (current === version || current === reported) {
			return;
		}
		reported = current;
		emitter.fire();
	};

	const schedule = (): void => {
		if (disposed) {
			return;
		}
		if (busy > 0) {
			missed = true;
			return;
		}
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => void check(), settleMs);
	};

	const subscriptions: vscode.Disposable[] = [
		watcher,
		watcher.onDidChange(schedule),
		watcher.onDidCreate(schedule),
		watcher.onDidDelete(schedule),
		onDidChangeMetadataFiles((files) => {
			if (files.some((item) => directoryKey(item) === key)) {
				schedule();
			}
		}),
		moved.event((item) => {
			if (directoryKey(item.from) === key) {
				move = item;
			}
		}),
		emitter,
	];

	schedule();

	return {
		onDidChange: emitter.event,
		async remember(): Promise<void> {
			version = await metadataFileVersion(file);
			reported = undefined;
			// Файл снова на месте: прежнее переименование или удаление к нему уже не относится
			if (version !== MISSING) {
				move = undefined;
			}
		},
		moved(): MetadataFileMove | undefined {
			return move;
		},
		async run<T>(operation: () => Promise<T>): Promise<T> {
			busy += 1;
			try {
				return await operation();
			} finally {
				busy -= 1;
				if (busy === 0 && missed) {
					missed = false;
					schedule();
				}
			}
		},
		dispose(): void {
			disposed = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
		},
	};
}
