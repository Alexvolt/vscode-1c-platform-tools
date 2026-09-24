/**
 * Вызов стандартного интерфейса OData и понятный разбор неудачи.
 *
 * HTTP-вызов передаётся параметром: в работе это глобальный fetch, в тестах
 * подделка с заранее заданными ответами.
 */

import { metadataEntitySets } from './odataComposition';
import {
	basicAuthorization,
	buildODataUrl,
	entitySetOf,
	limitPayload,
	metadataHasEntitySet,
	parseODataError,
	readsWholeSet,
	serializeRequestBody,
	type ODataMethod,
	type ODataQueryOptions,
} from './odataRequest';

/** Предел ответа агенту по длине, символов: большая выборка вытесняет из контекста всё остальное. */
export const ODATA_PAYLOAD_LIMIT = 60_000;

/** Сколько записей читается из набора, когда top не задан. */
export const ODATA_DEFAULT_TOP = 100;

/** Таймаут HTTP-запроса по умолчанию, мс. */
export const ODATA_TIMEOUT_MS = 120_000;

/** Учётная запись пользователя ИБ. */
export interface ODataCredentials {
	user: string;
	password: string;
}

/** Параметры вызова OData. */
export interface ODataCall {
	/** Корень интерфейса: `http://host/base/odata/standard.odata/`. */
	serviceRoot: string;
	method: ODataMethod;
	/** Ресурс: `Catalog_Товары`, `Catalog_Товары(guid'…')`, `$metadata`. */
	resource: string;
	options?: ODataQueryOptions;
	/** Тело для POST, PUT и PATCH: объект или строка JSON. */
	body?: unknown;
	/** Учётная запись; без неё запрос идёт без авторизации. */
	credentials?: ODataCredentials;
	timeoutMs?: number;
	/**
	 * Вернуть тело целиком, без урезания для агента. Нужно внутренним чтениям:
	 * у 1С наборы `$metadata` стоят в конце схемы, а элемент для PUT нужен полностью.
	 */
	fullBody?: boolean;
}

/** Исход вызова OData. */
export interface ODataOutcome {
	success: boolean;
	/** Адрес запроса без учётных данных. */
	url: string;
	/** Код HTTP, если сервер ответил. */
	status?: number;
	/** Строка итога: метод, адрес, код ответа. */
	summary: string;
	/** Пояснения: урезанная выборка и т.п. */
	notes: string[];
	/** Текст ошибки с подсказкой, что делать. */
	error?: string;
	/** Тело ответа: разобранный JSON или текст. */
	data?: unknown;
}

/** Минимальный контракт fetch, который нужен клиенту. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; statusText: string; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** Подсказка, когда публикация не отвечает или OData на ней не опубликован. */
export const PUBLICATION_HINT =
	'Для автономного сервера включите пункт «OData» в «Выбрать публикуемые сервисы» и запустите сервер (server_start) ' +
	'или перезапустите его (server_restart); для своей публикации передайте её адрес в параметре url ' +
	'и проверьте, что при публикации отмечен стандартный интерфейс OData.';

/**
 * Причина сетевой ошибки: у fetch она лежит в cause.
 *
 * @param error - Ошибка fetch
 */
