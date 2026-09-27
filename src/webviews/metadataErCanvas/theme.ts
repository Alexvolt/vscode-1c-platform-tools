/**
 * Цвета ER-диаграммы из темы VS Code.
 *
 * Cytoscape рисует на canvas и не понимает CSS-переменные: оформление строится
 * из готовых значений цветов темы. Модуль без DOM, тему из webview читает
 * {@link module:webviews/metadataErCanvas/themeDom}.
 *
 * @module webviews/metadataErCanvas/theme
 */

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

export type ThemeKind = 'dark' | 'light' | 'high-contrast' | 'high-contrast-light';

/** Цвета темы, от которых строится оформление схемы. */
export interface ErTheme {
	readonly kind: ThemeKind;
	readonly background: Rgb;
	readonly foreground: Rgb;
	readonly muted: Rgb;
	readonly seed: Rgb;
	readonly selected: Rgb;
	readonly fontFamily: string;
}

/** Цвета узла одного вида объектов. */
export interface NodeColors {
	readonly fill: string;
	readonly border: string;
	readonly text: string;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

/**
 * Разбирает цвет CSS в записи `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` или `rgba()`.
 *
 * @param value - Значение цвета
 * @returns Цвет или undefined, если запись не распознана
 */
export function parseColor(value: string): Rgb | undefined {
	const text = value.trim();
	const hex = HEX.exec(text);
	if (hex) {
		const digits = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
		const channel = (i: number): number => Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
		return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? channel(3) / 255 : 1 };
	}
	const rgb = RGB.exec(text);
	if (rgb) {
		const alpha = rgb[4] === undefined
			? 1
			: rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]);
		return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: Math.min(1, Math.max(0, alpha)) };
	}
	return undefined;
}

/**
 * Смешивает два цвета: доля первого `share`, остальное второй.
 *
 * @param first - Первый цвет
 * @param second - Второй цвет
 * @param share - Доля первого цвета от 0 до 1
 */
export function mix(first: Rgb, second: Rgb, share: number): Rgb {
	const blend = (a: number, b: number): number => a * share + b * (1 - share);
	return { r: blend(first.r, second.r), g: blend(first.g, second.g), b: blend(first.b, second.b), a: 1 };
}

/**
 * Непрозрачный цвет: полупрозрачный накладывается на фон.
 *
 * @param color - Цвет, возможно с прозрачностью
 * @param background - Фон под ним
 */
export function opaque(color: Rgb, background: Rgb): Rgb {
	return color.a >= 1 ? color : mix(color, background, color.a);
}

function luminance(color: Rgb): number {
	const linear = (channel: number): number => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * Контраст двух цветов по WCAG: от 1 до 21.
 *
 * @param first - Первый цвет
 * @param second - Второй цвет
 */
export function contrast(first: Rgb, second: Rgb): number {
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

/** Цвет с целыми каналами в пределах 0..255: таким его рисует canvas. */
function rounded(color: Rgb): Rgb {
	const channel = (value: number): number => Math.round(Math.min(255, Math.max(0, value)));
	return { r: channel(color.r), g: channel(color.g), b: channel(color.b), a: color.a };
}

/** Цвет в записи `rgb()`, которую понимает Cytoscape. */
export function toCss(color: Rgb): string {
	const { r, g, b } = rounded(color);
	return `rgb(${r}, ${g}, ${b})`;
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0, a: 1 };

/** Контраст подписи с заливкой узла. */
const MIN_TEXT_CONTRAST = 4.5;

/** Контраст линий и рамок с фоном схемы. */
const MIN_LINE_CONTRAST = 3;

/** Доля цвета вида в заливке узла поверх фона. */
const TINT: Record<ThemeKind, number> = {
	'dark': 0.28,
	'light': 0.18,
	'high-contrast': 0.18,
	'high-contrast-light': 0.1,
};

/** Высококонтрастная тема, светлая или тёмная. */
export function isHighContrast(theme: ErTheme): boolean {
	return theme.kind === 'high-contrast' || theme.kind === 'high-contrast-light';
}

/**
 * Цвет линии или рамки, заметный на фоне схемы: при слабом контрасте он
 * сдвигается к цвету текста темы.
 *
 * @param color - Исходный цвет
 * @param theme - Тема
 */
export function lineColor(color: Rgb, theme: ErTheme): Rgb {
	for (let share = 1; share > 0; share -= 0.05) {
		const candidate = rounded(mix(color, theme.foreground, share));
		if (contrast(candidate, theme.background) >= MIN_LINE_CONTRAST) {
			return candidate;
		}
	}
	return theme.foreground;
}

/**
 * Цвет вида объектов или связей, заметный на фоне темы.
 *
 * @param accent - Цвет вида
 * @param theme - Тема
 */
export function accentColor(accent: string, theme: ErTheme): Rgb {
	return lineColor(parseColor(accent) ?? theme.muted, theme);
}

/**
 * Цвета узла: заливка с оттенком вида поверх фона, рамка цветом вида, подпись цветом текста темы.
 *
 * Если подпись теряется на заливке, она становится чёрной или белой.
 *
 * @param accent - Цвет вида объектов
 * @param theme - Тема
 */
export function nodeColors(accent: string, theme: ErTheme): NodeColors {
	const fill = mix(parseColor(accent) ?? theme.muted, theme.background, TINT[theme.kind]);
	let text = theme.foreground;
	if (contrast(text, fill) < MIN_TEXT_CONTRAST) {
		text = contrast(BLACK, fill) >= contrast(WHITE, fill) ? BLACK : WHITE;
	}
	return { fill: toCss(fill), border: toCss(accentColor(accent, theme)), text: toCss(text) };
}

/**
 * Вид темы по атрибуту, который VS Code ставит на `body` webview.
 *
 * @param attribute - Значение `data-vscode-theme-kind`
 * @param background - Фон редактора
 */
export function themeKind(attribute: string | undefined, background: Rgb): ThemeKind {
	switch (attribute) {
		case 'vscode-light':
			return 'light';
		case 'vscode-dark':
			return 'dark';
		case 'vscode-high-contrast':
			return 'high-contrast';
		case 'vscode-high-contrast-light':
			return 'high-contrast-light';
		default:
			return luminance(background) > 0.5 ? 'light' : 'dark';
	}
}
