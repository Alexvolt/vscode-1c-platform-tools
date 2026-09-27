/**
 * Цвета ER-диаграммы в темах VS Code.
 * Запуск: npm run compile && node --test out/test/metadata/erTheme.node.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCytoscapeStyle } from '../../webviews/metadataErCanvas/style';
import { contrast, nodeColors, parseColor, themeKind } from '../../webviews/metadataErCanvas/theme';
import type { ErTheme, Rgb, ThemeKind } from '../../webviews/metadataErCanvas/theme';

function color(value: string): Rgb {
	const parsed = parseColor(value);
	assert.ok(parsed, value);
	return parsed;
}

function theme(kind: ThemeKind, background: string, foreground: string, muted: string): ErTheme {
	return {
		kind,
		background: color(background),
		foreground: color(foreground),
		muted: color(muted),
		seed: color('#cca700'),
		selected: color('#d18616'),
		fontFamily: '"Segoe WPC", "Segoe UI", sans-serif',
	};
}

/** Фон, текст и приглушённый текст встроенных и популярных тем. */
const THEMES: Record<string, ErTheme> = {
	'Dark Modern': theme('dark', '#1f1f1f', '#cccccc', '#9d9d9d'),
	'Light Modern': theme('light', '#ffffff', '#3b3b3b', '#3b3b3b'),
	'Dark+': theme('dark', '#1e1e1e', '#d4d4d4', '#ccccccb3'),
	'Light+': theme('light', '#ffffff', '#000000', '#717171'),
	'High Contrast': theme('high-contrast', '#000000', '#ffffff', '#ffffffb3'),
	'High Contrast Light': theme('high-contrast-light', '#ffffff', '#292929', '#292929'),
	'Solarized Light': theme('light', '#fdf6e3', '#657b83', '#586e75'),
	'Monokai': theme('dark', '#272822', '#f8f8f2', '#ccccccb3'),
};

/** Виды, которые часто стоят на одной схеме рядом. */
const NEIGHBOURS: readonly (readonly [string, string])[] = [
	['role', 'documentjournal'],
	['role', 'sequence'],
	['role', 'document'],
	['role', 'catalog'],
	['exchangeplan', 'businessprocess'],
	['exchangeplan', 'task'],
	['exchangeplan', 'catalog'],
	['exchangeplan', 'constant'],
	['chartofaccounts', 'functionaloptionsparameter'],
	['functionaloption', 'functionaloptionsparameter'],
	['document', 'catalog'],
	['document', 'accumulationregister'],
	['accountingregister', 'chartofaccounts'],
];

interface StyleEntry {
	readonly selector: string;
	readonly style: Record<string, unknown>;
}

describe('цвета ER-диаграммы', () => {
	test('разбирает записи цвета, которые отдаёт VS Code и браузер', () => {
		assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
		assert.deepEqual(parseColor('#1F1F1F'), { r: 31, g: 31, b: 31, a: 1 });
		assert.deepEqual(parseColor('#ffffff80'), { r: 255, g: 255, b: 255, a: 128 / 255 });
		assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
		assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
		assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
		assert.equal(parseColor('var(--vscode-editor-foreground)'), undefined);
		assert.equal(parseColor(''), undefined);
	});

	test('вид темы берётся из атрибута VS Code, без него по яркости фона', () => {
		assert.equal(themeKind('vscode-light', color('#000000')), 'light');
		assert.equal(themeKind('vscode-high-contrast-light', color('#ffffff')), 'high-contrast-light');
		assert.equal(themeKind(undefined, color('#ffffff')), 'light');
		assert.equal(themeKind(undefined, color('#1f1f1f')), 'dark');
	});

	for (const [name, current] of Object.entries(THEMES)) {
		test(`${name}: подпись каждого вида объектов читается на своей заливке`, () => {
			const entries = buildCytoscapeStyle(current) as unknown as StyleEntry[];
			const nodes = entries.filter((entry) => entry.selector.startsWith('node.md') && entry.style['color'] !== undefined);
			assert.ok(nodes.length > 20, 'виды объектов в стиле');
			for (const entry of nodes) {
				const fill = color(String(entry.style['background-color']));
				const text = color(String(entry.style['color']));
				assert.ok(contrast(text, fill) >= 4.5, `${entry.selector}: контраст ${contrast(text, fill).toFixed(2)}`);
			}
		});

		test(`${name}: в стиле нет CSS-переменных, которых не понимает canvas`, () => {
			assert.doesNotMatch(JSON.stringify(buildCytoscapeStyle(current)), /var\(/);
		});
	}

	for (const [name, current] of Object.entries(THEMES)) {
		test(`${name}: рамки и линии связей заметны на фоне схемы`, () => {
			const entries = buildCytoscapeStyle(current) as unknown as StyleEntry[];
			for (const entry of entries) {
				for (const property of ['border-color', 'line-color']) {
					const value = entry.style[property];
					if (value !== undefined) {
						const line = color(String(value));
						assert.ok(contrast(line, current.background) >= 3, `${entry.selector} ${property}: ${contrast(line, current.background).toFixed(2)}`);
					}
				}
			}
		});

		test(`${name}: виды, которые встречаются на одной схеме, различаются цветом`, () => {
			const entries = buildCytoscapeStyle(current) as unknown as StyleEntry[];
			const node = (type: string): Rgb[] => {
				const entry = entries.find((item) => item.selector === `node.md.type-${type}`);
				assert.ok(entry, type);
				return [color(String(entry.style['background-color'])), color(String(entry.style['border-color']))];
			};
			const distance = (a: Rgb, b: Rgb): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
			for (const [first, second] of NEIGHBOURS) {
				const [fillA, borderA] = node(first);
				const [fillB, borderB] = node(second);
				const difference = distance(fillA, fillB) + distance(borderA, borderB);
				assert.ok(difference >= 60, `${first}/${second}: ${difference.toFixed(1)}`);
			}
		});
	}

	test('на светлом фоне заливка светлая, на тёмном тёмная', () => {
		const light = color(nodeColors('#6abf4a', THEMES['Light Modern']).fill);
		const dark = color(nodeColors('#6abf4a', THEMES['Dark Modern']).fill);
		assert.ok(contrast(light, THEMES['Light Modern'].background) < 1.5);
		assert.ok(contrast(dark, THEMES['Dark Modern'].background) < 2);
	});

	test('подпись переходит на чёрный или белый, если текст темы теряется на заливке', () => {
		const muddy = theme('dark', '#808080', '#8a8a8a', '#8a8a8a');
		const colors = nodeColors('#808080', muddy);
		assert.ok(contrast(color(colors.text), color(colors.fill)) >= 4.5);
	});
});
