/**
 * Состав стандартного интерфейса OData: имена объектов и служебная обработка.
 *
 * Состав хранится в информационной базе, а не в публикации, и меняется только
 * кодом на сервере 1С (`УстановитьСоставСтандартногоИнтерфейсаOData`). Поэтому
 * расширение собирает маленькую внешнюю обработку из исходников ниже и
 * запускает её в Предприятии: обработка читает запрос из файла, меняет состав
 * и пишет ответ в соседний файл.
 */

import { createHash } from 'node:crypto';
import type { ProjectMetadataTreeDto } from '../metadata/metadataTreeService';

/** Вид объекта метаданных: имя в русском и английском вариантах встроенного языка. */
interface MetadataKind {
	ru: string;
	en: string;
}

/** Виды объектов, которые входят в стандартный интерфейс OData. */
const METADATA_KINDS: readonly MetadataKind[] = [
	{ ru: 'Константа', en: 'Constant' },
	{ ru: 'Справочник', en: 'Catalog' },
	{ ru: 'Документ', en: 'Document' },
	{ ru: 'ЖурналДокументов', en: 'DocumentJournal' },
	{ ru: 'Перечисление', en: 'Enum' },
	{ ru: 'ПланВидовХарактеристик', en: 'ChartOfCharacteristicTypes' },
	{ ru: 'ПланСчетов', en: 'ChartOfAccounts' },
	{ ru: 'ПланВидовРасчета', en: 'ChartOfCalculationTypes' },
	{ ru: 'РегистрСведений', en: 'InformationRegister' },
	{ ru: 'РегистрНакопления', en: 'AccumulationRegister' },
	{ ru: 'РегистрБухгалтерии', en: 'AccountingRegister' },
	{ ru: 'РегистрРасчета', en: 'CalculationRegister' },
	{ ru: 'БизнесПроцесс', en: 'BusinessProcess' },
	{ ru: 'Задача', en: 'Task' },
	{ ru: 'ПланОбмена', en: 'ExchangePlan' },
];

/**
 * Вид объекта по имени в любом варианте языка, без учёта регистра.
 *
 * @param name - `Справочник`, `Catalog`, `catalog`
 */
function kindByName(name: string): MetadataKind | undefined {
	const lower = name.toLowerCase();
	return METADATA_KINDS.find((kind) => kind.ru.toLowerCase() === lower || kind.en.toLowerCase() === lower);
}

/** Объект, который просят включить или выключить. */
export interface CompositionTarget {
	/** Имя, как его передали: для сообщения «не найден». */
	name: string;
	/** Полные имена для `Метаданные.НайтиПоПолномуИмени`: первое найденное побеждает. */
	candidates: string[];
}

/**
 * Полные имена объекта метаданных по имени из запроса.
 *
 * Принимаются полное имя (`Справочник.Номенклатура`, `Catalog.Номенклатура`) и
 * имя набора OData (`Catalog_Номенклатура`, `Catalog_Номенклатура_Товары`).
 * В имени набора табличная часть или вид записей идут через `_`, как и
 * подчёркивания в имени самого объекта, поэтому кандидатами идут все
 * укорочения справа: длинное имя проверяется первым.
 *
 * @param name - Имя объекта из запроса
 * @returns Кандидаты полного имени
 */
export function compositionTarget(name: string): CompositionTarget {
	const trimmed = name.trim();
	const dot = trimmed.indexOf('.');
	if (dot > 0) {
		const kind = kindByName(trimmed.slice(0, dot));
		const objectName = trimmed.slice(dot + 1).split('.')[0];
		if (kind && objectName) {
			return { name: trimmed, candidates: [`${kind.ru}.${objectName}`, `${kind.en}.${objectName}`] };
		}
		return { name: trimmed, candidates: [trimmed] };
	}
	const underscore = trimmed.indexOf('_');
	if (underscore > 0) {
		const kind = kindByName(trimmed.slice(0, underscore));
		const rest = trimmed.slice(underscore + 1);
		if (kind && rest) {
			const candidates: string[] = [];
			const parts = rest.split('_');
			for (let count = parts.length; count > 0; count--) {
				const objectName = parts.slice(0, count).join('_');
				if (objectName !== '') {
					candidates.push(`${kind.ru}.${objectName}`, `${kind.en}.${objectName}`);
				}
			}
			return { name: trimmed, candidates };
		}
	}
	return { name: trimmed, candidates: [trimmed] };
}