function networkCause(error: unknown): string {
	const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
	if (cause?.code) {
		return cause.code;
	}
	if (cause?.message) {
		return cause.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Объявил ли сервер тело ответа.
 *
 * Автономный сервер 8.3.27 отвечает на неподдерживаемый метод кодом 405 без
 * длины и без chunked, оставляя соединение открытым: чтение такого тела ждёт
 * до таймаута. Тело ошибки без длины и без chunked не читается.
 *
 * @param headers - Заголовки ответа
 */
export function declaresBody(headers: { get(name: string): string | null }): boolean {
	const length = headers.get('content-length');
	if (length !== null) {
		return length.trim() !== '0';
	}
	return (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
}

/**
 * Разбирает тело успешного ответа.
 *
 * @param text - Тело ответа
 * @param contentType - Заголовок Content-Type
 */
function parseBody(text: string, contentType: string): unknown {
	const clean = text.replace(/^﻿/, '');
	const trimmed = clean.trim();
	if (trimmed === '') {
		return undefined;
	}
	if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return clean;
		}
	}
	return clean;
}

/**
 * Выполняет запрос к стандартному интерфейсу OData.
 *
 * Неудача объясняется словами, а не кодом: 401 - учётная запись профиля,
 * 404 на весь интерфейс - OData не опубликован, 400/404 на набор, которого нет
 * в `$metadata`, - объект не входит в состав интерфейса.
 *
 * @param call - Параметры вызова
 * @param fetchImpl - HTTP-вызов
 * @returns Исход вызова
 */
export async function callOData(call: ODataCall, fetchImpl: FetchLike): Promise<ODataOutcome> {
	// Выборка без top читалась бы сервером целиком, а агенту всё равно уходит начало:
	// читаются первые записи, общее число сервер считает сам
	const capped = call.method === 'GET' && !call.fullBody && readsWholeSet(call.resource, call.options);
	const options = capped ? { ...call.options, top: ODATA_DEFAULT_TOP, count: true } : call.options;
	const url = buildODataUrl(call.serviceRoot, call.resource, options);
	const fail = (error: string, status?: number, summary = `${call.method} ${url}`): ODataOutcome => ({
		success: false, url, status, summary, notes: [], error,
	});

	let body: string | undefined;
	if (call.method === 'POST' || call.method === 'PUT' || call.method === 'PATCH') {
		if (call.body === undefined || call.body === null || call.body === '') {
			return fail(`Для ${call.method} нужно тело запроса: параметр body с полями объекта в JSON.`);
		}
		try {
			body = serializeRequestBody(call.body);
		} catch (error) {
			return fail((error as Error).message);
		}
	}

	const isMetadata = entitySetOf(call.resource) === undefined && /\$metadata/.test(call.resource);
	const headers: Record<string, string> = {
		Accept: isMetadata ? 'application/xml' : 'application/json',
	};
	if (call.credentials && call.credentials.user !== '') {
		headers.Authorization = basicAuthorization(call.credentials.user, call.credentials.password);
	}
	if (body !== undefined) {
		headers['Content-Type'] = 'application/json;charset=utf-8';
	}

	const timeoutMs = call.timeoutMs ?? ODATA_TIMEOUT_MS;
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await fetchImpl(url, { method: call.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		const cause = networkCause(error);
		const reason = cause === 'TimeoutError' || /aborted|timeout/i.test(cause)
			? `нет ответа за ${Math.round(timeoutMs / 1000)} с`
			: cause;
		return fail(`Публикация по адресу ${call.serviceRoot} не отвечает: ${reason}. ${PUBLICATION_HINT}`);
	}

	const summary = `${call.method} ${url} → ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
	let text = '';
	try {
		// Успешный ответ читается всегда: без длины его тело идёт до закрытия соединения
		if (response.ok || declaresBody(response.headers)) {
			text = await response.text();
		}
	} catch (error) {
		// Заголовки пришли, а тело не дочитано: сервер держит соединение или оборвал его
		return fail(
			`Сервер ответил ${response.status}, но тело ответа не получено: ${networkCause(error)}. ` +
			'Проверьте результат повторным чтением.',
			response.status,
			summary
		);
	}
	if (response.ok) {
		const parsed = parseBody(text, response.headers.get('content-type') ?? '');
		if (call.fullBody) {
			return { success: true, url, status: response.status, summary, notes: [], data: parsed };
		}
		if (isMetadata && typeof parsed === 'string' && parsed.length > ODATA_PAYLOAD_LIMIT) {
			// Схема большой базы не помещается в ответ, а наборы в ней стоят в конце:
			// начало XML агенту ничего не даёт, список наборов - то, что ему нужно
			const entitySets = [...metadataEntitySets(parsed)];
			return {
				success: true, url, status: response.status, summary, data: { entitySets },
				notes: [
					`Схема длиннее ${ODATA_PAYLOAD_LIMIT} символов: показаны только наборы (${entitySets.length}). ` +
					'Поля набора видны в ответе на его запрос с top 1.',
				],
			};
		}
		// Общее число идёт в примечание: в данных оно строка и агенту не нужно
		const total = capped ? inlineCount(parsed) : undefined;
		const body = capped ? withoutInlineCount(parsed) : parsed;
		const read = capped ? readCount(body) : undefined;
		const limited = body === undefined ? { data: undefined } : limitPayload(body, ODATA_PAYLOAD_LIMIT);
		const shown = 'shown' in limited ? limited.shown : undefined;
		const notes: string[] = [];
		if (capped && read !== undefined) {
			const fits = shown ? `, в ответ поместились ${shown.returned}` : '';
			if (total !== undefined && total <= read && !shown) {
				notes.push(`Найдено записей: ${total}.`);
			} else {
				notes.push(
					`top не задан: прочитаны первые ${read}${total === undefined ? '' : ` из ${total}`}${fits}. ` +
					'Остальные - параметрами top и skip, поля - параметром select.'
				);
			}
		} else if (shown) {
			notes.push(
				`Показано записей: ${shown.returned} из ${shown.total}. ` +
				'Сузьте выборку параметрами top, select и filter.'
			);
		}
		if ('truncated' in limited && limited.truncated) {
			notes.push(`Ответ урезан до ${ODATA_PAYLOAD_LIMIT} символов.`);
		}
		return { success: true, url, status: response.status, summary, notes, data: limited.data };
	}

	const platformError = parseODataError(text);
	const details = platformError ?? text.replace(/^﻿/, '').trim().slice(0, 2000);
	const withDetails = (message: string) => (details ? `${message} Ответ сервера: ${details}` : message);

	if (response.status === 401) {
		const who = call.credentials && call.credentials.user !== ''
			? `пользователь «${call.credentials.user}» из профиля запуска не прошёл проверку`
			: 'в профиле запуска не заданы db-user и db-pwd';
		return fail(withDetails(
			`Нет доступа (401): ${who}. Проверьте учётную запись в файле настроек профиля (db-user, db-pwd) ` +
			'и право пользователя на стандартный интерфейс OData (обычно роль УдаленныйДоступOData).'
		), 401, summary);
	}
	if (response.status === 405 && call.method === 'PATCH') {
		// Автономный сервер 8.3.27 не принимает PATCH ни напрямую, ни туннелем X-HTTP-Method
		return patchViaPut(call, fetchImpl, summary);
	}
	if (response.status === 403) {
		return fail(withDetails(
			'Доступ запрещён (403): у пользователя нет права на этот объект или действие в стандартном интерфейсе OData.'
		), 403, summary);
	}

	const entitySet = entitySetOf(call.resource);
	if (response.status === 400 || response.status === 404) {
		const metadata = await readMetadata(call, fetchImpl, headers.Authorization);
		if (metadata.status === 404 || (metadata.status === undefined && response.status === 404 && entitySet === undefined)) {
			return fail(withDetails(`Стандартный интерфейс OData по адресу ${call.serviceRoot} не найден (404). ${PUBLICATION_HINT}`), response.status, summary);
		}
		if (entitySet?.startsWith('Enum_')) {
			return fail(
				`Перечисление ${entitySet} стандартный интерфейс OData набором не отдаёт: ` +
				'значения перечислений видны в реквизитах объектов, которые на них ссылаются.',
				response.status, summary
			);
		}
		if (entitySet !== undefined && metadata.xml !== undefined && !metadataHasEntitySet(metadata.xml, entitySet)) {
			return fail(
				`Набор ${entitySet} не входит в состав стандартного интерфейса OData этой базы. ` +
				`Включите объект инструментом odata_setup (include: ["${entitySet}"]) и повторите запрос. ` +
				'Имена наборов видны в $metadata.',
				response.status, summary
			);
		}
	}

	return fail(withDetails(`Сервер вернул ошибку ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`), response.status, summary);
}

/**
 * Общее число записей выборки из ответа с `$inlinecount=allpages`.
 *
 * @param data - Разобранный ответ
 */
function inlineCount(data: unknown): number | undefined {
	const value = (data as Record<string, unknown> | null)?.['odata.count'];
	const count = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
	return Number.isFinite(count) ? count : undefined;
}

/**
 * Ответ без служебного поля `odata.count`.
 *
 * @param data - Разобранный ответ
 */
function withoutInlineCount(data: unknown): unknown {
	if (data === null || typeof data !== 'object' || !('odata.count' in data)) {
		return data;
	}
	const rest = { ...(data as Record<string, unknown>) };
	delete rest['odata.count'];
	return rest;
}

/**
 * Сколько записей пришло в выборке.
 *
 * @param data - Разобранный ответ
 */
function readCount(data: unknown): number | undefined {
	const value = (data as Record<string, unknown> | null)?.value;
	return Array.isArray(value) ? value.length : undefined;
}

/**
 * Изменение элемента, когда сервер не принимает PATCH.
 *
 * PUT заменяет элемент целиком: поля, которых нет в теле, сбрасываются (на
 * автономном сервере 8.3.27 справочник получил новый код). Поэтому элемент
 * читается, на него накладываются переданные поля, и записывается он целиком.
 *
 * @param call - Исходный вызов PATCH
 * @param fetchImpl - HTTP-вызов
 * @param patchSummary - Итог отклонённого PATCH
 * @returns Исход записи методом PUT
 */
async function patchViaPut(call: ODataCall, fetchImpl: FetchLike, patchSummary: string): Promise<ODataOutcome> {
	const failed = (reason: string): ODataOutcome => ({
		success: false,
		url: buildODataUrl(call.serviceRoot, call.resource, call.options),
		status: 405,
		summary: patchSummary,
		notes: [],
		error: `Сервер не принимает PATCH (405), а заменить элемент целиком через PUT не удалось: ${reason}`,
	});

	let changes: unknown;
	try {
		changes = JSON.parse(serializeRequestBody(call.body));
	} catch (error) {
		return failed((error as Error).message);
	}
	if (!isPlainRecord(changes)) {
		return failed('тело запроса должно быть объектом с полями');
	}

	const read = await callOData({ ...call, method: 'GET', body: undefined, fullBody: true }, fetchImpl);
	if (!read.success) {
		return failed(`элемент не прочитан: ${read.error ?? read.summary}`);
	}
	if (!isPlainRecord(read.data)) {
		return failed('ответ на чтение элемента не объект: для PUT нужен ресурс одного элемента');
	}
	// Служебные поля ответа (odata.metadata, ссылки навигации) в запись не идут
	const current = Object.fromEntries(
		Object.entries(read.data).filter(([key]) => !key.startsWith('odata.') && !key.includes('@'))
	);

	const put = await callOData({ ...call, method: 'PUT', body: { ...current, ...changes } }, fetchImpl);
	return {
		...put,
		summary: `${patchSummary}\n${read.summary}\n${put.summary}`,
		notes: [
			'Сервер не принимает PATCH: элемент прочитан, изменены только переданные поля, записан целиком методом PUT.',
			...put.notes,
		],
	};
}

/**
 * Простой объект JSON.
 *
 * @param value - Значение
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Читает `$metadata`, чтобы понять причину 400/404.
 *
 * @param call - Исходный вызов
 * @param fetchImpl - HTTP-вызов
 * @param authorization - Заголовок авторизации исходного вызова
 * @returns Код ответа и схема, если её удалось прочитать
 */
async function readMetadata(
	call: ODataCall,
	fetchImpl: FetchLike,
	authorization: string | undefined
): Promise<{ status?: number; xml?: string }> {
	const headers: Record<string, string> = { Accept: 'application/xml' };
	if (authorization) {
		headers.Authorization = authorization;
	}
	try {
		const response = await fetchImpl(`${call.serviceRoot}$metadata`, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(call.timeoutMs ?? ODATA_TIMEOUT_MS),
		});
		const text = await response.text();
		return response.ok ? { status: response.status, xml: text } : { status: response.status };
	} catch {
		return {};
	}
}
