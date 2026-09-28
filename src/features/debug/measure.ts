import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { DEBUG_TYPE } from './debugConstants';
import { disposeMeasureResultsPanel, showMeasureResultsPanel } from './measureResultsPanel';

const log = logger.scope('dap');

export interface MeasureLine {
	line: number;
	count: number;
	seconds: number;
	ownSeconds: number;
	serverCall: boolean;
}

export interface MeasureModule {
	path: string;
	lines: MeasureLine[];
}

export interface MeasureResults {
	totalSeconds: number;
	modules: MeasureModule[];
}

let measureActive = false;
let results: MeasureResults | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let decorationType: vscode.TextEditorDecorationType | undefined;
let showPanelTimer: NodeJS.Timeout | undefined;

/** Контекст-ключ для переключения кнопки старт/стоп на панели отладки (без дефисов — их не понимает парсер when-выражений). */
function setMeasureActive(value: boolean): void {
	measureActive = value;
	void vscode.commands.executeCommand('setContext', 'onecPlatformTools.debug.measureActive', value);
}

/**
 * Замер производительности: команды включения/выключения режима замера в активной сессии
 * отладки 1С и отображение результатов built-in декорациями по строкам модулей.
 */
export function registerMeasureFeature(context: vscode.ExtensionContext): void {
	setMeasureActive(false);
	context.subscriptions.push(
		vscode.commands.registerCommand('1c-platform-tools.debug.measure.start', () =>
			setMeasureMode(true)
		),
		vscode.commands.registerCommand('1c-platform-tools.debug.measure.stop', () =>
			setMeasureMode(false)
		),
		vscode.commands.registerCommand('1c-platform-tools.debug.measure.clear', () =>
			clearResults()
		),
		vscode.commands.registerCommand('1c-platform-tools.debug.measure.showResults', () => {
			if (results) {
				void showMeasureResultsPanel(results);
			} else {
				void vscode.window.showInformationMessage('Нет результатов замера производительности.');
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent((ev) => {
			if (ev.event === 'MeasureResults' && ev.session.type === DEBUG_TYPE) {
				results = ev.body as MeasureResults;
				log.debug(`результаты замера: модулей ${results.modules.length}, всего ${formatSeconds(results.totalSeconds)}`);
				updateStatusBar();
				applyDecorations();
				// Результаты приходят порциями от каждого предмета отладки — таблицу
				// показываем по последнему снимку, когда поток порций утих.
				if (!measureActive) {
					if (showPanelTimer) {
						clearTimeout(showPanelTimer);
					}
					showPanelTimer = setTimeout(() => {
						showPanelTimer = undefined;
						if (results) {
							void showMeasureResultsPanel(results);
						}
					}, 500);
				}
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors(() => applyDecorations()),
		// Замер — не настройка, а живой признак: при завершении сессии всегда снимается
		// (адаптер дополнительно выключает его на сервере отладки при отключении).
		vscode.debug.onDidTerminateDebugSession((session) => {
			if (session.type === DEBUG_TYPE && measureActive) {
				setMeasureActive(false);
				updateStatusBar();
			}
		})
	);
}

let requestInFlight = false;

async function setMeasureMode(enabled: boolean): Promise<void> {
	const session = vscode.debug.activeDebugSession;
	if (!session || session.type !== DEBUG_TYPE) {
		void vscode.window.showWarningMessage('Замер производительности доступен только в сессии отладки 1С.');
		return;
	}
	if (requestInFlight) {
		return;
	}

	requestInFlight = true;
	try {
		await session.customRequest('SetMeasureModeRequest', { enabled });
	} catch (err) {
		log.error(`Ошибка переключения замера производительности: ${String(err)}`);
		void vscode.window.showErrorMessage('Не удалось переключить режим замера производительности.');
		return;
	} finally {
		requestInFlight = false;
	}

	setMeasureActive(enabled);
	log.info(`замер производительности ${enabled ? 'запущен' : 'остановлен'}`);
	if (enabled) {
		results = undefined;
		applyDecorations();
	}
	updateStatusBar();
}

function clearResults(): void {
	results = undefined;
	updateStatusBar();
	applyDecorations();
	disposeMeasureResultsPanel();
}

function updateStatusBar(): void {
	if (!measureActive && !results) {
		statusBarItem?.hide();
		return;
	}

	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	}
	if (measureActive) {
		statusBarItem.text = '$(dashboard) Замер производительности…';
		statusBarItem.tooltip = 'Идёт замер производительности 1С. Нажмите, чтобы закончить.';
		statusBarItem.command = '1c-platform-tools.debug.measure.stop';
	} else {
		statusBarItem.text = `$(dashboard) Замер: ${formatSeconds(results!.totalSeconds)}`;
		statusBarItem.tooltip = 'Результаты замера производительности 1С. Нажмите, чтобы открыть таблицу.';
		statusBarItem.command = '1c-platform-tools.debug.measure.showResults';
	}
	statusBarItem.show();
}

function applyDecorations(): void {
	if (!decorationType) {
		// Колонка одной ширины на каждой строке (пустая — где данных нет):
		// код всех строк сдвигается одинаково и не ломает выравнивание.
		// Ширину задаёт каждая декорация: она своя у каждого модуля.
		decorationType = vscode.window.createTextEditorDecorationType({
			before: {
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				margin: '0 1.5em 0 0',
			},
		});
	}

	for (const editor of vscode.window.visibleTextEditors) {
		if (!editor.document.uri.fsPath.toLowerCase().endsWith('.bsl')) {
			continue;
		}
		editor.setDecorations(decorationType, results ? buildDecorations(editor.document) : []);
	}
}

function buildDecorations(document: vscode.TextDocument): vscode.DecorationOptions[] {
	const module = results!.modules.find((m) => samePath(m.path, document.uri.fsPath));
	if (!module) {
		return [];
	}

	const byLine = new Map(module.lines.map((l) => [l.line - 1, l]));
	const labels = new Map(module.lines.map((l) => [l.line - 1, measureLabel(l, results!.totalSeconds)]));
	// Колонка по самой длинной подписи модуля: короче она наезжала бы на код
	const width = `${Math.max(0, ...[...labels.values()].map((label) => label.length)) + 1}ch`;
	const options: vscode.DecorationOptions[] = [];
	for (let line0 = 0; line0 < document.lineCount; line0++) {
		const line = byLine.get(line0);
		if (!line) {
			options.push({
				range: new vscode.Range(line0, 0, line0, 0),
				renderOptions: { before: { contentText: '', width } },
			});
			continue;
		}
		options.push({
			range: new vscode.Range(line0, 0, line0, 0),
			renderOptions: {
				before: {
					contentText: labels.get(line0),
					width,
				},
			},
			hoverMessage: new vscode.MarkdownString(
				`Замер производительности: выполнений — ${line.count}, ` +
					`время — ${formatSeconds(line.seconds)}, ` +
					`без вложенных вызовов — ${formatSeconds(line.ownSeconds)}` +
					(line.serverCall ? ', есть серверный вызов' : '')
			),
		});
	}
	return options;
}

/**
 * Подпись замера строки.
 *
 * Молния с селектором текстового начертания: без него она рисуется цветным эмодзи
 * шире символа.
 */
export function measureLabel(
	line: Pick<MeasureLine, 'count' | 'seconds' | 'serverCall'>,
	totalSeconds: number
): string {
	const percent = totalSeconds > 0 ? ((line.seconds / totalSeconds) * 100).toFixed(1) : '0.0';
	const server = line.serverCall ? ' \u26A1\uFE0E' : '';
	return `${line.count} × ${formatSeconds(line.seconds)} · ${percent} %${server}`;
}

function samePath(left: string, right: string): boolean {
	const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
	return normalize(left) === normalize(right);
}

function formatSeconds(seconds: number): string {
	return seconds >= 1 ? `${seconds.toFixed(2)} с` : `${(seconds * 1000).toFixed(1)} мс`;
}
