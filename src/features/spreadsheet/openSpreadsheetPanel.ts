/**
 * Вкладка табличного документа: лист читает md-sparrow, расширение его показывает.
 */

import * as vscode from 'vscode';
import { beginOpenPanel, endOpenPanel, revealOpenPanel, trackOpenPanel } from '../editors/openPanels';
import { ensureMdSparrowRuntime } from '../metadata/mdSparrowBootstrap';
import { runMdSparrowParamsRead } from '../metadata/mdSparrowParams';
import { renderSpreadsheetHtml, spreadsheetWebviewDir, type SpreadsheetDto } from './spreadsheetHtml';
import { saveSpreadsheetCell } from './saveSpreadsheetCell';

export interface SpreadsheetPanelInput {
	templateXmlFsPath: string;
	title: string;
	cwd: string;
	schemaFlag: string;
}

/** Открывает макет табличного документа. Повторный щелчок показывает ту же вкладку. */
export async function openSpreadsheetPanel(
	context: vscode.ExtensionContext,
	input: SpreadsheetPanelInput
): Promise<void> {
	if (revealOpenPanel('spreadsheet', input.templateXmlFsPath)) {
		return;
	}
	if (!beginOpenPanel('spreadsheet', input.templateXmlFsPath)) {
		return;
	}
	try {
		const runtime = await ensureMdSparrowRuntime(context);
		const result = await runMdSparrowParamsRead(
			runtime,
			{ op: 'cf-spreadsheet-get', objectXml: input.templateXmlFsPath, schemaVersion: input.schemaFlag || 'V2_21' },
			{ cwd: input.cwd }
		);
		if (result.exitCode !== 0) {
			const detail = (result.stderr.trim() || result.stdout.trim() || `код ${result.exitCode}`).slice(0, 400);
			void vscode.window.showErrorMessage(`Табличный документ не прочитан. ${detail}`);
			return;
		}
		let sheet: SpreadsheetDto;
		try {
			sheet = JSON.parse(result.stdout.trim()) as SpreadsheetDto;
		} catch {
			void vscode.window.showErrorMessage('Табличный документ не прочитан.');
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'1cSpreadsheet',
			input.title,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		trackOpenPanel('spreadsheet', input.templateXmlFsPath, panel);
		const show = (next: SpreadsheetDto): void => {
			const nonce = Math.random().toString(36).slice(2);
			panel.webview.html = renderSpreadsheetHtml(next, input.title, nonce, spreadsheetWebviewDir(context.extensionUri.fsPath));
		};
		show(sheet);
		panel.webview.onDidReceiveMessage(async (message: { type?: string; row?: number; column?: number; text?: string; parameter?: boolean }) => {
			if (message.type !== 'setText' || message.row === undefined || message.column === undefined) {
				return;
			}
			const error = await saveSpreadsheetCell(
				context,
				input.templateXmlFsPath,
				{
					row: message.row,
					column: message.column,
					text: message.text ?? '',
					parameter: message.parameter === true,
				},
				input.schemaFlag
			);
			if (error) {
				void vscode.window.showErrorMessage(error);
				return;
			}
			const refreshed = await runMdSparrowParamsRead(
				runtime,
				{ op: 'cf-spreadsheet-get', objectXml: input.templateXmlFsPath, schemaVersion: input.schemaFlag || 'V2_21' },
				{ cwd: input.cwd }
			);
			if (refreshed.exitCode === 0) {
				show(JSON.parse(refreshed.stdout.trim()) as SpreadsheetDto);
			}
		});
	} finally {
		endOpenPanel('spreadsheet', input.templateXmlFsPath);
	}
}
