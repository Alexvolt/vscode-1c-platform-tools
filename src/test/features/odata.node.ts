/**
 * Стандартный интерфейс OData: адреса запросов, разбор ошибок, состав интерфейса.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildODataUrl,
	entitySetOf,
	limitPayload,
	metadataHasEntitySet,
	parseODataError,
	parseODataMethod,
	serviceRootFromUrl,
} from '../../features/odata/odataRequest';
import { callOData, declaresBody, type FetchLike } from '../../features/odata/odataClient';
import {
	buildCompositionRequest,
	compositionData,
	compositionObjects,
	compositionTarget,
	entitySetName,
	metadataComposition,
	metadataEntitySets,
	parseCompositionResponse,
	resolveTargets,
	processorSourceFiles,
	processorSourceHash,
	PROCESSOR_NAME,
} from '../../features/odata/odataComposition';

const ROOT = 'http://localhost:8314/ib/odata/standard.odata/';

/** Подделка fetch: ответы по адресу, вызовы запоминаются. */
function fakeFetch(
	responses: Record<string, { status: number; body: string; contentType?: string }>,
	calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
): FetchLike {
	return async (url, init) => {
		calls.push({ url, init });
		const key = Object.keys(responses).find((prefix) => url.startsWith(prefix));
		if (key === undefined) {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
		}
		const response = responses[key];
		return {
			status: response.status,
			statusText: '',
			ok: response.status >= 200 && response.status < 300,
			headers: {
				get: (name: string) => {
					const key = name.toLowerCase();
					if (key === 'content-type') {
						return response.contentType ?? 'application/json';
					}
					return key === 'content-length' ? String(Buffer.byteLength(response.body)) : null;
				},
			},
			text: async () => response.body,
		};
	};
}

describe('odataRequest: адрес публикации', () => {
	test('корень публикации дополняется путём интерфейса', () => {
		assert.equal(serviceRootFromUrl('http://localhost:8314/ib'), ROOT);
		assert.equal(serviceRootFromUrl('http://localhost:8314/ib/'), ROOT);
		assert.equal(serviceRootFromUrl('http://srv/base/odata/standard.odata'), 'http://srv/base/odata/standard.odata/');
	});

	test('адрес внутри интерфейса сводится к его корню, параметры и учётные данные отбрасываются', () => {
		assert.equal(serviceRootFromUrl('http://localhost:8314/ib/odata/standard.odata/$metadata?x=1#y'), ROOT);
		assert.equal(serviceRootFromUrl('http://user:pwd@srv/base/odata/standard.odata/Catalog_Товары'), 'http://srv/base/odata/standard.odata/');
	});

	test('не http-адрес отклоняется', () => {
		assert.throws(() => serviceRootFromUrl('ftp://srv/base'), /http/);
		assert.throws(() => serviceRootFromUrl('srv/base'), /Некорректный адрес/);
	});
});

describe('odataRequest: запрос', () => {
	test('метод: по умолчанию GET, регистр не важен, прочие отклоняются', () => {
		assert.equal(parseODataMethod(undefined), 'GET');
		assert.equal(parseODataMethod('patch'), 'PATCH');
		assert.equal(parseODataMethod('put'), 'PUT');
		assert.equal(parseODataMethod('MERGE'), undefined);
	});

	test('выборка: параметры кодируются, ответ в JSON', () => {
		const url = buildODataUrl(ROOT, 'Catalog_Номенклатура', {
			filter: "Description eq 'Стол'",
			select: 'Ref_Key,Description',
			top: 5,
		});
		assert.equal(
			url,
			`${ROOT}Catalog_%D0%9D%D0%BE%D0%BC%D0%B5%D0%BD%D0%BA%D0%BB%D0%B0%D1%82%D1%83%D1%80%D0%B0` +
				"?$filter=Description%20eq%20'%D0%A1%D1%82%D0%BE%D0%BB'&$select=Ref_Key%2CDescription&$top=5&$format=json"
		);
	});

	test('параметры из ресурса сохраняются, явные перекрывают их', () => {
		const url = buildODataUrl(ROOT, "Catalog_X(guid'1')?$top=1&$format=atom", { top: 3 });
		assert.equal(url, `${ROOT}Catalog_X(guid'1')?$top=3&$format=atom`);
	});

	test('уже закодированный ресурс не кодируется повторно', () => {
		assert.equal(buildODataUrl(ROOT, 'Catalog_%D0%A5'), `${ROOT}Catalog_%D0%A5?$format=json`);
	});

	test('$metadata запрашивается без $format', () => {
		assert.equal(buildODataUrl(ROOT, '/$metadata'), `${ROOT}$metadata`);
	});

	test('набор сущностей берётся из начала ресурса', () => {
		assert.equal(entitySetOf("Catalog_Товары(guid'1')/Товары?$top=1"), 'Catalog_Товары');
		assert.equal(entitySetOf('Document_Заказ'), 'Document_Заказ');
		assert.equal(entitySetOf('$metadata'), undefined);
	});
});

