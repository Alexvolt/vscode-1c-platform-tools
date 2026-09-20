/**
 * Отчёт mutatos в JSON: сводка прогона и выжившие мутанты по файлам проекта.
 *
 * Ключ файла в отчёте считается от общего каталога файлов с мутантами, а не от
 * корня проекта, поэтому файл на диске ищется под каталогом исходников прогона
 * по этому общему каталогу или по суффиксу пути.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Позиция в отчёте: строки и колонки с единицы. */
interface ReportPosition {
	line?: number;
	column?: number;
}

/** Мутант в отчёте. */
interface ReportMutant {
	mutatorName?: string;
	replacement?: string;
	description?: string;
	status?: string;
	location?: { start?: ReportPosition; end?: ReportPosition };
}

/** Файл в отчёте. */
interface ReportFile {
	mutants?: ReportMutant[];
}

/** Отчёт прогона. */
export interface MutationReport {
	files: Record<string, ReportFile>;
}

/** Число мутантов по исходам. */
export interface MutantCounts {
	killed: number;
	timeout: number;
	survived: number;
	noCoverage: number;
	/** Мутанты с ошибкой компиляции или прогона и прочими исходами */
	errors: number;
}

/** Позиция в документе: строки и символы с нуля. */
export interface DocumentPosition {
	line: number;
	character: number;
}

/** Выживший мутант в файле проекта. */
export interface SurvivedMutant {
	/** Абсолютный путь к файлу */
	file: string;
	start: DocumentPosition;
	/** Конец не включается */
	end: DocumentPosition;
	/** Что заменено на что */
	change: string;
	/** Мутатор словами */
	mutator?: string;
}

/** Итог прогона по отчёту. */
export interface MutationSummary {
	counts: MutantCounts;
	/** Индекс мутаций в процентах с точностью до десятой */
	index: number;
	survivors: SurvivedMutant[];
	/** Выжившие, которых не показать: файл не нашёлся или в отчёте нет позиции */
	unmapped: number;
}

/**
 * Разбирает текст отчёта.
 *
 * @param text - Содержимое JSON
 * @returns Отчёт
 * @throws Error, если это не отчёт mutatos
 */
export function parseMutationReport(text: string): MutationReport {
	const data = JSON.parse(text.replace(/^﻿/, '')) as { files?: unknown };
	if (!data || typeof data.files !== 'object' || data.files === null || Array.isArray(data.files)) {
		throw new Error('в отчёте нет раздела files');
	}
	return { files: data.files as Record<string, ReportFile> };
}

/** Мутанты файла отчёта. */
function mutantsOf(file: ReportFile): ReportMutant[] {
	return Array.isArray(file?.mutants) ? file.mutants : [];
}

/**
 * Число мутантов по исходам.
 *
 * @param report - Отчёт
 */
export function countMutants(report: MutationReport): MutantCounts {
	const counts: MutantCounts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, errors: 0 };
	for (const file of Object.values(report.files)) {
		for (const mutant of mutantsOf(file)) {
			switch (mutant.status) {
				case 'Killed':
					counts.killed += 1;
					break;
				case 'Timeout':
					counts.timeout += 1;
					break;
				case 'Survived':
					counts.survived += 1;
					break;
				case 'NoCoverage':
					counts.noCoverage += 1;
					break;
				default:
					counts.errors += 1;
			}
		}
	}
	return counts;
}

/**
 * Индекс мутаций так же, как у mutatos: доля убитых и прерванных по таймауту
 * среди проверенных, в процентах с округлением до десятой. Без покрытия и с
 * ошибкой в расчёт не входят.
 *
 * @param counts - Число мутантов по исходам
 * @returns Индекс; 0, если проверенных нет
 */
export function mutationScore(counts: MutantCounts): number {
	const detected = counts.killed + counts.timeout;
	const checked = detected + counts.survived;
	if (checked === 0) {
		return 0;
	}
	// Десятые доли процента в целых числах: половина округляется вверх без погрешности дробей
	return Math.floor((2000 * detected + checked) / (2 * checked)) / 10;
}

