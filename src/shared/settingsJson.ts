/**
 * Разбор файлов настроек vanessa-runner: env.json, autumn-properties.json,
 * env.local.json и файлы каталога tools. BOM и комментарии разбору не мешают.
 * @module settingsJson
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as jsonc from 'jsonc-parser';

const PARSE_ERROR_TEXT: Partial<Record<jsonc.ParseErrorCode, string>> = {
	[jsonc.ParseErrorCode.InvalidSymbol]: 'недопустимый символ',
	[jsonc.ParseErrorCode.InvalidNumberFormat]: 'неверный формат числа',
	[jsonc.ParseErrorCode.PropertyNameExpected]: 'ожидалось имя свойства',
	[jsonc.ParseErrorCode.ValueExpected]: 'ожидалось значение',
	[jsonc.ParseErrorCode.ColonExpected]: 'ожидалось двоеточие',
	[jsonc.ParseErrorCode.CommaExpected]: 'ожидалась запятая',
	[jsonc.ParseErrorCode.CloseBraceExpected]: 'не закрыта фигурная скобка',
	[jsonc.ParseErrorCode.CloseBracketExpected]: 'не закрыта квадратная скобка',
	[jsonc.ParseErrorCode.EndOfFileExpected]: 'лишний текст после JSON',
	[jsonc.ParseErrorCode.UnexpectedEndOfComment]: 'не закрыт комментарий',
	[jsonc.ParseErrorCode.UnexpectedEndOfString]: 'не закрыта строка',
};

/**
 * Разбирает текст файла настроек.
 *
 * @param text - Содержимое файла
 * @returns Значение JSON
 * @throws {Error} Если текст не разбирается; в сообщении причина и строка
 */
export function parseSettingsJson(text: string): unknown {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const errors: jsonc.ParseError[] = [];
	const value: unknown = jsonc.parse(source, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		const line = source.slice(0, first.offset).split('\n').length;
		throw new Error(`${PARSE_ERROR_TEXT[first.error] ?? 'ошибка синтаксиса'}, строка ${line}`);
	}
	return value;
}

/**
 * Читает и разбирает файл настроек.
 *
 * @param filePath - Абсолютный путь к файлу
 * @returns Значение JSON
 * @throws {Error} Если файла нет или он не разбирается
 */
export function readSettingsJsonSync(filePath: string): unknown {
	return parseSettingsJson(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Читает и разбирает файл настроек без блокировки.
 *
 * @param filePath - Абсолютный путь к файлу
 * @returns Значение JSON
 * @throws {Error} Если файла нет или он не разбирается
 */
export async function readSettingsJson(filePath: string): Promise<unknown> {
	return parseSettingsJson(await fsPromises.readFile(filePath, 'utf8'));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function overlayValue(upper: unknown, lower: unknown): unknown {
	if (upper === undefined || upper === null) {
		return lower;
	}
	if (Array.isArray(upper)) {
		return Array.isArray(lower) ? [...upper, ...lower] : upper;
	}
	if (isJsonObject(upper) && isJsonObject(lower)) {
		const merged: Record<string, unknown> = { ...upper };
		for (const [key, value] of Object.entries(lower)) {
			merged[key] = overlayValue(merged[key], value);
		}
		return merged;
	}
	return upper;
}

/**
 * Накладывает файлы настроек vanessa-runner 3 друг на друга так же, как раннер:
 * значение более важного файла остаётся, объекты сливаются по ключам, списки
 * складываются, значение другого вида из менее важного файла отбрасывается.
 *
 * @param layers - Разобранные файлы от важного к общему; не объекты пропускаются
 * @returns Слитые настройки
 */
export function overlaySettings(layers: readonly unknown[]): Record<string, unknown> {
	let merged: Record<string, unknown> = {};
	for (const layer of layers) {
		if (isJsonObject(layer)) {
			merged = overlayValue(merged, layer) as Record<string, unknown>;
		}
	}
	return merged;
}