describe('odataRequest: ответ', () => {
	test('ошибка платформы из JSON и XML', () => {
		assert.equal(
			parseODataError('﻿{"odata.error":{"code":"9","message":{"lang":"ru","value":"Неправильный тип"}}}'),
			'Неправильный тип (код 9)'
		);
		assert.equal(
			parseODataError('<m:error xmlns:m="x"><m:code>14</m:code><m:message xml:lang="ru">Не найден &quot;X&quot;</m:message></m:error>'),
			'Не найден "X"'
		);
		assert.equal(parseODataError('<html>404</html>'), undefined);
	});

	test('набор ищется в $metadata по точному имени', () => {
		const xml = '<EntityContainer><EntitySet Name="Catalog_Товары" EntityType="x"/></EntityContainer>';
		assert.equal(metadataHasEntitySet(xml, 'Catalog_Товары'), true);
		assert.equal(metadataHasEntitySet(xml, 'Catalog_Товар'), false);
	});

	test('большая выборка урезается по записям, а не по символам', () => {
		const value = Array.from({ length: 100 }, (_, index) => ({ index, text: 'x'.repeat(50) }));
		const limited = limitPayload({ 'odata.metadata': 'm', value }, 2_000);
		const data = limited.data as { value: unknown[] };
		assert.ok(data.value.length > 0 && data.value.length < 100);
		assert.deepEqual(limited.shown, { returned: data.value.length, total: 100 });
		assert.ok(JSON.stringify(data).length <= 2_000);
	});

	test('небольшой ответ не меняется', () => {
		assert.deepEqual(limitPayload({ value: [1] }, 100), { data: { value: [1] } });
	});
});

