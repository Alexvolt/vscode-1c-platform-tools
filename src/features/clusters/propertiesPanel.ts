/**
 * Карточка свойств объекта кластера.
 *
 * Карточек в консоли две — у информационной базы и у самого кластера, — и ведут
 * они себя одинаково: читают объект, показывают разделы с полями, сохраняют
 * только изменённые значения. Поэтому панель здесь одна, а что показывать и
 * куда отправлять, ей сообщает описание объекта.
 */

import * as vscode from 'vscode';
import { registerFormPanel } from '../editors/formPanels';
import { CHROME_LABELS, chromeScript, chromeStyles, saveBarHtml } from '../editors/webviewChrome';
import type { PropertySection, PropertyValues } from './propertiesForm';

/** Учётные данные объекта: наборы на выбор и текущая привязка. */
export interface AccessState {
	sets: Array<{ id: string; name: string; user: string }>;
	/** Привязанный набор; пусто — не назначен. */
	boundId?: string;
	/** Цвет точки наборов. */
	color: string;
}

/** Выбор набора: сохранённый или данные нового. */
export type AccessChoice = { setId: string } | { name: string; user: string; password: string };

/** Учётные данные, с которыми карточка читает объект. */
export interface PropertiesAccess {
	state: () => AccessState;
	/** Проверяет набор и привязывает его. */
	grant: (choice: AccessChoice) => Promise<{ ok: true } | { ok: false; message: string }>;
	/** Снимает привязку. */
	revoke: () => Promise<void>;
}

/** Итог чтения объекта. */
export type PropertiesLoadResult =
	| { ok: true; values: PropertyValues }
	| {
			ok: false;
			message: string;
			/** Объект не читается без учётных данных: карточка предлагает их на месте. */
			accessRequired?: boolean;
	  };

/** Что делает карточка: чем наполняется и куда сохраняет. */
export interface PropertiesDescriptor {
	/**
	 * Ключ объекта: у каждого своя вкладка.
	 *
	 * Повторное открытие того же объекта переиспользует вкладку, а разные
	 * объекты открываются рядом — свойства двух соединений сравнивают глазами.
	 */
	key: string;
	/** Заголовок вкладки. */
	title: string;
	/** Пояснение в шапке: подключение и адрес. */
	subtitle: string;
	/** Разделы с полями. */
	sections: PropertySection[];
	/** Читает значения объекта. */
	load: () => Promise<PropertiesLoadResult>;
	/** Учётные данные объекта: блок над разделами. */
	access?: PropertiesAccess;
	/** Проверяет значения перед отправкой. */
	validate: (values: PropertyValues) => string[];
	/**
	 * Сохраняет правки.
	 *
	 * Получает прочитанные и набранные значения целиком: что из них изменилось и
	 * как перевести это в параметры rac, знает описание объекта.
	 */
	save: (
		before: PropertyValues,
		after: PropertyValues
	) => Promise<{ ok: true; changed: boolean } | { ok: false; message: string }>;
}

/**
 * Находит поля, которые платформа не применила.
 *
 * Сравниваются набранные значения и то, что сервер отдал после сохранения:
 * расхождение означает, что параметр не принят, хотя вызов прошёл без ошибки.
 *
 * @param sections - Разделы карточки
 * @param requested - Значения, отправленные на сервер
 * @param actual - Значения, прочитанные после сохранения
 * @returns Подписи непринятых полей
 */
export function unappliedFields(
	sections: PropertySection[],
	requested: PropertyValues,
	actual: PropertyValues
): string[] {
	const titles: string[] = [];
	for (const section of sections) {
		for (const field of section.fields) {
			if (field.kind === 'readonly') {
				continue;
			}
			const want = (requested[field.key] ?? '').trim();
			const got = (actual[field.key] ?? '').trim();
			if (want !== got) {
				titles.push(field.title);
			}
		}
	}
	return titles;
}

/** Сообщение из карточки. */
type PanelMessage =
	| { type: 'save'; data: PropertyValues }
	| { type: 'reload' }
	| { type: 'grantAccess'; choice: AccessChoice }
	| { type: 'revokeAccess' }
	| { type: 'error'; message: string };

