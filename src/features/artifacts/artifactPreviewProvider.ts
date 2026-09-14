/**
 * Карточка бинарного файла 1С (custom editor для .cf, .cfe, .epf, .erf).
 *
 * Вместо заглушки редактора о двоичном файле показывает вид файла, размер,
 * дату изменения и действия над ним.
 * @module artifactPreviewProvider
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { binaryArtifactKind, type BinaryArtifactKind } from './artifactKinds';
import { formatBytes } from '../clusters/presentation';

export const ARTIFACT_PREVIEW_VIEW_TYPE = '1c-platform-tools.artifactPreview';

/** Сообщения из карточки в расширение */
type WebviewMessage = { type: 'decompile' } | { type: 'reveal' };

export class ArtifactPreviewProvider implements vscode.CustomReadonlyEditorProvider {
	private constructor(private readonly iconsRoot: vscode.Uri) {}

	/**
	 * Регистрирует карточку бинарных файлов 1С.
	 *
	 * @param context - Контекст расширения
	 * @returns Disposable регистрации
	 */
	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const iconsRoot = vscode.Uri.joinPath(context.extensionUri, 'resources', 'metadata-tree-icons');
		return vscode.window.registerCustomEditorProvider(
			ARTIFACT_PREVIEW_VIEW_TYPE,
			new ArtifactPreviewProvider(iconsRoot),
			{ supportsMultipleEditorsPerDocument: true }
		);
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
		const { uri } = document;
		const kind = binaryArtifactKind(uri.fsPath);
		const webview = webviewPanel.webview;
		webview.options = { enableScripts: true, localResourceRoots: [this.iconsRoot] };

		const render = async (): Promise<void> => {
			const stat = await vscode.workspace.fs.stat(uri).then(
				(value) => value,
				() => undefined
			);
			webview.html = buildHtml(webview, this.iconsRoot, uri, kind, stat);
		};

		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath))
		);
		watcher.onDidChange(() => void render());
		watcher.onDidCreate(() => void render());
		watcher.onDidDelete(() => void render());
		webviewPanel.onDidDispose(() => watcher.dispose());

		webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			if (message.type === 'decompile' && kind) {
				await vscode.commands.executeCommand(kind.decompileCommand, { resourceUri: uri });
				return;
			}
			if (message.type === 'reveal') {
				await vscode.commands.executeCommand('revealInExplorer', uri);
			}
		});

		await render();
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** HTML карточки: значок вида, сведения о файле и кнопки действий. */
function buildHtml(
	webview: vscode.Webview,
	iconsRoot: vscode.Uri,
	uri: vscode.Uri,
	kind: BinaryArtifactKind | undefined,
	stat: vscode.FileStat | undefined
): string {
	const nonce = Math.random().toString(36).slice(2);
	const icon = (theme: string[]): string =>
		kind ? webview.asWebviewUri(vscode.Uri.joinPath(iconsRoot, ...theme, kind.icon)).toString() : '';
	const rows: Array<[string, string]> = stat
		? [
				['Размер', formatBytes(String(stat.size))],
				['Изменён', new Date(stat.mtime).toLocaleString('ru-RU')],
				['Путь', vscode.workspace.asRelativePath(uri, false)],
			]
		: [['Путь', vscode.workspace.asRelativePath(uri, false)]];
	return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { padding: 32px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
	header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
	header img { width: 48px; height: 48px; }
	body.vscode-dark .light, body.vscode-high-contrast .light, body:not(.vscode-dark):not(.vscode-high-contrast) .dark { display: none; }
	h1 { margin: 0; font-size: 1.5em; font-weight: 600; word-break: break-all; }
	.kind { color: var(--vscode-descriptionForeground); margin-top: 4px; }
	dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 24px; margin: 0 0 24px; }
	dt { color: var(--vscode-descriptionForeground); }
	dd { margin: 0; word-break: break-all; }
	.missing { color: var(--vscode-errorForeground); margin-bottom: 24px; }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; }
	button { padding: 4px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; font: inherit;
		color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<header>
	${kind ? `<img class="light" src="${icon([])}" alt=""><img class="dark" src="${icon(['dark'])}" alt="">` : ''}
	<div>
		<h1>${escapeHtml(path.basename(uri.fsPath))}</h1>
		<div class="kind">${escapeHtml(kind?.label ?? 'Файл 1С')}</div>
	</div>
</header>
${stat ? '' : '<div class="missing">Файл не найден</div>'}
<dl>${rows.map(([name, value]) => `<dt>${name}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
<div class="actions">
	${kind && stat ? '<button data-message="decompile">Разобрать</button>' : ''}
	<button class="secondary" data-message="reveal">Показать в проводнике</button>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	for (const button of document.querySelectorAll('button[data-message]')) {
		button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.message }));
	}
</script>
</body>
</html>`;
}
