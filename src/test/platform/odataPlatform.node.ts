/**
 * Проверка OData на настоящей платформе (workflow platform-odata).
 *
 * База из fixtures/platform/odata/cf опубликована автономным сервером:
 * стандартный интерфейс OData и HTTP-сервис СоставOData с серверным кодом
 * служебной обработки. Проверяются клиент запросов расширения и изменение
 * состава интерфейса ровно тем кодом, который выполняет обработка.
 *
 * Без переменной ONEC_PUBLICATION_URL проверки пропускаются.
 * Запуск: ONEC_PUBLICATION_URL=http://127.0.0.1:8314/ib node --test-reporter=spec out/test/platform/odataPlatform.node.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { callOData, type ODataOutcome } from '../../features/odata/odataClient';
import { serviceRootFromUrl, type ODataMethod, type ODataQueryOptions } from '../../features/odata/odataRequest';
import {
	buildCompositionRequest,
	metadataComposition,
	metadataEntitySets,
	parseCompositionResponse,
	type CompositionResponse,
} from '../../features/odata/odataComposition';

const publication = process.env.ONEC_PUBLICATION_URL;
const CATALOG = 'Catalog_Товары';
const CATALOG_FULL_NAME = 'Справочник.Товары';
const ENUM = 'Enum_ВидыТоваров';
const ENUM_FULL_NAME = 'Перечисление.ВидыТоваров';

/** Запрос к OData через клиент расширения; исход пишется в журнал прогона. */
async function odata(
	method: ODataMethod,
	resource: string,
	extra: { options?: ODataQueryOptions; body?: unknown } = {}
): Promise<ODataOutcome> {
	const outcome = await callOData(
		{ serviceRoot: serviceRootFromUrl(publication ?? ''), method, resource, ...extra, timeoutMs: 30_000 },
		(url, init) => fetch(url, init)
	);
	console.log(`${outcome.summary}${outcome.error ? `\n  ошибка: ${outcome.error}` : ''}`);
	return outcome;
}

