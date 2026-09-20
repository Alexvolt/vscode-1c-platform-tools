import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearSurvivors, showSurvivors } from '../../features/testing/mutatos/mutatosDiagnostics';
import { listFiles, parseMutationReport, summarizeReport } from '../../features/testing/mutatos/mutatosReport';

/** Проект калькулятора: отчёт настоящего прогона mutatos и исходник из него. */
const CALC = path.resolve(__dirname, '../../../src/test/fixtures/mutatos/calc');
const SOURCE = path.join(CALC, 'src', 'Классы', 'Калькулятор.os');

/** Выжившие мутанты отчёта проекта. */
function survivorsOf(root: string, report: string) {
	return summarizeReport(parseMutationReport(fs.readFileSync(report, 'utf8')), listFiles(path.join(root, 'src'))).survivors;
}

/** Ждёт условия, проверяя его раз в 100 мс. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	for (let waited = 0; waited < timeoutMs; waited += 100) {
		if (condition()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return condition();
}

suite('mutatos: выжившие мутанты в Problems', () => {
	teardown(() => clearSurvivors());

	test('выживший мутант отмечен на месте мутации уровнем Information', () => {
		const report = path.join(CALC, 'mutations.json');
		showSurvivors(survivorsOf(CALC, report), report, CALC);

		const found = vscode.languages.getDiagnostics(vscode.Uri.file(SOURCE));
		assert.strictEqual(found.length, 5);
		assert.ok(found.every((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Information));
		assert.ok(found.every((diagnostic) => diagnostic.source === 'mutatos'));
		const first = found.find((diagnostic) => diagnostic.range.start.line === 16);
		assert.ok(first, 'нет мутанта на строке 17');
		assert.strictEqual(first.message, 'Тесты не заметили мутацию: > заменено на >=');
		assert.strictEqual(first.code, 'условия');
		assert.deepStrictEqual(
			[first.range.start.character, first.range.end.line, first.range.end.character],
			[13, 16, 14]
		);
	});

	test('новый итог заменяет прежний целиком', () => {
		const report = path.join(CALC, 'mutations.json');
		showSurvivors(survivorsOf(CALC, report), report, CALC);

		showSurvivors([], report, CALC);

		assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(SOURCE)).length, 0);
	});

	test('вместе с каталогом отчёта уходят и выжившие', async function () {
		this.timeout(20_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutatos-problems-'));
		try {
			fs.cpSync(path.join(CALC, 'src'), path.join(root, 'src'), { recursive: true });
			const report = path.join(root, 'build', 'out', 'mutatos', 'mutations.json');
			fs.mkdirSync(path.dirname(report), { recursive: true });
			fs.copyFileSync(path.join(CALC, 'mutations.json'), report);
			const source = vscode.Uri.file(path.join(root, 'src', 'Классы', 'Калькулятор.os'));
			showSurvivors(survivorsOf(root, report), report, root);
			assert.strictEqual(vscode.languages.getDiagnostics(source).length, 5);

			// Слежение за файлами запускается не сразу
			await new Promise((resolve) => setTimeout(resolve, 1000));
			fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });

			assert.ok(
				await waitFor(() => vscode.languages.getDiagnostics(source).length === 0, 10_000),
				'выжившие остались после удаления отчёта'
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
