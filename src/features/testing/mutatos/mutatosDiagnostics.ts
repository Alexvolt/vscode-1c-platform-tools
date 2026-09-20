/**
 * Выжившие мутанты в панели Problems.
 *
 * Коллекция отражает последний отчёт: заменяется целиком после прогона и
 * очищается, когда отчёт удалён, в том числе перед следующим прогоном.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SurvivedMutant } from './mutatosReport';

/** Источник замечаний в Problems. */
const DIAGNOSTIC_SOURCE = 'mutatos';

let collection: vscode.DiagnosticCollection | undefined;
let reportWatcher: vscode.Disposable | undefined;

/** Коллекция выживших мутантов. */
function diagnostics(): vscode.DiagnosticCollection {
	if (!collection) {
		collection = vscode.languages.createDiagnosticCollection('1c-mutatos');
	}
	return collection;
}

/** Текст замечания о выжившем мутанте. */
export function survivorMessage(mutant: SurvivedMutant): string {
	return mutant.change === '' ? 'Тесты не заметили мутацию' : `Тесты не заметили мутацию: ${mutant.change}`;
}

/**
 * Показывает выживших мутантов вместо прежних.
 *
 * @param survivors - Выжившие мутанты
 * @param report - Файл отчёта, по которому они найдены
 * @param root - Корень проекта
 */
export function showSurvivors(survivors: readonly SurvivedMutant[], report: string, root: string): void {
	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const mutant of survivors) {
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(mutant.start.line, mutant.start.character, mutant.end.line, mutant.end.character),
			survivorMessage(mutant),
			vscode.DiagnosticSeverity.Information
		);
		diagnostic.source = DIAGNOSTIC_SOURCE;
		if (mutant.mutator) {
			diagnostic.code = mutant.mutator;
		}
		byFile.set(mutant.file, [...(byFile.get(mutant.file) ?? []), diagnostic]);
	}
	const collected = diagnostics();
	collected.clear();
	for (const [file, items] of byFile) {
		collected.set(vscode.Uri.file(file), items);
	}
	watchReport(report, root);
}

/** Убирает выживших мутантов из Problems. */
export function clearSurvivors(): void {
	reportWatcher?.dispose();
	reportWatcher = undefined;
	collection?.clear();
}

/** Освобождает коллекцию при выключении расширения. */
export function disposeMutatosDiagnostics(): void {
	clearSurvivors();
	collection?.dispose();
	collection = undefined;
}

/**
 * Следит за удалением отчёта: вместе с ним или его каталогом уходят и замечания.
 *
 * @param report - Файл отчёта
 * @param root - Корень проекта
 */
function watchReport(report: string, root: string): void {
	reportWatcher?.dispose();
	const relative = path.relative(root, report);
	let pattern: vscode.RelativePattern;
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(report)), path.basename(report));
	} else {
		// Удаление каталога приходит событием о каталоге, а не о файлах в нём
		const segments = relative.split(path.sep);
		const chain = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
		pattern = new vscode.RelativePattern(vscode.Uri.file(root), `{${chain.join(',')}}`);
	}
	const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, true, false);
	const onDelete = watcher.onDidDelete(() => {
		if (!fs.existsSync(report)) {
			clearSurvivors();
		}
	});
	reportWatcher = vscode.Disposable.from(onDelete, watcher);
}
