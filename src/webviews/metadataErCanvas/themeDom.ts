/**
 * Тема VS Code в webview ER-диаграммы: чтение CSS-переменных и слежение за сменой темы.
 *
 * @module webviews/metadataErCanvas/themeDom
 */

import { opaque, parseColor, themeKind, WHITE } from './theme';
import type { ErTheme, Rgb } from './theme';

/** Цвета темы Dark Modern: на случай, если переменная не задана. */
const FALLBACK = {
	background: '#1f1f1f',
	foreground: '#cccccc',
	muted: '#9d9d9d',
	seed: '#cca700',
	selected: '#d18616',
	fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;

/**
 * Приводит значение CSS-переменной к цвету: запись, которую не разбирает
 * {@link parseColor}, вычисляет браузер.
 */
function resolveColor(value: string, probe: HTMLElement): Rgb | undefined {
	const parsed = parseColor(value);
	if (parsed || value === '') {
		return parsed;
	}
	probe.style.color = '';
	probe.style.color = value;
	return probe.style.color === '' ? undefined : parseColor(getComputedStyle(probe).color);
}

/**
 * Читает цвета текущей темы из CSS-переменных VS Code.
 *
 * @returns Тема для оформления схемы
 */
export function readErTheme(): ErTheme {
	const styles = getComputedStyle(document.body);
	const variable = (name: string): string => styles.getPropertyValue(name).trim();
	const probe = document.createElement('span');
	probe.hidden = true;
	document.body.appendChild(probe);
	try {
		const color = (name: string, fallback: string): Rgb =>
			resolveColor(variable(name), probe) ?? (parseColor(fallback) as Rgb);
		const background = opaque(color('--vscode-editor-background', FALLBACK.background), WHITE);
		const read = (name: string, fallback: string): Rgb => opaque(color(name, fallback), background);
		return {
			kind: themeKind(document.body.dataset.vscodeThemeKind, background),
			background,
			foreground: read('--vscode-editor-foreground', FALLBACK.foreground),
			muted: read('--vscode-descriptionForeground', FALLBACK.muted),
			seed: read('--vscode-charts-yellow', FALLBACK.seed),
			selected: read('--vscode-charts-orange', FALLBACK.selected),
			fontFamily: variable('--vscode-font-family') || FALLBACK.fontFamily,
		};
	} finally {
		probe.remove();
	}
}

/**
 * Вызывает `onChange`, когда VS Code меняет тему: переменные цветов лежат
 * в `style` корневого элемента, вид темы в атрибутах `body`.
 *
 * @param onChange - Перестроение оформления
 * @returns Отписка
 */
export function watchThemeChanges(onChange: () => void): () => void {
	let pending = 0;
	const schedule = (): void => {
		if (pending === 0) {
			pending = requestAnimationFrame(() => {
				pending = 0;
				onChange();
			});
		}
	};
	const observer = new MutationObserver(schedule);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
	observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-name'] });
	return () => {
		observer.disconnect();
		if (pending !== 0) {
			cancelAnimationFrame(pending);
		}
	};
}
