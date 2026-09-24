/**
 * Запросы к стандартному интерфейсу OData: адреса, параметры и разбор ответа.
 *
 * Модуль не знает ни про VS Code, ни про автономный сервер: адрес публикации,
 * учётная запись и сам HTTP-вызов приходят снаружи. Так правила построения
 * запроса и текста ошибок проверяются без платформы.
 */

/** Путь стандартного интерфейса OData от корня публикации. */
export const ODATA_SERVICE_PATH = 'odata/standard.odata/';

/** Методы HTTP, которые принимает команда. */
export const ODATA_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Метод HTTP запроса к OData. */
export type ODataMethod = (typeof ODATA_METHODS)[number];

/** Параметры выборки: уходят в запрос как `$filter`, `$select` и т.д. */
export interface ODataQueryOptions {
	filter?: string;
	select?: string;
	expand?: string;
	orderby?: string;
	top?: number;
	skip?: number;
	/** Запросить общее число записей выборки (`$inlinecount=allpages`). */
	count?: boolean;
}

/** Порядок параметров выборки в адресе запроса. */
const QUERY_OPTION_KEYS: readonly (keyof ODataQueryOptions)[] = ['filter', 'select', 'expand', 'orderby', 'top', 'skip'];

/**
 * Приводит адрес публикации к корню стандартного интерфейса OData.
 *
 * Принимается корень публикации (`http://host/base`), адрес самого интерфейса
 * (`…/odata/standard.odata`) или любой адрес внутри него, например скопированный
 * из браузера `$metadata`.
 *
 * @param url - Адрес публикации
 * @returns Корень интерфейса со слэшем на конце: `http://host/base/odata/standard.odata/`
 * @throws {Error} Если адрес не http(s)
 */
export function serviceRootFromUrl(url: string): string {
	const trimmed = url.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Некорректный адрес публикации: ${trimmed || '(пусто)'}. Ожидается http://сервер/публикация`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`Адрес публикации должен начинаться с http:// или https://: ${trimmed}`);
	}
	parsed.search = '';
	parsed.hash = '';
	parsed.username = '';
	parsed.password = '';
	const marker = '/odata/standard.odata';
	const pathname = parsed.pathname;
	const index = pathname.toLowerCase().indexOf(marker);
	parsed.pathname = index === -1
		? `${pathname.replace(/\/+$/, '')}/${ODATA_SERVICE_PATH}`
		: `${pathname.slice(0, index + marker.length)}/`;
	return parsed.toString();
}

/**
 * Разбирает метод HTTP из параметра команды.
 *
 * @param value - Значение параметра method; без него - GET
 * @returns Метод или undefined, если он не поддерживается
 */