/**
 * Индекс для итога: десятичная запятая, целое без дробной части.
 *
 * @param index - Индекс мутаций
 */
export function formatScore(index: number): string {
	return `${String(index).replace('.', ',')} %`;
}

/**
 * Итог прогона одной строкой: индекс и выжившие, остальные исходы числом, если они есть.
 *
 * Отбор тестов сужает и исходный прогон, поэтому у прогона отобранными тестами
 * мутанты вне их покрытия показываются всегда. Выжившие, которым не нашлось
 * места в файле проекта, в Problems не попадают, поэтому их число идёт рядом.
 *
 * @param title - Название прогона
 * @param summary - Итог по отчёту
 * @param selected - Прогон отобранными тестами
 */
export function summaryLine(title: string, summary: MutationSummary, selected = false): string {
	const { counts } = summary;
	const parts = [`индекс ${formatScore(summary.index)}`, `выжило ${counts.survived}`];
	if (summary.unmapped > 0) {
		parts.push(`из них не показано ${summary.unmapped}`);
	}
	if (selected) {
		parts.push(`не покрыто отобранными тестами ${counts.noCoverage}`);
	} else if (counts.noCoverage > 0) {
		parts.push(`без покрытия ${counts.noCoverage}`);
	}
	if (counts.errors > 0) {
		parts.push(`ошибок ${counts.errors}`);
	}
	return `${title}: ${parts.join(', ')}`;
}

/** Выживший мутант для ответа агенту: путь от корня проекта, позиции с единицы. */
export interface SurvivedMutantData {
	file: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	change: string;
	mutator?: string;
}

/**
 * Итог прогона для ответа агенту.
 *
 * @param summary - Итог по отчёту
 * @param root - Корень проекта
 */
export function summaryData(summary: MutationSummary, root: string): {
	index: number;
	killed: number;
	timeout: number;
	survived: number;
	noCoverage: number;
	errors: number;
	/** Выжившие, которым не нашлось места в файле проекта: в survivors их нет */
	unmapped: number;
	survivors: SurvivedMutantData[];
} {
	return {
		index: summary.index,
		...summary.counts,
		unmapped: summary.unmapped,
		survivors: summary.survivors.map((mutant) => ({
			file: path.relative(root, mutant.file).split(path.sep).join('/'),
			line: mutant.start.line + 1,
			column: mutant.start.character + 1,
			endLine: mutant.end.line + 1,
			endColumn: mutant.end.character + 1,
			change: mutant.change,
			...(mutant.mutator ? { mutator: mutant.mutator } : {}),
		})),
	};
}

/**
 * Имя мутатора словами: `ОтрицаниеУсловия` становится «отрицание условия».
 *
 * @param name - Имя мутатора из отчёта
 */
export function mutatorWords(name: string): string {
	return name
		.replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, '$1 $2')
		.toLowerCase()
		.trim();
}

/** Что заменено на что; без описания только замена. */
function changeOf(mutant: ReportMutant): string {
	if (typeof mutant.description === 'string' && mutant.description.trim() !== '') {
		return mutant.description.trim();
	}
	if (typeof mutant.replacement === 'string') {
		return `заменено на ${mutant.replacement}`;
	}
	return '';
}

/** Позиция отчёта в позиции документа; undefined, если строки нет. */
function documentPosition(position: ReportPosition | undefined): DocumentPosition | undefined {
	if (!position || typeof position.line !== 'number' || !Number.isFinite(position.line)) {
		return undefined;
	}
	const column = typeof position.column === 'number' && Number.isFinite(position.column) ? position.column : 1;
	return { line: Math.max(position.line - 1, 0), character: Math.max(column - 1, 0) };
}

