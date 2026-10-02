import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { requestSaveInActiveForm, SAVE_REQUEST_MESSAGE } from '../../features/editors/formPanels';
import {
	PROPERTY_PALETTE_FOCUSED,
	PROPERTY_PALETTE_VIEW_ID,
	PropertyPaletteViewProvider,
} from '../../features/properties/propertyPaletteView';

/** Панель-заглушка: запоминает сообщения странице и даёт закрыть её. */
function fakeView(): {
	view: vscode.WebviewView;
	posted: unknown[];
	receive: (message: unknown) => void;
	dispose: () => void;
} {
	const posted: unknown[] = [];
	let handler: (message: unknown) => void = () => undefined;
	let onDispose: () => void = () => undefined;
	const webview = {
		options: {},
		html: '',
		postMessage: (message: unknown) => {
			posted.push(message);
			return Promise.resolve(true);
		},
		onDidReceiveMessage: (listener: (message: unknown) => void) => {
			handler = listener;
			return { dispose: () => undefined };
		},
	};
	const view = {
		webview,
		onDidChangeVisibility: () => ({ dispose: () => undefined }),
		onDidDispose: (listener: () => void) => {
			onDispose = listener;
			return { dispose: () => undefined };
		},
	} as unknown as vscode.WebviewView;
	return {
		view,
		posted,
		receive: (message) => handler(message),
		dispose: () => onDispose(),
	};
}

suite('панель свойств: запись по Ctrl+S', () => {
	test('пока панель в фокусе, общее сохранение пишет в неё', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, posted, receive, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			receive({ type: 'focus' });
			posted.length = 0;

			requestSaveInActiveForm();

			assert.deepStrictEqual(posted, [SAVE_REQUEST_MESSAGE]);
		} finally {
			dispose();
		}
	});

	test('без фокуса панели общее сохранение её не трогает', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, posted, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			posted.length = 0;

			requestSaveInActiveForm();

			assert.deepStrictEqual(posted, []);
		} finally {
			dispose();
		}
	});

	test('страница пишет так же, как редактор свойств во вкладке', () => {
		const provider = new PropertyPaletteViewProvider(vscode.Uri.file('/ext'));
		const { view, dispose } = fakeView();
		provider.resolveWebviewView(view);
		try {
			assert.ok(view.webview.html.includes("message.type === 'saveRequested'"));
			assert.ok(view.webview.html.includes('active.blur()'));
			assert.ok(view.webview.html.includes('saveBtn.click()'));
		} finally {
			dispose();
		}
	});

	test('Ctrl+S панели свойств идёт той же командой, что и у вкладки', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
		) as {
			contributes: {
				commands: Array<{ command: string }>;
				keybindings: Array<{ command: string; key: string; when?: string }>;
			};
		};
		const binding = pkg.contributes.keybindings.find(
			(item) => item.command === '1c-platform-tools.editors.save'
		);

		assert.ok(binding, 'сочетание сохранения не объявлено');
		assert.strictEqual(binding.key, 'ctrl+s');
		assert.ok(binding.when?.includes(PROPERTY_PALETTE_VIEW_ID));
		assert.ok(binding.when?.includes(PROPERTY_PALETTE_FOCUSED));
		assert.ok(binding.when?.includes('1cMetadataObjectProperties'));
		assert.ok(binding.when?.includes('1cClusterObjectProperties'));
		assert.ok(binding.when?.includes('1cClusterAdminProperties'));
		assert.ok(binding.when?.includes('1cClusterConnections'));
		assert.ok(
			!pkg.contributes.commands.some((item) => item.command === '1c-platform-tools.properties.save')
		);
	});
});
