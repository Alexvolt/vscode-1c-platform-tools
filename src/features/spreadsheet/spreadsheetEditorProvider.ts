/**
 * Просмотр файла табличного документа по двойному щелчку, как у файлов конфигурации.
 *
 * Лист читает md-sparrow: и XML макета, и двоичный `*.mxl`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureMdSparrowRuntime } from '../metadata/mdSparrowBootstrap';
import { runMdSparrowParamsRead } from '../metadata/mdSparrowParams';
import { mdSparrowSchemaFlagFromConfigurationXml } from '../metadata/mdSparrowSchemaVersion';
import { renderSpreadsheetHtml, spreadsheetWebviewDir, type SpreadsheetDto } from './spreadsheetHtml';
import { saveSpreadsheetCell } from './saveSpreadsheetCell';

export const SPREADSHEET_VIEW_TYPE = '1c-platform-tools.spreadsheet';

/** Версия схем, если у файла рядом нет выгрузки: модель табличного документа от версии не зависит. */
const FALLBACK_SCHEMA = 'V2_21';

export class SpreadsheetEditorProvider implements vscode.CustomReadonlyEditorProvider {
	private constructor(private readonly context: vscode.ExtensionContext) {}

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			SPREADSHEET_VIEW_TYPE,
			new SpreadsheetEditorProvider(context),
			{ supportsMultipleEditorsPerDocument: true }
		);
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		const webview = webviewPanel.webview;
		webview.options = { enableScripts: true };
		const title = path.basename(document.uri.fsPath);
		const filePath = document.uri.fsPath;
		const show = async (): Promise<void> => {
			const nonce = Math.random().toString(36).slice(2);
			try {
				const sheet = await readSpreadsheet(this.context, filePath);
				webview.html = renderSpreadsheetHtml(sheet, title, nonce, spreadsheetWebviewDir(this.context.extensionUri.fsPath));
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Табличный документ не прочитан.';
				webview.html = messageHtml(title, message, nonce);
			}
		};
		webview.onDidReceiveMessage(async (message: { type?: string; row?: number; column?: number; text?: string; parameter?: boolean }) => {
			if (message.type !== 'setText' || message.row === undefined || message.column === undefined) {
				return;
			}
			const error = await saveSpreadsheetCell(
				this.context,
				filePath,
				{
					row: message.row,
					column: message.column,
					text: message.text ?? '',
					parameter: message.parameter === true,
				},
				await schemaNear(filePath)
			);
			if (error) {
				void vscode.window.showErrorMessage(error);
				return;
			}
			await show();
		});
		await show();
	}
}

async function readSpreadsheet(context: vscode.ExtensionContext, filePath: string): Promise<SpreadsheetDto> {
	const runtime = await ensureMdSparrowRuntime(context);
	const result = await runMdSparrowParamsRead(
		runtime,
		{ op: 'cf-spreadsheet-get', objectXml: filePath, schemaVersion: await schemaNear(filePath) },
		{ cwd: path.dirname(filePath) }
	);
	if (result.exitCode !== 0) {
		throw new Error((result.stderr.trim() || result.stdout.trim() || 'Табличный документ не прочитан.').slice(0, 400));
	}
	return JSON.parse(result.stdout.trim()) as SpreadsheetDto;
}

async function schemaNear(filePath: string): Promise<string> {
	let dir = path.dirname(filePath);
	for (let level = 0; level < 8; level += 1) {
		for (const name of ['Configuration.xml', 'Configuration.mdo']) {
			const candidate = path.join(dir, name);
			try {
				await fs.access(candidate);
				const flag = await mdSparrowSchemaFlagFromConfigurationXml(candidate);
				if (flag) {
					return flag;
				}
			} catch {
				// выше по дереву
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return FALLBACK_SCHEMA;
}

function messageHtml(title: string, message: string, nonce: string): string {
	const text = message.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
	const heading = title.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
	return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>${heading}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;}</style>
</head><body><p>${text}</p></body></html>`;
}