describe('odataClient', () => {
	test('успешная выборка: тело, код и учётная запись в заголовке', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X', credentials: { user: 'Админ', password: '1' } },
			fakeFetch({ [`${ROOT}Catalog_X`]: { status: 200, body: '﻿{"value":[{"Description":"А"}]}' } }, calls)
		);
		assert.equal(outcome.success, true);
		assert.equal(outcome.status, 200);
		assert.deepEqual(outcome.data, { value: [{ Description: 'А' }] });
		assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('Админ:1', 'utf8').toString('base64')}`);
	});

	test('выборка без top: первые записи и общее число', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X', options: { select: 'Ref_Key' } },
			fakeFetch({ [ROOT]: { status: 200, body: '{"odata.count":"1298","value":[{"Ref_Key":"1"},{"Ref_Key":"2"}]}' } }, calls)
		);
		assert.match(calls[0].url, /\$top=100&\$inlinecount=allpages/);
		assert.match(outcome.notes.join(' '), /прочитаны первые 2 из 1298\./);
		assert.equal((outcome.data as Record<string, unknown>)['odata.count'], undefined);
	});

	test('выборка без top поместилась целиком: только число записей', async () => {
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X', options: { filter: 'DeletionMark eq true' } },
			fakeFetch({ [ROOT]: { status: 200, body: '{"odata.count":"0","value":[]}' } })
		);
		assert.deepEqual(outcome.notes, ['Найдено записей: 0.']);
	});

	test('выборка без top не поместилась в ответ: обе пометки', async () => {
		const row = { Description: 'x'.repeat(1000) };
		const body = JSON.stringify({ 'odata.count': '1298', value: Array.from({ length: 100 }, () => row) });
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X' },
			fakeFetch({ [ROOT]: { status: 200, body } })
		);
		assert.match(outcome.notes.join(' '), /прочитаны первые 100 из 1298, в ответ поместились \d+\./);
	});

	test('top задан или прочитан элемент: выборка не ограничивается', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		const fetchImpl = fakeFetch({ [ROOT]: { status: 200, body: '{"value":[]}' } }, calls);
		await callOData({ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X', options: { top: 5000 } }, fetchImpl);
		await callOData({ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X?$top=7' }, fetchImpl);
		await callOData({ serviceRoot: ROOT, method: 'GET', resource: "Catalog_X(guid'1')" }, fetchImpl);
		await callOData({ serviceRoot: ROOT, method: 'GET', resource: '$metadata' }, fetchImpl);
		for (const call of calls) {
			assert.doesNotMatch(call.url, /inlinecount/);
		}
		assert.match(calls[0].url, /\$top=5000/);
	});

	test('POST без тела не отправляется', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		const outcome = await callOData({ serviceRoot: ROOT, method: 'POST', resource: 'Catalog_X' }, fakeFetch({}, calls));
		assert.equal(outcome.success, false);
		assert.match(outcome.error ?? '', /body/);
		assert.equal(calls.length, 0);
	});

	test('PATCH отправляет JSON-тело', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		await callOData(
			{ serviceRoot: ROOT, method: 'PATCH', resource: "Catalog_X(guid'1')", body: { Description: 'Б' } },
			fakeFetch({ [ROOT]: { status: 200, body: '{}' } }, calls)
		);
		assert.equal(calls[0].init.method, 'PATCH');
		assert.equal(calls[0].init.body, '{"Description":"Б"}');
		assert.match(calls[0].init.headers['Content-Type'], /application\/json/);
	});

	test('401 объясняется учётной записью профиля', async () => {
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X' },
			fakeFetch({ [ROOT]: { status: 401, body: '' } })
		);
		assert.equal(outcome.success, false);
		assert.match(outcome.error ?? '', /db-user/);
	});

	test('перечисление набором не читается: объяснение вместо совета включить', async () => {
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Enum_ВидыТоваров' },
			fakeFetch({
				[`${ROOT}$metadata`]: { status: 200, body: '<EnumType Name="ВидыТоваров"/>', contentType: 'application/xml' },
				[ROOT]: { status: 404, body: '' },
			})
		);
		assert.equal(outcome.success, false);
		assert.match(outcome.error ?? '', /набором не отдаёт/);
		assert.doesNotMatch(outcome.error ?? '', /include/);
	});

	test('объект вне состава: подсказка про odata_setup', async () => {
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_Нет' },
			fakeFetch({
				[`${ROOT}$metadata`]: { status: 200, body: '<EntitySet Name="Catalog_Есть"/>', contentType: 'application/xml' },
				[`${ROOT}Catalog_`]: { status: 400, body: '{"odata.error":{"code":"14","message":{"value":"Не найден ресурс"}}}' },
			})
		);
		assert.equal(outcome.success, false);
		assert.match(outcome.error ?? '', /Catalog_Нет не входит в состав/);
		assert.match(outcome.error ?? '', /odata_setup/);
	});

	test('интерфейс не опубликован: подсказка про публикацию', async () => {
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X' },
			fakeFetch({ [ROOT]: { status: 404, body: 'Not found', contentType: 'text/plain' } })
		);
		assert.match(outcome.error ?? '', /не найден \(404\)/);
		assert.match(outcome.error ?? '', /server_start/);
	});

	test('тело ответа не дочитано: понятная ошибка вместо исключения', async () => {
		const hanging: FetchLike = async () => ({
			status: 200,
			statusText: 'OK',
			ok: true,
			headers: { get: (name: string) => (name.toLowerCase() === 'transfer-encoding' ? 'chunked' : 'application/json') },
			text: async () => {
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			},
		});
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'PATCH', resource: "Catalog_X(guid'1')", body: { Description: 'Б' } },
			hanging
		);
		assert.equal(outcome.success, false);
		assert.equal(outcome.status, 200);
		assert.match(outcome.error ?? '', /тело ответа не получено/);
	});

	test('ответ без длины и без chunked не читается: 405 приходит сразу', async () => {
		let bodyRead = false;
		const noBody: FetchLike = async () => ({
			status: 405,
			statusText: 'Method Not Allowed',
			ok: false,
			headers: { get: () => null },
			text: async () => {
				bodyRead = true;
				return new Promise<string>(() => undefined);
			},
		});
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'PATCH', resource: "Catalog_X(guid'1')", body: { Description: 'Б' } },
			noBody
		);
		assert.equal(bodyRead, false);
		assert.equal(outcome.status, 405);
		assert.match(outcome.error ?? '', /405/);
	});

	test('405 на PATCH: элемент читается и записывается целиком через PUT с изменёнными полями', async () => {
		const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
		const element = { 'odata.metadata': 'm', Ref_Key: '1', Code: '000000001', Description: 'А' };
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push({ url, init });
			const reply = (status: number, body: string) => ({
				status,
				statusText: '',
				ok: status < 300,
				headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(body.length) : null) },
				text: async () => body,
			});
			if (init.method === 'PATCH') {
				return reply(405, '');
			}
			if (init.method === 'GET') {
				return reply(200, JSON.stringify(element));
			}
			return reply(200, init.body ?? '');
		};
		const outcome = await callOData(
			{ serviceRoot: ROOT, method: 'PATCH', resource: "Catalog_X(guid'1')", body: { Description: 'Б' } },
			fetchImpl
		);
		assert.equal(outcome.success, true, outcome.error ?? '');
		assert.deepEqual(calls.map((call) => call.init.method), ['PATCH', 'GET', 'PUT']);
		assert.deepEqual(JSON.parse(calls[2].init.body ?? ''), { Ref_Key: '1', Code: '000000001', Description: 'Б' });
		assert.match(outcome.notes.join(' '), /PUT/);
	});

	test('PUT требует тело запроса', async () => {
		const outcome = await callOData({ serviceRoot: ROOT, method: 'PUT', resource: "Catalog_X(guid'1')" }, fakeFetch({}));
		assert.match(outcome.error ?? '', /Для PUT нужно тело/);
	});

	test('большая $metadata: агенту - список наборов вместо обрезанного XML', async () => {
		// У 1С сначала идут все EntityType, наборы - в конце схемы
		const types = '<EntityType Name="T"><Property Name="P" Type="Edm.String"/></EntityType>'.repeat(2_000);
		const xml = `<edmx><Schema>${types}<EntityContainer><EntitySet Name="Catalog__ДемоНоменклатура" EntityType="a"/></EntityContainer></Schema></edmx>`;
		assert.ok(xml.length > 60_000);
		const fetchImpl = fakeFetch({ [ROOT]: { status: 200, body: xml, contentType: 'application/xml' } });

		const forAgent = await callOData({ serviceRoot: ROOT, method: 'GET', resource: '$metadata' }, fetchImpl);
		assert.deepEqual(forAgent.data, { entitySets: ['Catalog__ДемоНоменклатура'] });
		assert.match(forAgent.notes.join(' '), /только наборы \(1\)/);

		// Внутреннее чтение состава получает схему целиком
		const full = await callOData({ serviceRoot: ROOT, method: 'GET', resource: '$metadata', fullBody: true }, fetchImpl);
		assert.ok(metadataEntitySets(String(full.data)).has('Catalog__ДемоНоменклатура'));
	});

	test('наличие тела ответа по заголовкам', () => {
		const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });
		assert.equal(declaresBody(headers({ 'content-length': '10' })), true);
		assert.equal(declaresBody(headers({ 'content-length': '0' })), false);
		assert.equal(declaresBody(headers({ 'transfer-encoding': 'chunked' })), true);
		assert.equal(declaresBody(headers({})), false);
	});

	test('сервер не отвечает: подсказка про запуск сервера или url', async () => {
		const outcome = await callOData({ serviceRoot: ROOT, method: 'GET', resource: 'Catalog_X' }, fakeFetch({}));
		assert.match(outcome.error ?? '', /не отвечает: ECONNREFUSED/);
		assert.match(outcome.error ?? '', /url/);
	});
});

describe('odataComposition', () => {
	test('полное имя: кандидаты в обоих вариантах языка', () => {
		assert.deepEqual(compositionTarget('Справочник.Номенклатура').candidates, ['Справочник.Номенклатура', 'Catalog.Номенклатура']);
		assert.deepEqual(compositionTarget('catalog.Номенклатура.ТабличнаяЧасть.Товары').candidates, [
			'Справочник.Номенклатура',
			'Catalog.Номенклатура',
		]);
	});

	test('имя набора OData: сначала длинное имя, затем укорочения справа', () => {
		assert.deepEqual(compositionTarget('AccumulationRegister_Остатки_RecordType').candidates, [
			'РегистрНакопления.Остатки_RecordType',
			'AccumulationRegister.Остатки_RecordType',
			'РегистрНакопления.Остатки',
			'AccumulationRegister.Остатки',
		]);
	});

	test('имя без вида уходит как есть', () => {
		assert.deepEqual(compositionTarget('Номенклатура').candidates, ['Номенклатура']);
	});

	test('имя набора по полному имени', () => {
		assert.equal(entitySetName('Справочник.Номенклатура'), 'Catalog_Номенклатура');
		assert.equal(entitySetName('InformationRegister.Цены'), 'InformationRegister_Цены');
		assert.equal(entitySetName('ОбщийМодуль.X'), undefined);
	});

	test('запрос: пустые имена отбрасываются', () => {
		const request = buildCompositionRequest(['Catalog_X', ' '], []);
		assert.equal(request.include.length, 1);
		assert.equal(request.exclude.length, 0);
	});

	test('объекты проекта из дерева md-sparrow: только виды интерфейса, без заимствованных', () => {
		const tree = {
			projectRoot: '/p',
			mainSchemaVersion: '2.20',
			mainSchemaVersionFlag: '',
			sources: [
				{
					kind: 'main', id: 'm', label: 'Конфигурация', configurationXmlRelativePath: '', metadataRootRelativePath: '',
					groups: [
						{ id: 'c', label: 'Справочники', iconHint: '', items: [{ objectType: 'Catalog', name: 'Товары', relativePath: '' }] },
						{ id: 'm', label: 'Общие модули', iconHint: '', items: [{ objectType: 'CommonModule', name: 'Общий', relativePath: '' }] },
						{
							id: 'r', label: 'Регистры', iconHint: '', items: [],
							subgroups: [{ items: [{ objectType: 'InformationRegister', name: 'Цены', relativePath: '' }] }],
						},
					],
				},
				{
					kind: 'extension', id: 'e', label: 'Расширение', configurationXmlRelativePath: '', metadataRootRelativePath: '',
					groups: [{
						id: 'c', label: 'Справочники', iconHint: '',
						items: [
							{ objectType: 'Catalog', name: 'Товары', relativePath: '', objectBelonging: 'Adopted' },
							{ objectType: 'Catalog', name: 'Расш_Склады', relativePath: '' },
						],
					}],
				},
				{ kind: 'processor', id: 'x', label: 'Обработка', configurationXmlRelativePath: '', metadataRootRelativePath: '', groups: [] },
			],
		} as unknown as Parameters<typeof compositionObjects>[0];
		assert.deepEqual(compositionObjects(tree), [
			{ name: 'РегистрСведений.Цены', entitySet: 'InformationRegister_Цены' },
			{ name: 'Справочник.Расш_Склады', entitySet: 'Catalog_Расш_Склады' },
			{ name: 'Справочник.Товары', entitySet: 'Catalog_Товары' },
		]);
	});

	test('ответ о составе: имена наборов, available без состава', () => {
		const objects = [
			{ name: 'Справочник.А', entitySet: 'Catalog_А' },
			{ name: 'Справочник.Б', entitySet: 'Catalog_Б' },
		];
		const { data, notes } = compositionData(['Catalog_А'], objects);
		assert.deepEqual(data, { composition: ['Catalog_А'], available: ['Catalog_Б'] });
		assert.match(notes.join(' '), /вне состава: 1/);
	});

	test('ответ о составе не выходит за предел и режется целыми именами', () => {
		const composition = Array.from({ length: 700 }, (_, index) => `InformationRegister_ДлинноеИмяРегистра${index}`);
		const objects = Array.from({ length: 2_000 }, (_, index) => ({
			name: `Справочник.Объект${index}`,
			entitySet: `Catalog_ДлинноеИмяСправочника${index}`,
		}));
		const { data, notes } = compositionData(composition, objects, 50_000);
		const json = JSON.stringify(data);
		assert.ok(json.length <= 50_000, `длина ${json.length}`);
		assert.equal(data.composition.length, 700);
		assert.ok(data.available && data.available.length > 0 && data.available.length < 2_000);
		assert.ok(data.available.every((name) => name.startsWith('Catalog_ДлинноеИмяСправочника')));
		assert.match(notes.join(' '), /не целиком/);
	});

	test('имена из запроса сопоставляются с объектами проекта в обоих вариантах', () => {
		const objects = [{ name: 'Справочник._ДемоНоменклатура', entitySet: 'Catalog__ДемоНоменклатура' }];
		const { found, notFound } = resolveTargets(
			['Catalog__ДемоНоменклатура', 'Справочник._ДемоНоменклатура', 'Catalog._ДемоНоменклатура', 'Catalog_НетТакого'],
			objects
		);
		assert.equal(found.size, 3);
		assert.deepEqual(notFound, ['Catalog_НетТакого']);
	});

	test('наборы из $metadata', () => {
		const xml = '<EntitySet Name="Catalog_Товары" EntityType="a"/><EntitySet Name="Catalog_Товары_Состав" EntityType="b"/>';
		assert.deepEqual([...metadataEntitySets(xml)], ['Catalog_Товары', 'Catalog_Товары_Состав']);
	});

	test('состав из $metadata учитывает перечисления', () => {
		const xml = '<EnumType Name="ВидыТоваров" UnderlyingType="Edm.Int32"><Member Name="Товар"/></EnumType>' +
			'<EntitySet Name="Catalog_Товары" EntityType="a"/>';
		assert.deepEqual([...metadataComposition(xml)].sort(), ['Catalog_Товары', 'Enum_ВидыТоваров']);
	});

	test('ответ обработки с BOM', () => {
		const response = parseCompositionResponse(
			'﻿{"success":true,"notFound":[],"added":["Справочник.X"],"removed":[],"composition":["Справочник.X"]}'
		);
		assert.equal(response.success, true);
		assert.deepEqual(response.added, ['Справочник.X']);
		assert.equal(response.error, undefined);
	});

	test('исходники обработки: корневой файл, форма и модуль формы', () => {
		const files = processorSourceFiles();
		assert.ok(files[`${PROCESSOR_NAME}.xml`].includes(`<Name>${PROCESSOR_NAME}</Name>`));
		assert.ok(files[`${PROCESSOR_NAME}/Forms/Форма/Ext/Form.xml`].includes('<Event name="OnOpen">ПриОткрытии</Event>'));
		const module = files[`${PROCESSOR_NAME}/Forms/Форма/Ext/Form/Module.bsl`];
		assert.ok(module.includes('УстановитьСоставСтандартногоИнтерфейсаOData(Объекты)'));
		assert.ok(module.includes('Прав(Каталог, 1) <> "\\"'));
		assert.match(processorSourceHash(), /^[0-9a-f]{64}$/);
	});
});