/** Путь через прямые слэши; на Windows без учёта регистра. */
function comparable(file: string, platform: NodeJS.Platform): string {
	const slashed = file.replaceAll('\\', '/');
	return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Файлы каталога и его подкаталогов.
 *
 * @param dir - Каталог
 * @returns Абсолютные пути; пусто, если каталога нет
 */
export function listFiles(dir: string): string[] {
	const found: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...listFiles(full));
		} else if (entry.isFile()) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Файлы проекта для ключей отчёта.
 *
 * Ключи одного отчёта считаются от одного общего каталога, поэтому сначала
 * ищется он: каталог, под которым лежат файлы всех ключей сразу. Одинокий ключ
 * или ключи, у которых общего каталога не нашлось, ищутся по суффиксу пути.
 *
 * @param keys - Ключи файлов отчёта
 * @param files - Абсолютные пути файлов под каталогом исходников прогона
 * @param platform - Платформа: на Windows регистр не важен
 * @returns Файл для каждого ключа; undefined, если такого файла нет или их несколько
 */
export function resolveReportFiles(
	keys: readonly string[],
	files: readonly string[],
	platform: NodeJS.Platform = process.platform
): Map<string, string | undefined> {
	const byPath = new Map(files.map((file) => [comparable(file, platform), file]));
	const suffixOf = (key: string): string => `/${comparable(key, platform).replace(/^\/+/, '')}`;
	const matching = (key: string): string[] => {
		const suffix = suffixOf(key);
		return [...byPath.keys()].filter((file) => file.endsWith(suffix));
	};

	const resolved = new Map<string, string | undefined>();
	const base = commonDirectory(keys, matching, suffixOf);
	for (const key of keys) {
		const matches = base === undefined ? matching(key) : [`${base}${suffixOf(key)}`];
		resolved.set(key, matches.length === 1 ? byPath.get(matches[0]) : undefined);
	}
	return resolved;
}

/**
 * Каталог, от которого считаются ключи отчёта: под ним находится файл каждого
 * ключа. Пока таких каталогов больше одного, общий не определён.
 *
 * @param keys - Ключи файлов отчёта
 * @param matching - Файлы, чей путь оканчивается ключом
 * @param suffixOf - Ключ в виде суффикса пути
 * @returns Каталог для сравнения путей или undefined
 */
function commonDirectory(
	keys: readonly string[],
	matching: (key: string) => string[],
	suffixOf: (key: string) => string
): string | undefined {
	let directories: string[] | undefined;
	for (const key of keys) {
		const suffix = suffixOf(key);
		const found = matching(key).map((file) => file.slice(0, file.length - suffix.length));
		directories = directories === undefined ? found : directories.filter((dir) => found.includes(dir));
		if (directories.length === 0) {
			return undefined;
		}
	}
	return directories?.length === 1 ? directories[0] : undefined;
}

/**
 * Итог прогона: число мутантов по исходам, индекс и выжившие в файлах проекта.
 *
 * @param report - Отчёт
 * @param files - Абсолютные пути файлов под каталогом исходников прогона
 * @param platform - Платформа
 */
export function summarizeReport(
	report: MutationReport,
	files: readonly string[],
	platform: NodeJS.Platform = process.platform
): MutationSummary {
	const counts = countMutants(report);
	const resolved = resolveReportFiles(Object.keys(report.files), files, platform);
	const survivors: SurvivedMutant[] = [];
	let unmapped = 0;
	for (const [key, file] of Object.entries(report.files)) {
		for (const mutant of mutantsOf(file)) {
			if (mutant.status !== 'Survived') {
				continue;
			}
			const target = resolved.get(key);
			const start = documentPosition(mutant.location?.start);
			if (!target || !start) {
				unmapped += 1;
				continue;
			}
			const end = documentPosition(mutant.location?.end);
			const endsAfterStart = end !== undefined
				&& (end.line > start.line || (end.line === start.line && end.character >= start.character));
			survivors.push({
				file: target,
				start,
				end: endsAfterStart ? end : start,
				change: changeOf(mutant),
				mutator: typeof mutant.mutatorName === 'string' && mutant.mutatorName.trim() !== ''
					? mutatorWords(mutant.mutatorName)
					: undefined,
			});
		}
	}
	survivors.sort((left, right) =>
		left.file.localeCompare(right.file)
		|| left.start.line - right.start.line
		|| left.start.character - right.start.character
	);
	return { counts, index: mutationScore(counts), survivors, unmapped };
}