/**
 * Имя набора OData для полного имени объекта.
 *
 * @param fullName - `Справочник.Номенклатура` или `Catalog.Номенклатура`
 * @returns `Catalog_Номенклатура` или undefined для вида вне интерфейса
 */
export function entitySetName(fullName: string): string | undefined {
	const dot = fullName.indexOf('.');
	if (dot <= 0) {
		return undefined;
	}
	const kind = kindByName(fullName.slice(0, dot));
	return kind ? `${kind.en}_${fullName.slice(dot + 1)}` : undefined;
}

/** Запрос к служебной обработке. */
export interface CompositionRequest {
	/** Включить в состав. */
	include: CompositionTarget[];
	/** Исключить из состава. */
	exclude: CompositionTarget[];
}

/**
 * Собирает запрос к обработке из списков имён.
 *
 * @param include - Имена объектов для включения
 * @param exclude - Имена объектов для исключения
 */
export function buildCompositionRequest(include: readonly string[], exclude: readonly string[]): CompositionRequest {
	const targets = (names: readonly string[]) =>
		names.map((name) => name.trim()).filter((name) => name !== '').map(compositionTarget);
	return { include: targets(include), exclude: targets(exclude) };
}

/** Объект, который может входить в состав интерфейса. */
export interface CompositionObject {
	/** Полное имя: Справочник.Номенклатура. */
	name: string;
	/** Имя набора OData: Catalog_Номенклатура. */
	entitySet: string;
}

/**
 * Объекты проекта, которые можно включить в состав интерфейса, по дереву метаданных md-sparrow.
 *
 * Берутся основная конфигурация и собственные объекты расширений: заимствованный
 * объект расширения - это объект конфигурации, он уже в списке.
 *
 * @param tree - Дерево метаданных проекта
 * @returns Объекты по полному имени, без повторов
 */
