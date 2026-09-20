/**
 * Отчёт mutatos: индекс, выжившие мутанты и их файлы в проекте.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	countMutants,
	formatScore,
	listFiles,
	mutationScore,
	mutatorWords,
	parseMutationReport,
	resolveReportFiles,
	summarizeReport,
	summaryData,
	summaryLine,
	type MutantCounts,
} from '../../features/testing/mutatos/mutatosReport';

/** Проект калькулятора: отчёт настоящего прогона mutatos и исходник из него. */
const CALC = path.resolve(__dirname, '../../../src/test/fixtures/mutatos/calc');
const CALC_SOURCE = path.join(CALC, 'src', 'Классы', 'Калькулятор.os');

function calcReport() {
	return parseMutationReport(fs.readFileSync(path.join(CALC, 'mutations.json'), 'utf8'));
}

/** Текст исходника в позициях документа. */
function textAt(file: string, start: { line: number; character: number }, end: { line: number; character: number }): string {
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	if (start.line === end.line) {
		return lines[start.line].slice(start.character, end.character);
	}
	return [lines[start.line].slice(start.character), ...lines.slice(start.line + 1, end.line), lines[end.line].slice(0, end.character)].join('\n');
}

function counts(values: Partial<MutantCounts>): MutantCounts {
	return { killed: 0, timeout: 0, survived: 0, noCoverage: 0, errors: 0, ...values };
}

describe('mutatos: итог по отчёту калькулятора', () => {
	test('исходы и индекс совпадают со сводкой mutatos', () => {
		const summary = summarizeReport(calcReport(), listFiles(path.join(CALC, 'src')));

		assert.deepEqual(summary.counts, counts({ killed: 14, survived: 5, noCoverage: 1 }));
		assert.equal(summary.index, 73.7);
		assert.equal(summaryLine('Мутационное тестирование', summary), 'Мутационное тестирование: индекс 73,7 %, выжило 5, без покрытия 1');
	});

	test('у прогона отобранными тестами число мутантов вне их покрытия показывается всегда', () => {
		const summary = summarizeReport(calcReport(), listFiles(path.join(CALC, 'src')));

		assert.equal(
			summaryLine('Мутационное тестирование «Калькулятор»', summary, true),
			'Мутационное тестирование «Калькулятор»: индекс 73,7 %, выжило 5, не покрыто отобранными тестами 1'
		);
		assert.equal(
			summaryLine('Прогон', { ...summary, counts: { ...summary.counts, noCoverage: 0 } }, true),
			'Прогон: индекс 73,7 %, выжило 5, не покрыто отобранными тестами 0'
		);
	});

	test('выжившие лежат в файле проекта на местах мутаций', () => {
		const summary = summarizeReport(calcReport(), listFiles(path.join(CALC, 'src')));

		assert.equal(summary.unmapped, 0);
		assert.deepEqual(
			summary.survivors.map((mutant) => [mutant.file, mutant.start.line + 1, textAt(mutant.file, mutant.start, mutant.end), mutant.change, mutant.mutator]),
			[
				[CALC_SOURCE, 17, '>', '> заменено на >=', 'условия'],
				[CALC_SOURCE, 28, '>=', '>= заменено на >', 'условия'],
				[CALC_SOURCE, 28, 'И', 'И заменено на Или', 'логика'],
				[CALC_SOURCE, 28, '<=', '<= заменено на <', 'условия'],
				[CALC_SOURCE, 37, '>', '> заменено на >=', 'условия'],
			]
		);
	});

	test('агенту позиции с единицы и путь от корня проекта', () => {
		const summary = summarizeReport(calcReport(), listFiles(path.join(CALC, 'src')));
		const data = summaryData(summary, CALC);

		assert.equal(data.index, 73.7);
		assert.equal(data.survived, 5);
		assert.deepEqual(data.survivors[2], {
			file: 'src/Классы/Калькулятор.os',
			line: 28,
			column: 26,
			endLine: 28,
			endColumn: 27,
			change: 'И заменено на Или',
			mutator: 'логика',
		});
	});

	test('без файла под каталогом исходников выжившие видны только числом', () => {
		const summary = summarizeReport(calcReport(), listFiles(path.join(CALC, 'нет')));

		assert.deepEqual(summary.survivors, []);
		assert.equal(summary.unmapped, 5);
		assert.equal(summary.index, 73.7);
		assert.equal(summaryLine('Прогон', summary), 'Прогон: индекс 73,7 %, выжило 5, из них не показано 5, без покрытия 1');
		assert.equal(summaryData(summary, CALC).unmapped, 5);
	});
});