/** Запрос к серверному коду служебной обработки через HTTP-сервис. */
async function composition(include: string[], exclude: string[]): Promise<CompositionResponse> {
	const response = await fetch(`${publication?.replace(/\/+$/, '')}/hs/odata-composition/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(buildCompositionRequest(include, exclude)),
	});
	const text = await response.text();
	console.log(`состав: include=${include.join(',')} exclude=${exclude.join(',')} → ${response.status}\n  ${text.slice(0, 1000)}`);
	assert.equal(response.status, 200, `HTTP-сервис вернул ${response.status}: ${text}`);
	return parseCompositionResponse(text);
}

/**
 * Повторяет запрос, пока исход не станет ожидаемым: сервер может применять
 * новый состав не мгновенно.
 */
async function eventually(check: () => Promise<boolean>, attempts = 10): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await check()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
}

describe('OData на платформе', { skip: publication ? false : 'нет ONEC_PUBLICATION_URL' }, () => {
	test('$metadata отвечает', async () => {
		const outcome = await odata('GET', '$metadata');
		assert.equal(outcome.success, true, outcome.error ?? '');
		assert.match(String(outcome.data), /EntityContainer|edmx/i);
	});

	test('справочник вне состава: ошибка объясняет, что делать', async () => {
		await composition([], [CATALOG]);
		const outcome = await odata('GET', CATALOG);
		assert.equal(outcome.success, false);
		assert.match(outcome.error ?? '', /не входит в состав/);
		assert.match(outcome.error ?? '', /odata_setup/);
	});

	test('состав: чтение без изменений', async () => {
		const response = await composition([], []);
		assert.equal(response.success, true, response.error ?? '');
		assert.ok(!response.composition.includes(CATALOG_FULL_NAME));
	});

	test('неизвестное имя не меняет состав', async () => {
		const response = await composition(['Catalog_НетТакого'], []);
		assert.equal(response.success, false);
		assert.deepEqual(response.notFound, ['Catalog_НетТакого']);
		assert.deepEqual(response.added, []);
	});

	test('включение по имени набора OData и повторное включение', async () => {
		const first = await composition([CATALOG], []);
		assert.equal(first.success, true, first.error ?? '');
		assert.deepEqual(first.added, [CATALOG_FULL_NAME]);
		assert.ok(first.composition.includes(CATALOG_FULL_NAME));

		const second = await composition([CATALOG_FULL_NAME], []);
		assert.deepEqual(second.added, [], 'объект уже в составе');

		// Текущий состав команда читает из $metadata запущенного сервера
		const metadata = await odata('GET', '$metadata');
		assert.ok(metadataEntitySets(String(metadata.data)).has(CATALOG), `в $metadata нет набора ${CATALOG}`);
	});

	test('после включения справочник читается и пишется', async () => {
		const visible = await eventually(async () => (await odata('GET', CATALOG, { options: { top: 1 } })).success);
		assert.ok(visible, 'автономный сервер не видит новый состав без перезапуска');

		const created = await odata('POST', CATALOG, { body: { Description: 'Стол' } });
		assert.equal(created.success, true, created.error ?? '');
		const key = (created.data as { Ref_Key?: string }).Ref_Key;
		assert.ok(key, 'в ответе на POST нет Ref_Key');

		const found = await odata('GET', CATALOG, { options: { filter: "Description eq 'Стол'", select: 'Ref_Key,Description' } });
		assert.equal(found.success, true, found.error ?? '');
		assert.equal((found.data as { value: unknown[] }).value.length, 1);
		// Выборка без top идёт с $inlinecount=allpages: общее число считает сервер
		assert.deepEqual(found.notes, ['Найдено записей: 1.'], 'сервер не вернул odata.count');

		const element = `${CATALOG}(guid'${key}')`;
		const code = (created.data as { Code?: string }).Code;

		// PATCH меняет только переданное поле: сервер 8.3.27 его не принимает,
		// и клиент записывает элемент целиком через PUT
		const patched = await odata('PATCH', element, { body: { Description: 'Стул' } });
		assert.equal(patched.success, true, patched.error ?? '');
		const afterPatch = (await odata('GET', element)).data as { Description?: string; Code?: string };
		assert.equal(afterPatch.Description, 'Стул');
		assert.equal(afterPatch.Code, code, 'PATCH сбросил код элемента');

		// PUT заменяет элемент целиком: поля, которых нет в теле, сбрасываются
		const put = await odata('PUT', element, { body: { Description: 'Кресло' } });
		assert.equal(put.success, true, put.error ?? '');
		const afterPut = (await odata('GET', element)).data as { Description?: string; Code?: string };
		assert.equal(afterPut.Description, 'Кресло');
		console.log(`код после PUT одним полем: ${afterPut.Code} (был ${code})`);

		const deleted = await odata('DELETE', element);
		assert.equal(deleted.success, true, deleted.error ?? '');
	});

	test('перечисление: в $metadata только тип, набором не читается', async () => {
		const hasEnum = async () => metadataComposition(String((await odata('GET', '$metadata')).data)).has(ENUM);

		const included = await composition([ENUM], []);
		assert.equal(included.success, true, included.error ?? '');
		assert.ok(included.composition.includes(ENUM_FULL_NAME));
		assert.ok(await eventually(hasEnum), 'включённого перечисления нет в $metadata');

		const read = await odata('GET', ENUM);
		assert.equal(read.success, false);
		assert.match(read.error ?? '', /набором не отдаёт/);

		await composition([], [ENUM]);
		assert.ok(await eventually(async () => !(await hasEnum())), 'исключённое перечисление осталось в $metadata');
	});

	test('исключение возвращает справочник в состояние «вне состава»', async () => {
		const response = await composition([], [CATALOG]);
		assert.deepEqual(response.removed, [CATALOG_FULL_NAME]);
		const hidden = await eventually(async () => !(await odata('GET', CATALOG)).success);
		assert.ok(hidden, 'справочник остался доступен после исключения');
	});
});