/** Открытая карточка: вкладка вместе с тем, что она показывает. */
interface OpenCard {
	panel: vscode.WebviewPanel;
	descriptor: PropertiesDescriptor;
	/** Значения, прочитанные с сервера: с ними сравниваются правки формы. */
	baseline: PropertyValues;
	/** Прочитан ли объект последним чтением. */
	loaded: boolean;
}

/**
 * Карточки свойств объектов кластера.
 *
 * Каждому объекту достаётся своя вкладка: свойства двух соединений или сеансов
 * администратор сравнивает рядом, и общая вкладка, перерисовывающая себя под
 * последний выбранный объект, такое сравнение сделала бы невозможным. Повторное
 * открытие того же объекта переиспользует его вкладку, а не плодит копии.
 */
export class PropertiesPanel {
	/** Открытые карточки по ключу объекта. */
	private readonly cards = new Map<string, OpenCard>();

	/**
	 * @param viewType - Тип вкладки для восстановления раскладки VS Code
	 */
	constructor(private readonly viewType: string) {}

	/**
	 * Открывает карточку объекта.
	 *
	 * @param descriptor - Что показывать и куда сохранять
	 */
	async open(descriptor: PropertiesDescriptor): Promise<void> {
		const existing = this.cards.get(descriptor.key);
		if (existing) {
			existing.descriptor = descriptor;
			existing.panel.title = descriptor.title;
			existing.panel.reveal(existing.panel.viewColumn);
			await this.load(descriptor.key);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			this.viewType,
			descriptor.title,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		panel.webview.html = buildHtml();
		registerFormPanel(panel);
		panel.webview.onDidReceiveMessage((message: PanelMessage) =>
			this.handleMessage(descriptor.key, message)
		);
		panel.onDidDispose(() => {
			this.cards.delete(descriptor.key);
		});
		this.cards.set(descriptor.key, { panel, descriptor, baseline: {}, loaded: false });
		await this.load(descriptor.key);
	}

	dispose(): void {
		for (const card of this.cards.values()) {
			card.panel.dispose();
		}
		this.cards.clear();
	}

	/**
	 * Читает объект и отправляет значения в форму.
	 *
	 * @param key - Ключ открытой карточки
	 */
	private async load(key: string): Promise<void> {
		const card = this.cards.get(key);
		if (!card) {
			return;
		}
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Читаю: ${card.descriptor.title}` },
			() => card.descriptor.load()
		);
		const access = card.descriptor.access?.state();
		card.loaded = result.ok;
		if (!result.ok) {
			void card.panel.webview.postMessage({
				type: 'failed',
				message: result.message,
				access: result.accessRequired ? access : undefined,
				subtitle: card.descriptor.subtitle,
			});
			return;
		}
		card.baseline = result.values;
		void card.panel.webview.postMessage({
			type: 'model',
			sections: card.descriptor.sections,
			values: card.baseline,
			subtitle: card.descriptor.subtitle,
			access,
		});
	}

	/**
	 * Привязывает набор или снимает привязку.
	 *
	 * Прочитанную карточку не перечитывает: перечитывание сбросило бы
	 * несохранённые правки в полях.
	 *
	 * @param key - Ключ открытой карточки
	 * @param choice - Набор; пусто — снять привязку
	 */
	private async changeAccess(key: string, choice: AccessChoice | undefined): Promise<void> {
		const card = this.cards.get(key);
		const access = card?.descriptor.access;
		if (!card || !access) {
			return;
		}
		if (choice) {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Проверяю учётные данные: ${card.descriptor.title}` },
				() => access.grant(choice)
			);
			if (!result.ok) {
				void card.panel.webview.postMessage({ type: 'accessFailed', message: result.message });
				return;
			}
		} else {
			await access.revoke();
		}
		if (card.loaded) {
			void card.panel.webview.postMessage({ type: 'access', access: access.state() });
			return;
		}
		await this.load(key);
	}

	/**
	 * Обрабатывает сообщение карточки.
	 *
	 * @param key - Ключ открытой карточки
	 * @param message - Сообщение
	 */
	private async handleMessage(key: string, message: PanelMessage): Promise<void> {
		const card = this.cards.get(key);
		if (!card) {
			return;
		}
		if (message.type === 'reload') {
			await this.load(key);
			return;
		}
		if (message.type === 'error') {
			void vscode.window.showErrorMessage(`${card.descriptor.title}: ${message.message}`);
			return;
		}
		if (message.type === 'grantAccess' || message.type === 'revokeAccess') {
			await this.changeAccess(key, message.type === 'grantAccess' ? message.choice : undefined);
			return;
		}

		const problems = card.descriptor.validate(message.data);
		if (problems.length > 0) {
			void card.panel.webview.postMessage({ type: 'saveFailed', message: problems.join('; ') });
			return;
		}

		const requested = message.data;
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Сохраняю: ${card.descriptor.title}` },
			() => card.descriptor.save(card.baseline, requested)
		);
		if (!result.ok) {
			void card.panel.webview.postMessage({ type: 'saveFailed', message: result.message });
			return;
		}
		if (result.changed) {
			await this.load(key);
		}
		// Часть параметров платформа принимает молча, но не применяет: вызов
		// завершается успешно, а значение остаётся прежним. Молчать об этом нельзя —
		// иначе «Сохранено» врёт, и поле необъяснимо возвращается к старому виду.
		const ignored = unappliedFields(card.descriptor.sections, requested, card.baseline);
		void card.panel.webview.postMessage({
			type: 'saved',
			message:
				ignored.length > 0 ? `Сохранено; платформа не приняла: ${ignored.join(', ')}` : undefined,
		});
	}
}

/** Разметка и скрипт карточки. */
function buildHtml(): string {
	const nonce = Math.random().toString(36).slice(2);
	return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${chromeStyles()}
	.chrome-body { grid-template-columns: minmax(0, 1fr); }
	/* Кнопка стоит рядом с заголовком, а не улетает к правому краю пустой полосы */
	.toolbar .title { margin-right: 10px; }
	.main { overflow: auto; padding: 10px 16px 18px; }
	/* Разделы идут двумя колонками, а внутри раздела подпись стоит слева от поля:
	   так карточка держится в одном экране, как диалог свойств в консоли кластера */
	.sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr));
		gap: 4px 26px; align-items: start; }
	.section { break-inside: avoid; margin-bottom: 10px; }
	.section h2 { margin: 8px 0 6px; }
	.field { display: grid; grid-template-columns: 210px minmax(0, 1fr); align-items: center;
		gap: 8px; margin-bottom: 4px; }
	.field label { font-size: 0.9em; color: var(--vscode-foreground); text-align: right;
		overflow-wrap: anywhere; }
	.field input, .field select { padding: 3px 6px; }
	/* Каркас оформляет только текст, число и пароль: дате нужны те же цвета */
	.field input[type=datetime-local] { background: var(--vscode-input-background);
		color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
		border-radius: 4px; font-family: inherit; font-size: inherit; }
	/* Календарь и стрелки рисует браузер: без подсказки о теме они остаются светлыми */
	body.vscode-dark input[type=datetime-local],
		body.vscode-high-contrast:not(.vscode-high-contrast-light) input[type=datetime-local] { color-scheme: dark; }
	.field.flag { grid-template-columns: 210px minmax(0, 1fr); }
	.field.flag label { order: 1; text-align: right; }
	.field.flag input { order: 2; width: auto; justify-self: start; }
	.readonly { font-family: var(--vscode-editor-font-family); font-size: 0.9em;
		color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
	.state { padding: 14px 0; color: var(--vscode-descriptionForeground); }
	.state.error { color: var(--fail); }
	.state.warn { color: var(--vscode-list-warningForeground, #cca700); padding-bottom: 4px; }
	/* Без разделов блок учётных данных занимает одну колонку, а не всю ширину */
	.sections.single { grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); }
	.access-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; }
	.access-actions .error { padding: 0; }

	.combo { position: relative; min-width: 0; }
	.combo-button { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 6px; cursor: pointer;
		background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-panel-border)));
		border-radius: 4px; }
	.combo-button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.combo-button .chevron { display: flex; margin-left: auto; padding-left: 4px; flex: none; }
	.combo-list { position: absolute; z-index: 10; left: 0; right: 0; top: calc(100% + 2px); max-height: 260px;
		overflow: auto; padding: 4px 0; border-radius: 4px;
		background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background));
		color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border, var(--line));
		box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); }
	.combo-option { display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer; }
	.combo-option.active { background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground); }
	.combo-separator { height: 1px; margin: 4px 0; background: var(--line); }
	.combo-marker { display: flex; align-items: center; justify-content: center; width: 12px; flex: none; }
	.combo-marker .dot { width: 7px; height: 7px; border-radius: 50%; }
	.combo-name { min-width: 0; flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.combo-name.placeholder { color: var(--vscode-descriptionForeground); }
	.combo-desc { min-width: 0; flex: 0 3 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		font-size: 0.92em; color: var(--vscode-descriptionForeground); }
	.combo-option.active .combo-desc, .combo-option.active .combo-name.placeholder { color: inherit; opacity: 0.8; }
</style>
</head>
<body>
<div class="chrome">
	<div class="toolbar">
		<span class="title" id="subtitle">Свойства объекта кластера</span>
		<button id="reload">Обновить</button>
	</div>
	<div class="chrome-body">
		<div class="main" id="main"><div class="state">Читаю свойства…</div></div>
	</div>
	${saveBarHtml()}
</div>
<script nonce="${nonce}">
${chromeScript()}

let sections = [];
let draft = {};
let baseline = {};

function readonlyField(item, value) {
	const wrap = document.createElement('div');
	wrap.className = 'field';
	const label = document.createElement('label');
	label.textContent = item.title;
	const text = document.createElement('div');
	text.className = 'readonly';
	text.textContent = value;
	wrap.appendChild(label);
	wrap.appendChild(text);
	return wrap;
}

/** Поле с выбором из списка: значения и подписи задаёт описание объекта */
function selectField(item, value) {
	const wrap = document.createElement('div');
	wrap.className = 'field';
	const label = document.createElement('label');
	label.textContent = item.title;
	if (item.hint) { wrap.title = item.hint; }
	const select = document.createElement('select');
	for (const option of item.options || []) {
		const element = document.createElement('option');
		element.value = option[0];
		element.textContent = option[1];
		element.selected = value === option[0];
		select.appendChild(element);
	}
	// Перерисовки нет: от значения зависит только панель сохранения, а пересборка
	// полей по change крала бы фокус и ломала обход карточки по Tab
	select.addEventListener('change', () => { draft[item.key] = select.value; renderSaveBar(); });
	wrap.appendChild(label);
	wrap.appendChild(select);
	return wrap;
}

/** Дата и время: платформа ждёт местное время вида 2026-08-18T22:00:00 */
function dateField(item, value) {
	const wrap = document.createElement('div');
	wrap.className = 'field';
	const label = document.createElement('label');
	label.textContent = item.title;
	if (item.hint) { wrap.title = item.hint; }
	const input = document.createElement('input');
	input.type = 'datetime-local';
	// Секунды платформа хранит, поэтому поле показывает их и не округляет молча
	input.step = '1';
	input.value = value;
	input.addEventListener('change', () => {
		const next = input.value;
		draft[item.key] = next === '' || next.length > 16 ? next : next + ':00';
		renderSaveBar();
	});
	wrap.appendChild(label);
	wrap.appendChild(input);
	return wrap;
}

/** Одно поле карточки: имя параметра именно item, чтобы не перекрыть field() каркаса */
function renderField(item) {
	const value = draft[item.key] === undefined ? '' : draft[item.key];
	if (item.kind === 'readonly') { return readonlyField(item, value); }
	if (item.kind === 'select') { return selectField(item, value); }
	if (item.kind === 'date') { return dateField(item, value); }
	if (item.kind === 'password') {
		const wrap = document.createElement('div');
		wrap.className = 'field';
		const label = document.createElement('label');
		label.textContent = item.title;
		const input = document.createElement('input');
		input.type = 'password';
		input.value = value;
		input.addEventListener('input', () => { pendingEdit = true; renderSaveBar(); });
		input.addEventListener('change', () => {
			pendingEdit = false;
			draft[item.key] = input.value;
			renderSaveBar();
		});
		if (item.hint) { wrap.title = item.hint; }
		wrap.appendChild(label);
		wrap.appendChild(input);
		return wrap;
	}
	if (item.kind === 'flag') {
		const wrap = document.createElement('div');
		wrap.className = 'field flag';
		const label = document.createElement('label');
		label.textContent = item.title;
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = value === 'on';
		input.addEventListener('change', () => {
			draft[item.key] = input.checked ? 'on' : 'off';
			renderSaveBar();
		});
		if (item.hint) { wrap.title = item.hint; }
		wrap.appendChild(label);
		wrap.appendChild(input);
		return wrap;
	}
	const element = field(
		item.title,
		value,
		(next) => { draft[item.key] = next; renderSaveBar(); },
		item.kind === 'number' ? 'number' : 'text'
	);
	// Подпись каркаса стоит над полем, а карточке нужна слева: переносим её сами
	element.className = 'field';
	if (item.hint) { element.title = item.hint; }
	return element;
}

function renderSection(section) {
	const block = document.createElement('div');
	block.className = 'section';
	const heading = document.createElement('h2');
	heading.textContent = section.title;
	block.appendChild(heading);
	for (const item of section.fields) {
		block.appendChild(renderField(item));
	}
	return block;
}

function renderAll() {
	const main = document.getElementById('main');
	main.textContent = '';
	if (loadError) {
		const state = document.createElement('div');
		state.className = 'state error';
		state.textContent = loadError;
		main.appendChild(state);
		renderSaveBar();
		return;
	}
	if (accessNotice) {
		const notice = document.createElement('div');
		notice.className = 'state warn';
		notice.textContent = accessNotice;
		main.appendChild(notice);
	}
	// Учётные данные стоят в первой колонке над первым разделом
	const columns = document.createElement('div');
	columns.className = sections.length > 0 ? 'sections' : 'sections single';
	const first = document.createElement('div');
	const holder = document.createElement('div');
	holder.id = 'access';
	first.appendChild(holder);
	if (sections.length > 0) { first.appendChild(renderSection(sections[0])); }
	columns.appendChild(first);
	for (const section of sections.slice(1)) {
		columns.appendChild(renderSection(section));
	}
	main.appendChild(columns);
	renderAccess();
	renderSaveBar();
}

const NEW_SET = ':new';
const PLUS_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>';

/** Почему объект не прочитан, если причина не в учётных данных */
let loadError = '';
/** Учётные данные: наборы и привязка приходят с хоста, выбор и набранное живут здесь */
let access = null;
let accessNotice = '';
let accessChoice = '';
let accessInitial = '';
let accessDraft = { user: '', password: '', name: '' };
let accessBusy = false;
let accessError = '';
let accessFocus = {};

function resetAccess(state, choice) {
	access = state;
	accessChoice = choice;
	accessInitial = choice;
	// Набранный пароль во вкладке не задерживается
	accessDraft = { user: '', password: '', name: '' };
	accessBusy = false;
	accessError = '';
}

function accessOptions() {
	const options = [{ id: '', name: 'Не назначен', empty: true }];
	for (const set of access.sets) {
		options.push({ id: set.id, name: set.name, desc: set.user, color: access.color });
	}
	options.push({ id: NEW_SET, name: 'Новый набор', plus: true, separated: true });
	return options;
}

/**
 * Строка набора: точка, имя и серым пользователь; у нового набора вместо точки
 * плюс. В списке место под метку есть у каждой строки.
 */
function optionContent(target, option, inList) {
	if (inList || !option.empty) {
		const marker = document.createElement('span');
		marker.className = 'combo-marker';
		if (option.plus) {
			marker.innerHTML = PLUS_ICON;
		} else if (option.color) {
			const dot = document.createElement('span');
			dot.className = 'dot';
			dot.style.background = option.color;
			marker.appendChild(dot);
		}
		target.appendChild(marker);
	}
	const name = document.createElement('span');
	name.className = option.empty ? 'combo-name placeholder' : 'combo-name';
	name.textContent = option.name;
	target.appendChild(name);
	if (option.desc) {
		const desc = document.createElement('span');
		desc.className = 'combo-desc';
		desc.textContent = option.desc;
		target.appendChild(desc);
	}
}

/**
 * Выпадающий список с серым пояснением в строке. Фокус всё время на кнопке,
 * строки выбираются мышью и стрелками.
 */
function combo(options, value, onChange) {
	const wrap = document.createElement('div');
	wrap.className = 'combo';
	const button = document.createElement('div');
	button.className = 'combo-button';
	button.tabIndex = 0;
	button.setAttribute('role', 'combobox');
	button.setAttribute('aria-haspopup', 'listbox');
	button.setAttribute('aria-expanded', 'false');
	button.setAttribute('aria-controls', 'comboList');
	optionContent(button, options.find((option) => option.id === value) || options[0], false);
	const chevron = document.createElement('span');
	chevron.className = 'chevron';
	chevron.innerHTML = CHEVRON_ICON;
	button.appendChild(chevron);

	const list = document.createElement('div');
	list.className = 'combo-list';
	list.id = 'comboList';
	list.setAttribute('role', 'listbox');
	list.hidden = true;
	let active = -1;
	const rows = options.map((option, index) => {
		if (option.separated) {
			const line = document.createElement('div');
			line.className = 'combo-separator';
			list.appendChild(line);
		}
		const row = document.createElement('div');
		row.className = 'combo-option';
		row.id = 'comboOption' + index;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(option.id === value));
		optionContent(row, option, true);
		// Нажатие по строке не уводит фокус с кнопки, иначе список закрылся бы до щелчка
		row.addEventListener('mousedown', (event) => event.preventDefault());
		row.addEventListener('mousemove', () => highlight(index, false));
		row.addEventListener('click', () => pick(index));
		list.appendChild(row);
		return row;
	});

	function highlight(index, reveal) {
		active = index;
		rows.forEach((row, position) => row.classList.toggle('active', position === index));
		button.setAttribute('aria-activedescendant', rows[index].id);
		if (reveal) { rows[index].scrollIntoView({ block: 'nearest' }); }
	}
	function open() {
		list.hidden = false;
		button.setAttribute('aria-expanded', 'true');
		highlight(Math.max(0, options.findIndex((option) => option.id === value)), true);
	}
	function close() {
		list.hidden = true;
		button.setAttribute('aria-expanded', 'false');
		button.removeAttribute('aria-activedescendant');
	}
	function pick(index) {
		close();
		if (options[index].id !== value) { onChange(options[index].id); }
	}

	button.addEventListener('click', () => { if (list.hidden) { open(); } else { close(); } });
	button.addEventListener('blur', close);
	button.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (list.hidden) { open(); return; }
			const next = active + (event.key === 'ArrowDown' ? 1 : -1);
			highlight(Math.min(rows.length - 1, Math.max(0, next)), true);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (list.hidden) { open(); } else { pick(active); }
		} else if (event.key === 'Escape' && !list.hidden) {
			event.preventDefault();
			close();
		}
	});
	wrap.appendChild(button);
	wrap.appendChild(list);
	return { wrap: wrap, button: button };
}

function accessInput(title, value, type, onInput) {
	const wrap = document.createElement('div');
	wrap.className = 'field';
	const label = document.createElement('label');
	label.textContent = title;
	const input = document.createElement('input');
	input.type = type;
	input.value = value;
	input.addEventListener('input', () => onInput(input.value));
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') { grantAccess(); }
	});
	wrap.appendChild(label);
	wrap.appendChild(input);
	return { wrap: wrap, input: input };
}

function accessButton(text, primary, onClick) {
	const button = document.createElement('button');
	if (primary) { button.className = 'primary'; }
	button.textContent = text;
	button.disabled = accessBusy;
	button.addEventListener('click', onClick);
	return button;
}

/** Кнопки появляются, когда выбор расходится с привязкой: сам выбор ничего не меняет */
function renderAccess() {
	const holder = document.getElementById('access');
	if (!holder) { return; }
	holder.textContent = '';
	accessFocus = {};
	if (!access) { return; }
	const block = document.createElement('div');
	block.className = 'section';
	const heading = document.createElement('h2');
	heading.textContent = 'Учётные данные';
	block.appendChild(heading);

	const row = document.createElement('div');
	row.className = 'field';
	const label = document.createElement('label');
	label.textContent = 'Набор';
	const picker = combo(accessOptions(), accessChoice, (next) => {
		accessChoice = next;
		accessError = '';
		renderAccess();
		focusAccess(next === NEW_SET ? 'user' : 'combo');
	});
	accessFocus.combo = picker.button;
	row.appendChild(label);
	row.appendChild(picker.wrap);
	block.appendChild(row);

	if (accessChoice === NEW_SET) {
		const name = accessInput('Название набора', accessDraft.name, 'text', (value) => { accessDraft.name = value; });
		const user = accessInput('Пользователь', accessDraft.user, 'text', (value) => {
			accessDraft.user = value;
			name.input.placeholder = value;
		});
		const password = accessInput('Пароль', accessDraft.password, 'password', (value) => { accessDraft.password = value; });
		name.input.placeholder = accessDraft.user;
		accessFocus.user = user.input;
		accessFocus.password = password.input;
		block.appendChild(user.wrap);
		block.appendChild(password.wrap);
		block.appendChild(name.wrap);
	}

	const bound = access.boundId || '';
	const buttons = [];
	if (accessChoice === '' && bound !== '') {
		buttons.push(accessButton('Отвязать', true, revokeAccess));
	} else if (accessChoice !== '' && accessChoice !== bound) {
		buttons.push(accessButton(accessBusy ? 'Проверяю…' : 'Привязать', true, grantAccess));
	}
	if (accessChoice !== accessInitial) {
		buttons.push(accessButton('Отмена', false, cancelAccess));
	}
	if (buttons.length > 0 || accessError) {
		const actions = document.createElement('div');
		actions.className = 'field';
		actions.appendChild(document.createElement('span'));
		const line = document.createElement('div');
		line.className = 'access-actions';
		for (const button of buttons) { line.appendChild(button); }
		if (accessError) {
			const error = document.createElement('span');
			error.className = 'error';
			error.textContent = accessError;
			line.appendChild(error);
		}
		actions.appendChild(line);
		block.appendChild(actions);
	}
	holder.appendChild(block);
}

function focusAccess(target) {
	const element = accessFocus[target];
	if (element) { element.focus(); }
}

function grantAccess() {
	if (accessBusy) { return; }
	const fresh = accessChoice === NEW_SET;
	if (fresh && accessDraft.user.trim() === '') {
		accessError = 'Укажите пользователя';
		renderAccess();
		focusAccess('user');
		return;
	}
	accessBusy = true;
	accessError = '';
	renderAccess();
	post({
		type: 'grantAccess',
		choice: fresh
			? { user: accessDraft.user, password: accessDraft.password, name: accessDraft.name }
			: { setId: accessChoice },
	});
}

function revokeAccess() {
	if (accessBusy) { return; }
	accessBusy = true;
	accessError = '';
	renderAccess();
	post({ type: 'revokeAccess' });
}

function cancelAccess() {
	resetAccess(access, accessInitial);
	renderAccess();
	focusAccess('combo');
}

document.getElementById('reload').addEventListener('click', () => post({ type: 'reload' }));

window.addEventListener('message', (event) => {
	const data = event.data;
	if (data.type === 'model') {
		loadError = '';
		accessNotice = '';
		resetAccess(data.access || null, (data.access && data.access.boundId) || '');
		sections = data.sections;
		draft = JSON.parse(JSON.stringify(data.values));
		baseline = JSON.parse(JSON.stringify(data.values));
		document.getElementById('subtitle').textContent = data.subtitle;
		commit();
		return;
	}
	if (data.type === 'access') {
		resetAccess(data.access, data.access.boundId || '');
		renderAccess();
		return;
	}
	if (data.type === 'accessFailed') {
		accessBusy = false;
		accessError = data.message;
		renderAccess();
		focusAccess(accessChoice === NEW_SET ? 'password' : 'combo');
		return;
	}
	if (data.type === 'saved') {
		saveStatus = data.message || ${JSON.stringify(CHROME_LABELS.saved)};
		saveStatusKind = 'ok';
		renderSaveBar();
		return;
	}
	if (data.type === 'saveFailed') {
		saveStatus = data.message;
		saveStatusKind = 'error';
		renderSaveBar();
		return;
	}
	if (data.type === 'failed') {
		document.getElementById('subtitle').textContent = data.subtitle;
		sections = [];
		draft = {};
		baseline = {};
		if (data.access) {
			loadError = '';
			accessNotice = data.message;
			// Без сохранённых наборов сразу открываются поля нового
			const bound = data.access.boundId || '';
			resetAccess(data.access, bound || (data.access.sets.length === 0 ? NEW_SET : ''));
		} else {
			loadError = data.message;
			accessNotice = '';
			resetAccess(null, '');
		}
		commit();
	}
});
</script>
</body>
</html>`;
}
