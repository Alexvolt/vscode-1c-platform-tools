/**
 * Запись текста ячейки через md-sparrow: и XML макета, и файл `*.mxl`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureMdSparrowRuntime } from '../metadata/mdSparrowBootstrap';
import { runMdSparrowParamsMutation } from '../metadata/mdSparrowParams';

export interface SpreadsheetCellEdit {
	row: number;
	column: number;
	text: string;
	parameter: boolean;
}

/** Пишет текст ячейки. Пустая строка — ошибка для показа, иначе запись прошла. */
export async function saveSpreadsheetCell(
	context: vscode.ExtensionContext,
	filePath: string,
	edit: SpreadsheetCellEdit,
	schemaFlag: string
): Promise<string | undefined> {
	const runtime = await ensureMdSparrowRuntime(context);
	const result = await runMdSparrowParamsMutation(
		runtime,
		{
			op: 'cf-spreadsheet-set-cell',
			objectXml: filePath,
			schemaVersion: schemaFlag || 'V2_21',
			payloadJson: JSON.stringify({
				row: edit.row,
				column: edit.column,
				text: edit.text,
				parameter: edit.parameter,
			}),
		},
		{ cwd: path.dirname(filePath) }
	);
	if (result.exitCode !== 0) {
		return (result.stderr.trim() || result.stdout.trim() || 'Текст ячейки не записан.').slice(0, 400);
	}
	return undefined;
}