export function parseODataMethod(value: unknown): ODataMethod | undefined {
	if (value === undefined || value === null || value === '') {
		return 'GET';
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const upper = value.trim().toUpperCase();
	return (ODATA_METHODS as readonly string[]).includes(upper) ? (upper as ODataMethod) : undefined;
}

/**
 * Кодирует часть адреса, не трогая уже закодированное.
 *
 * Агент пишет адрес как видит: с кириллицей и пробелами, а иногда копирует
 * уже закодированный. Сначала раскодируем, затем кодируем заново.
 *
 * @param text - Часть адреса
 * @param encode - Функция кодирования
 */
function reencode(text: string, encode: (value: string) => string): string {
	let decoded = text;
	try {
		decoded = decodeURIComponent(text);
	} catch {
		// одиночный «%» в тексте: кодируем как есть
	}
	return encode(decoded);
}

/**
 * Кодирует значение параметра запроса.
 *
 * Пробел кодируется как `%20`, а не `+`: в значении `$filter` плюс - это знак.
 *
 * @param value - Значение параметра
 */
function encodeQueryValue(value: string): string {
	return reencode(value, encodeURIComponent);
}

/**
 * Кодирует путь ресурса: кириллица и пробелы кодируются, `(`, `)`, `'`, `/`, `,` и `=` остаются.
 *
 * @param resourcePath - Путь ресурса без параметров
 */
function encodeResourcePath(resourcePath: string): string {
	return reencode(resourcePath, encodeURI);
}

/**
 * Имя набора сущностей, к которому обращается запрос.
 *
 * @param resource - Ресурс: `Catalog_Товары`, `Catalog_Товары(guid'…')/Товары`, `$metadata`
 * @returns Имя набора (`Catalog_Товары`) или undefined для служебных ресурсов
 */
export function entitySetOf(resource: string): string | undefined {
	const pathPart = resource.trim().replace(/^\/+/, '').split('?')[0];
	const name = pathPart.split(/[(/]/)[0].trim();
	if (name === '' || name.startsWith('$')) {
		return undefined;
	}
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/**
 * Запрос читает выборку из набора целиком: набор без ключа элемента и без `top`.
 *
 * @param resource - Ресурс запроса
 * @param options - Параметры выборки
 */
export function readsWholeSet(resource: string, options: ODataQueryOptions = {}): boolean {
	const trimmed = resource.trim().replace(/^\/+/, '');
	const [resourcePath, inlineQuery = ''] = trimmed.split('?', 2);
	if (entitySetOf(resourcePath) === undefined || /[(/]/.test(resourcePath)) {
		return false;
	}
	return options.top === undefined && !/(^|&)\$top=/.test(inlineQuery);
}

/**
 * Строит адрес запроса к OData.
 *
 * Параметры выборки из options перекрывают одноимённые параметры, записанные
 * прямо в ресурсе. Ответ запрашивается в JSON (`$format=json`), кроме
 * `$metadata`: схема отдаётся только в XML.
 *
 * @param serviceRoot - Корень интерфейса (см. {@link serviceRootFromUrl})
 * @param resource - Ресурс с необязательными параметрами после `?`
 * @param options - Параметры выборки
 * @returns Полный адрес запроса
 */
export function buildODataUrl(serviceRoot: string, resource: string, options: ODataQueryOptions = {}): string {
	const trimmed = resource.trim().replace(/^\/+/, '');
	const questionIndex = trimmed.indexOf('?');
	const resourcePath = questionIndex === -1 ? trimmed : trimmed.slice(0, questionIndex);
	const inlineQuery = questionIndex === -1 ? '' : trimmed.slice(questionIndex + 1);

	const params = new Map<string, string>();
	for (const pair of inlineQuery.split('&')) {
		if (pair === '') {
			continue;
		}
		const eq = pair.indexOf('=');
		const key = eq === -1 ? pair : pair.slice(0, eq);
		const value = eq === -1 ? '' : pair.slice(eq + 1);
		params.set(key, value);
	}
	for (const key of QUERY_OPTION_KEYS) {
		const value = options[key];
		if (value !== undefined && value !== '') {
			params.set(`$${key}`, String(value));
		}
	}
	if (options.count && !params.has('$inlinecount')) {
		params.set('$inlinecount', 'allpages');
	}
	const isMetadata = resourcePath === '$metadata' || resourcePath.endsWith('/$metadata');
	if (!isMetadata && !params.has('$format')) {
		params.set('$format', 'json');
	}

	const query = [...params.entries()]
		.map(([key, value]) => (value === '' ? key : `${key}=${encodeQueryValue(value)}`))
		.join('&');
	return `${serviceRoot}${encodeResourcePath(resourcePath)}${query ? `?${query}` : ''}`;
}

/**
 * Заголовок Basic-авторизации: имя и пароль в UTF-8, как их ждёт веб-сервер 1С.
 *
 * @param user - Имя пользователя ИБ
 * @param password - Пароль
 */
export function basicAuthorization(user: string, password: string): string {
	return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Текст ошибки платформы из тела ответа.
 *
 * 1С отдаёт ошибку в JSON (`odata.error.message.value`) либо в XML
 * (`<m:message>`), смотря по запрошенному формату.
 *
 * @param body - Тело ответа
 * @returns Текст ошибки или undefined, если тело ошибку не описывает
 */
export function parseODataError(body: string): string | undefined {
	const text = body.replace(/^﻿/, '').trim();
	if (text === '') {
		return undefined;
	}
	if (text.startsWith('{')) {
		try {
			const json = JSON.parse(text) as Record<string, unknown>;
			const error = (json['odata.error'] ?? json.error) as Record<string, unknown> | undefined;
			if (error && typeof error === 'object') {
				const message = error.message as unknown;
				const value = typeof message === 'string'
					? message
					: typeof (message as { value?: unknown })?.value === 'string'
						? (message as { value: string }).value
						: undefined;
				const code = typeof error.code === 'string' && error.code !== '' ? ` (код ${error.code})` : '';
				return value === undefined ? undefined : `${value}${code}`;
			}
		} catch {
			return undefined;
		}
		return undefined;
	}
	const xml = /<(?:\w+:)?message[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/i.exec(text);
	return xml ? decodeXmlText(xml[1]).trim() : undefined;
}

/**
 * Раскрывает сущности XML в тексте сообщения.
 *
 * @param text - Текст из XML
 */
function decodeXmlText(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/**
 * Опубликован ли набор сущностей в схеме `$metadata`.
 *
 * @param metadataXml - Схема стандартного интерфейса
 * @param entitySet - Имя набора: `Catalog_Товары`
 */
export function metadataHasEntitySet(metadataXml: string, entitySet: string): boolean {
	const escaped = entitySet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`<EntitySet\\s+Name="${escaped}"`).test(metadataXml);
}

/** Тело ответа, урезанное для агента. */
export interface LimitedPayload {
	/** Данные ответа: разобранный JSON или текст. */
	data: unknown;
	/** Сколько записей показано из скольких, если выборка урезана. */
	shown?: { returned: number; total: number };
	/** Текст урезан по длине. */
	truncated?: boolean;
}

/**
 * Урезает тело ответа до предела длины.
 *
 * У выборки урезается массив `value`: агенту полезнее целые записи из начала,
 * чем обрывок JSON. Прочий ответ обрезается по длине.
 *
 * @param data - Разобранный JSON или текст ответа
 * @param limit - Предел длины сериализованного ответа, символов
 * @returns Данные для ответа и признак урезания
 */
export function limitPayload(data: unknown, limit: number): LimitedPayload {
	if (typeof data === 'string') {
		return data.length <= limit ? { data } : { data: data.slice(0, limit), truncated: true };
	}
	const serialized = JSON.stringify(data) ?? '';
	if (serialized.length <= limit) {
		return { data };
	}
	const record = data as Record<string, unknown> | null;
	if (record && typeof record === 'object' && Array.isArray(record.value)) {
		const items = record.value as unknown[];
		const kept: unknown[] = [];
		let size = JSON.stringify({ ...record, value: [] }).length;
		for (const item of items) {
			const itemSize = (JSON.stringify(item) ?? '').length + 1;
			if (size + itemSize > limit) {
				break;
			}
			kept.push(item);
			size += itemSize;
		}
		return { data: { ...record, value: kept }, shown: { returned: kept.length, total: items.length } };
	}
	return { data: serialized.slice(0, limit), truncated: true };
}

/**
 * Разбирает тело JSON-запроса на запись.
 *
 * @param body - Объект или строка JSON
 * @returns Текст тела запроса
 * @throws {Error} Если строка не JSON
 */
export function serializeRequestBody(body: unknown): string {
	if (typeof body === 'string') {
		try {
			JSON.parse(body);
		} catch (error) {
			throw new Error(`Тело запроса не JSON: ${(error as Error).message}`);
		}
		return body;
	}
	return JSON.stringify(body);
}