export function compositionObjects(tree: ProjectMetadataTreeDto): CompositionObject[] {
	const found = new Map<string, CompositionObject>();
	for (const source of tree.sources ?? []) {
		if (source.kind !== 'main' && source.kind !== 'extension') {
			continue;
		}
		const items = (source.groups ?? []).flatMap((group) => [
			...(group.items ?? []),
			...(group.subgroups ?? []).flatMap((subgroup) => subgroup.items ?? []),
		]);
		for (const item of items) {
			const kind = kindByName(item.objectType);
			if (!kind || item.objectBelonging === 'Adopted') {
				continue;
			}
			const name = `${kind.ru}.${item.name}`;
			if (!found.has(name)) {
				found.set(name, { name, entitySet: `${kind.en}_${item.name}` });
			}
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Сопоставляет имена из запроса с объектами проекта.
 *
 * @param names - Имена: полные (Справочник.Номенклатура) или наборы OData (Catalog_Номенклатура)
 * @param objects - Объекты проекта
 * @returns Найденные объекты по имени из запроса и имена, которых в проекте нет
 */
export function resolveTargets(
	names: readonly string[],
	objects: readonly CompositionObject[]
): { found: Map<string, CompositionObject>; notFound: string[] } {
	const byFullName = new Map<string, CompositionObject>();
	for (const object of objects) {
		byFullName.set(object.name, object);
		const underscore = object.entitySet.indexOf('_');
		byFullName.set(`${object.entitySet.slice(0, underscore)}.${object.entitySet.slice(underscore + 1)}`, object);
	}
	const found = new Map<string, CompositionObject>();
	const notFound: string[] = [];
	for (const name of names) {
		const object = compositionTarget(name).candidates.map((candidate) => byFullName.get(candidate)).find(Boolean);
		if (object) {
			found.set(name, object);
		} else {
			notFound.push(name);
		}
	}
	return { found, notFound };
}

/** Предел данных ответа о составе, символов: у MCP свой предел 100 000 с обрезкой хвоста. */
export const COMPOSITION_DATA_LIMIT = 80_000;

/** Данные ответа о составе и пояснения к ним. */
export interface CompositionData {
	data: { composition: string[]; available?: string[] };
	notes: string[];
}

/**
 * Данные ответа о составе: имена наборов OData, по которым к объектам обращаются.
 *
 * Состав и доступные объекты большой конфигурации не помещаются в ответ агенту,
 * если описывать каждый объект парой «полное имя и набор»: имя набора короче и
 * так же подходит для include, exclude и запросов. В available идут только
 * объекты вне состава, а не влезающий хвост отрезается целыми именами с пометкой.
 *
 * @param composition - Наборы текущего состава
 * @param objects - Объекты проекта, когда нужен список доступных
 * @param limit - Предел длины данных, символов
 */
export function compositionData(
	composition: readonly string[],
	objects: readonly CompositionObject[] | undefined,
	limit: number = COMPOSITION_DATA_LIMIT
): CompositionData {
	const notes: string[] = [];
	const fit = (names: readonly string[], budget: number): string[] => {
		const kept: string[] = [];
		let size = 2;
		for (const name of names) {
			size += JSON.stringify(name).length + 1;
			if (size > budget) {
				break;
			}
			kept.push(name);
		}
		return kept;
	};

	const sortedComposition = [...composition].sort((a, b) => a.localeCompare(b, 'ru'));
	const shownComposition = fit(sortedComposition, limit);
	if (shownComposition.length < sortedComposition.length) {
		notes.push(`Состав показан не целиком: ${shownComposition.length} из ${sortedComposition.length} наборов.`);
	}
	const data: CompositionData['data'] = { composition: shownComposition };

	if (objects) {
		const included = new Set(composition);
		const available = objects.map((object) => object.entitySet).filter((set) => !included.has(set));
		// Бюджет - остаток после состава и ключа available; скобки массива fit учитывает сам
		const budget = limit - JSON.stringify({ ...data, available: [] }).length + 2;
		const shown = fit(available, budget);
		data.available = shown;
		notes.push(
			shown.length < available.length
				? `Объекты вне состава показаны не целиком: ${shown.length} из ${available.length}. Имя для include можно задать и без списка: Справочник.Имя или Catalog_Имя.`
				: `Объектов вне состава: ${available.length}.`
		);
	}
	return { data, notes };
}

/**
 * Наборы сущностей из схемы `$metadata`: по ним виден текущий состав интерфейса.
 *
 * @param metadataXml - Схема стандартного интерфейса
 * @returns Имена наборов
 */
export function metadataEntitySets(metadataXml: string): Set<string> {
	return new Set([...metadataXml.matchAll(/<EntitySet\s+Name="([^"]+)"/g)].map((match) => match[1]));
}

/**
 * Состав интерфейса по схеме `$metadata`: наборы сущностей и перечисления.
 *
 * Перечисление набором не публикуется: в схеме оно видно только как
 * `<EnumType Name="ВидыТоваров">`, без префикса. Здесь оно получает имя
 * `Enum_ВидыТоваров`, как в остальных местах расширения.
 *
 * @param metadataXml - Схема стандартного интерфейса
 * @returns Имена наборов и перечислений с префиксом `Enum_`
 */
export function metadataComposition(metadataXml: string): Set<string> {
	const names = metadataEntitySets(metadataXml);
	for (const match of metadataXml.matchAll(/<EnumType\s+Name="([^"]+)"/g)) {
		names.add(`Enum_${match[1]}`);
	}
	return names;
}

/** Ответ служебной обработки. */
export interface CompositionResponse {
	success: boolean;
	/** Ошибка платформы: нет прав, метод недоступен и т.п. */
	error?: string;
	/** Состав после выполнения: полные имена объектов. */
	composition: string[];
	/** Что включено этим вызовом. */
	added: string[];
	/** Что исключено этим вызовом. */
	removed: string[];
	/** Имена из запроса, которых нет в метаданных. */
	notFound: string[];
}

/**
 * Разбирает ответ обработки.
 *
 * @param text - Содержимое response.json (платформа пишет его с BOM)
 * @returns Ответ
 * @throws {Error} Если файл не JSON
 */
export function parseCompositionResponse(text: string): CompositionResponse {
	const json = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	return {
		success: json.success === true,
		error: typeof json.error === 'string' && json.error !== '' ? json.error : undefined,
		composition: strings(json.composition),
		added: strings(json.added),
		removed: strings(json.removed),
		notFound: strings(json.notFound),
	};
}

/** Имя служебной обработки: оно же имя каталога исходников и собранного файла. */
export const PROCESSOR_NAME = 'ODataComposition';

/** Файл запроса в рабочем каталоге. */
export const REQUEST_FILE = 'request.json';

/** Файл ответа в рабочем каталоге. */
export const RESPONSE_FILE = 'response.json';

const XML_NAMESPACES =
	'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
	'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' +
	'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
	'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' +
	'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' +
	'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' +
	'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" ' +
	'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
	'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

const FORM_NAMESPACES =
	'xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
	'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" ' +
	'xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" ' +
	'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
	'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' +
	'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' +
	'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' +
	'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
	'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

/** Версия формата выгрузки: 8.3.17 и новее. */
const FORMAT_VERSION = '2.10';

const PROCESSOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject ${XML_NAMESPACES} version="${FORMAT_VERSION}">
	<ExternalDataProcessor uuid="cf585cfa-e5dc-4fcb-a897-0de020330d61">
		<InternalInfo>
			<xr:ContainedObject>
				<xr:ClassId>c3831ec8-d8d5-4f93-8a22-f9bfae07327f</xr:ClassId>
				<xr:ObjectId>34f51292-2d46-4756-914f-475b034bcd5b</xr:ObjectId>
			</xr:ContainedObject>
			<xr:GeneratedType name="ExternalDataProcessorObject.${PROCESSOR_NAME}" category="Object">
				<xr:TypeId>a8da0842-090c-4a15-9048-bdb2493d1ca9</xr:TypeId>
				<xr:ValueId>146bed0a-9de3-46e7-9382-5ebdbadc0b5f</xr:ValueId>
			</xr:GeneratedType>
		</InternalInfo>
		<Properties>
			<Name>${PROCESSOR_NAME}</Name>
			<Synonym>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>Состав стандартного интерфейса OData (1C: Platform Tools)</v8:content>
				</v8:item>
			</Synonym>
			<Comment/>
			<DefaultForm>ExternalDataProcessor.${PROCESSOR_NAME}.Form.Форма</DefaultForm>
			<AuxiliaryForm/>
		</Properties>
		<ChildObjects>
			<Form>Форма</Form>
		</ChildObjects>
	</ExternalDataProcessor>
</MetaDataObject>
`;

const FORM_METADATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject ${XML_NAMESPACES} version="${FORMAT_VERSION}">
	<Form uuid="9f2dac1c-02a0-4915-8d48-952ddf712229">
		<Properties>
			<Name>Форма</Name>
			<Synonym/>
			<Comment/>
			<FormType>Managed</FormType>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<UsePurposes>
				<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>
			</UsePurposes>
		</Properties>
	</Form>
</MetaDataObject>
`;

const FORM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Form ${FORM_NAMESPACES} version="${FORMAT_VERSION}">
	<AutoCommandBar name="ФормаКоманднаяПанель" id="-1"/>
	<Events>
		<Event name="OnOpen">ПриОткрытии</Event>
	</Events>
	<Attributes>
		<Attribute name="Объект" id="1">
			<Type>
				<v8:Type>cfg:ExternalDataProcessorObject.${PROCESSOR_NAME}</v8:Type>
			</Type>
			<MainAttribute>true</MainAttribute>
		</Attribute>
	</Attributes>
</Form>
`;

const FORM_MODULE = `// Служебная обработка 1C: Platform Tools: читает и меняет состав стандартного
// интерфейса OData. Параметр запуска /C - каталог с файлом ${REQUEST_FILE},
// ответ пишется в ${RESPONSE_FILE} того же каталога, после чего сеанс завершается.
// Файлы читаются на клиенте: у серверной базы сервер 1С их не увидит.

&НаКлиенте
Процедура ПриОткрытии(Отказ)

	Каталог = СокрЛП(СтрЗаменить(ПараметрЗапуска, """", ""));
	Если ПустаяСтрока(Каталог) Тогда
		Возврат;
	КонецЕсли;
	Если Прав(Каталог, 1) <> "/" И Прав(Каталог, 1) <> "\\" Тогда
		Каталог = Каталог + ПолучитьРазделительПути();
	КонецЕсли;

	Попытка
		Чтение = Новый ЧтениеТекста(Каталог + "${REQUEST_FILE}", КодировкаТекста.UTF8);
		ТекстЗапроса = Чтение.Прочитать();
		Чтение.Закрыть();
		ТекстОтвета = ВыполнитьЗапрос(ТекстЗапроса);
	Исключение
		ТекстОтвета = ОтветСОшибкой(ПодробноеПредставлениеОшибки(ИнформацияОбОшибке()));
	КонецПопытки;

	Попытка
		Запись = Новый ЗаписьТекста(Каталог + "${RESPONSE_FILE}", КодировкаТекста.UTF8);
		Запись.Записать(ТекстОтвета);
		Запись.Закрыть();
	Исключение
		// Без файла ответа расширение сообщит, что обработка результата не вернула
	КонецПопытки;

	ПодключитьОбработчикОжидания("ЗавершитьСеанс", 0.1, Истина);

КонецПроцедуры

&НаКлиенте
Процедура ЗавершитьСеанс()

	ЗавершитьРаботуСистемы(Ложь);

КонецПроцедуры

&НаКлиенте
Функция ОтветСОшибкой(ТекстОшибки)

	Ответ = Новый Структура("success,error", Ложь, ТекстОшибки);
	Запись = Новый ЗаписьJSON;
	Запись.УстановитьСтроку();
	ЗаписатьJSON(Запись, Ответ);
	Возврат Запись.Закрыть();

КонецФункции

&НаСервереБезКонтекста
Функция ВыполнитьЗапрос(ТекстЗапроса)

	Чтение = Новый ЧтениеJSON;
	Чтение.УстановитьСтроку(ТекстЗапроса);
	Запрос = ПрочитатьJSON(Чтение);
	Чтение.Закрыть();

	НеНайдены = Новый Массив;
	Включить = НайтиОбъекты(ЗначениеСвойства(Запрос, "include"), НеНайдены);
	Исключить = НайтиОбъекты(ЗначениеСвойства(Запрос, "exclude"), НеНайдены);

	Добавлены = Новый Массив;
	Удалены = Новый Массив;

	Если НеНайдены.Количество() = 0 И (Включить.Количество() > 0 Или Исключить.Количество() > 0) Тогда

		// Точечное изменение: остальной состав переносится как есть
		Состав = Новый Соответствие;
		Для Каждого Объект Из ПолучитьСоставСтандартногоИнтерфейсаOData() Цикл
			Состав.Вставить(Объект.ПолноеИмя(), Объект);
		КонецЦикла;

		Для Каждого Объект Из Включить Цикл
			Имя = Объект.ПолноеИмя();
			Если Состав.Получить(Имя) = Неопределено Тогда
				Состав.Вставить(Имя, Объект);
				Добавлены.Добавить(Имя);
			КонецЕсли;
		КонецЦикла;

		Для Каждого Объект Из Исключить Цикл
			Имя = Объект.ПолноеИмя();
			Если Состав.Получить(Имя) <> Неопределено Тогда
				Состав.Удалить(Имя);
				Удалены.Добавить(Имя);
			КонецЕсли;
		КонецЦикла;

		Если Добавлены.Количество() > 0 Или Удалены.Количество() > 0 Тогда
			Объекты = Новый Массив;
			Для Каждого Элемент Из Состав Цикл
				Объекты.Добавить(Элемент.Значение);
			КонецЦикла;
			УстановитьСоставСтандартногоИнтерфейсаOData(Объекты);
		КонецЕсли;

	КонецЕсли;

	Ответ = Новый Структура;
	Ответ.Вставить("success", НеНайдены.Количество() = 0);
	Ответ.Вставить("notFound", НеНайдены);
	Ответ.Вставить("added", Добавлены);
	Ответ.Вставить("removed", Удалены);
	Ответ.Вставить("composition", ПолныеИмена(ПолучитьСоставСтандартногоИнтерфейсаOData()));

	Запись = Новый ЗаписьJSON;
	Запись.УстановитьСтроку();
	ЗаписатьJSON(Запись, Ответ);
	Возврат Запись.Закрыть();

КонецФункции

&НаСервереБезКонтекста
Функция НайтиОбъекты(Элементы, НеНайдены)

	Объекты = Новый Массив;
	Если ТипЗнч(Элементы) <> Тип("Массив") Тогда
		Возврат Объекты;
	КонецЕсли;

	Для Каждого Элемент Из Элементы Цикл
		Объект = Неопределено;
		Кандидаты = ЗначениеСвойства(Элемент, "candidates");
		Если ТипЗнч(Кандидаты) = Тип("Массив") Тогда
			Для Каждого Кандидат Из Кандидаты Цикл
				Попытка
					Объект = Метаданные.НайтиПоПолномуИмени(Кандидат);
				Исключение
					Объект = Неопределено;
				КонецПопытки;
				Если Объект <> Неопределено Тогда
					Прервать;
				КонецЕсли;
			КонецЦикла;
		КонецЕсли;
		Если Объект = Неопределено Тогда
			НеНайдены.Добавить(Строка(ЗначениеСвойства(Элемент, "name")));
		Иначе
			Объекты.Добавить(Объект);
		КонецЕсли;
	КонецЦикла;

	Возврат Объекты;

КонецФункции

&НаСервереБезКонтекста
Функция ЗначениеСвойства(Значение, Ключ)

	Результат = Неопределено;
	Если ТипЗнч(Значение) = Тип("Структура") Тогда
		Значение.Свойство(Ключ, Результат);
	КонецЕсли;
	Возврат Результат;

КонецФункции

&НаСервереБезКонтекста
Функция ПолныеИмена(Объекты)

	Имена = Новый Массив;
	Для Каждого Объект Из Объекты Цикл
		Имена.Добавить(Объект.ПолноеИмя());
	КонецЦикла;
	Возврат Имена;

КонецФункции
`;

/**
 * Исходники служебной обработки в формате выгрузки конфигуратора.
 *
 * @returns Пути файлов относительно каталога исходников и их содержимое
 */
export function processorSourceFiles(): Record<string, string> {
	return {
		[`${PROCESSOR_NAME}.xml`]: PROCESSOR_XML,
		[`${PROCESSOR_NAME}/Forms/Форма.xml`]: FORM_METADATA_XML,
		[`${PROCESSOR_NAME}/Forms/Форма/Ext/Form.xml`]: FORM_XML,
		[`${PROCESSOR_NAME}/Forms/Форма/Ext/Form/Module.bsl`]: FORM_MODULE,
	};
}

/**
 * Отпечаток исходников: по нему решается, пересобирать ли обработку.
 *
 * @returns Хеш SHA-256 исходников
 */
export function processorSourceHash(): string {
	const hash = createHash('sha256');
	for (const [file, content] of Object.entries(processorSourceFiles())) {
		hash.update(file).update('\0').update(content).update('\0');
	}
	return hash.digest('hex');
}