describe('mutatos: файлы отчёта', () => {
	const SRC = path.resolve('/projects/cli/src');
	const files = [path.join(SRC, 'cli', 'main.os'), path.join(SRC, 'web', 'main.os'), path.join(SRC, 'Классы', 'Разбор.os')];

	test('ключ от общего каталога файлов с мутантами находится по суффиксу', () => {
		const resolved = resolveReportFiles(['cli/main.os', 'web/main.os', 'Разбор.os'], files);

		assert.equal(resolved.get('cli/main.os'), files[0]);
		assert.equal(resolved.get('web/main.os'), files[1]);
		assert.equal(resolved.get('Разбор.os'), files[2]);
	});

	test('ключ, которому подходит не один файл, пропускается', () => {
		assert.equal(resolveReportFiles(['main.os'], files).get('main.os'), undefined);
	});

	test('общий каталог ключей разводит одинаковые имена в разных подкаталогах', () => {
		const duplicates = [path.join(SRC, 'Классы', 'Строки.os'), path.join(SRC, 'internal', 'Классы', 'Строки.os')];
		const keys = ['Классы/Строки.os', 'internal/Классы/Строки.os'];
		const resolved = resolveReportFiles(keys, duplicates);

		assert.equal(resolved.get(keys[0]), duplicates[0]);
		assert.equal(resolved.get(keys[1]), duplicates[1]);
	});

	test('имя файла сравнивается целиком, а не хвостом', () => {
		assert.equal(resolveReportFiles(['ain.os'], files).get('ain.os'), undefined);
	});

	test('на Windows регистр пути не важен', () => {
		assert.equal(resolveReportFiles(['классы/разбор.os'], files, 'win32').get('классы/разбор.os'), files[2]);
		assert.equal(resolveReportFiles(['классы/разбор.os'], files, 'linux').get('классы/разбор.os'), undefined);
	});
});

describe('mutatos: индекс мутаций', () => {
	test('без покрытия и ошибки в индекс не входят, таймаут считается убитым', () => {
		assert.equal(mutationScore(counts({ killed: 3, timeout: 1, survived: 4, noCoverage: 10, errors: 2 })), 50);
	});

	test('округление до десятой, половина вверх', () => {
		assert.equal(mutationScore(counts({ killed: 1, survived: 15 })), 6.3);
		assert.equal(mutationScore(counts({ killed: 2, survived: 1 })), 66.7);
		assert.equal(mutationScore(counts({ killed: 1, survived: 2 })), 33.3);
	});

	test('без проверенных мутантов индекс ноль', () => {
		assert.equal(mutationScore(counts({ noCoverage: 20 })), 0);
	});

	test('целый индекс без дробной части, дробный через запятую', () => {
		assert.equal(formatScore(100), '100 %');
		assert.equal(formatScore(86.9), '86,9 %');
	});

	test('незнакомый исход считается ошибкой', () => {
		const report = parseMutationReport(JSON.stringify({
			files: {
				'a.os': {
					mutants: [
						{ status: 'RuntimeError' },
						{ status: 'CompileError' },
						{ status: 'Survived', location: { start: { line: 1, column: 1 } } },
					],
				},
			},
		}));

		assert.deepEqual(countMutants(report), counts({ survived: 1, errors: 2 }));
		assert.equal(
			summaryLine('Прогон', summarizeReport(report, [path.resolve('/p/src/a.os')])),
			'Прогон: индекс 0 %, выжило 1, ошибок 2'
		);
	});
});

describe('mutatos: разбор отчёта', () => {
	test('без раздела files это не отчёт', () => {
		assert.throws(() => parseMutationReport('{"schemaVersion":"1.0"}'), /files/);
		assert.throws(() => parseMutationReport('не json'));
	});

	test('мутатор словами', () => {
		assert.equal(mutatorWords('ОтрицаниеУсловия'), 'отрицание условия');
		assert.equal(mutatorWords('ЧисловыеЛитералы'), 'числовые литералы');
		assert.equal(mutatorWords('Арифметика'), 'арифметика');
		assert.equal(mutatorWords('ConditionalExpression'), 'conditional expression');
	});

	test('без описания мутации показывается замена, позиция без конца ставится в начало', () => {
		const report = parseMutationReport(JSON.stringify({
			files: {
				'a.os': {
					mutants: [
						{ status: 'Survived', replacement: 'Ложь', location: { start: { line: 3, column: 5 } } },
						{ status: 'Survived', description: 'вызов удалён', location: { start: { line: 1, column: 1 }, end: { line: 2, column: 4 } } },
					],
				},
			},
		}));
		const [multiline, single] = summarizeReport(report, [path.resolve('/p/src/a.os')]).survivors;

		assert.equal(multiline.change, 'вызов удалён');
		assert.deepEqual([multiline.start, multiline.end], [{ line: 0, character: 0 }, { line: 1, character: 3 }]);
		assert.equal(single.change, 'заменено на Ложь');
		assert.equal(single.mutator, undefined);
		assert.deepEqual([single.start, single.end], [{ line: 2, character: 4 }, { line: 2, character: 4 }]);
	});
});
