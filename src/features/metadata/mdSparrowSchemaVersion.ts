/**
 * Флаг `-v` для md-sparrow из атрибута `version` корневого `MetaDataObject` в `Configuration.xml`.
 * @module mdSparrowSchemaVersion
 */

import * as vscode from 'vscode';
import { formatOfFile } from '../../shared/objectPaths';

/** Первые байты файла достаточно для тега MetaDataObject с version. */

const CONFIG_XML_HEAD_BYTES = 65536;

/** Флаг схемы для проекта EDT: пустой, md-sparrow версию выгрузки у него не спрашивает. */
export const EDT_SCHEMA_FLAG = '';

/**
 * Форматы выгрузки, которые пишет md-sparrow, от нового к старому, и линейка платформы,
 * которая пишет каждый из них: как в `SchemaVersion` md-sparrow.
 */
export const DUMP_FORMATS: readonly { readonly version: string; readonly platform: string }[] = [
	{ version: '2.21', platform: '8.5.1' },
	{ version: '2.20', platform: '8.3.27' },
	{ version: '2.19', platform: '8.3.26' },
	{ version: '2.18', platform: '8.3.25' },
	{ version: '2.17', platform: '8.3.24' },
	{ version: '2.16', platform: '8.3.23' },
	{ version: '2.15', platform: '8.3.22' },
	{ version: '2.14', platform: '8.3.21' },
	{ version: '2.13', platform: '8.3.20' },
	{ version: '2.12', platform: '8.3.19' },
	{ version: '2.11', platform: '8.3.18' },
	{ version: '2.10', platform: '8.3.17' },
];

/**
 * Спрашивает версию формата новой конфигурации.
 *
 * @param title - Заголовок выбора
 * @returns Флаг md-sparrow, например `V2_21`; undefined, если выбор отменён
 */
export async function pickDumpFormat(title: string): Promise<string | undefined> {
	const pick = await vscode.window.showQuickPick(
		DUMP_FORMATS.map((format) => ({ label: format.version, description: `платформа ${format.platform}` })),
		{ title }
	);
	return pick && designerXmlVersionToMdSparrowFlag(pick.label);
}

/** Без префикса или с префиксом (например после сторонней сериализации). */
const META_DATA_OBJECT_VERSION_RE = /<(?:[\w.-]+:)?MetaDataObject\b[^>]*\bversion\s*=\s*"([^"]+)"/;

/**
 * Преобразует значение атрибута {@code version} у {@code MetaDataObject} в имя enum md-sparrow (флаг {@code -v}).
 * Согласовано с {@link io.github.yellowhammer.designerxml.SchemaVersion#metadataObjectVersionAttribute} в Java.
 *
 * @example "2.20" → "V2_20", "2.21" → "V2_21"
 */
export function designerXmlVersionToMdSparrowFlag(versionAttr: string): string {
	const v = versionAttr.trim();
	if (!/^\d+(?:\.\d+)*$/.test(v)) {
		throw new Error(`Некорректное значение version у MetaDataObject: "${versionAttr}"`);
	}
	return `V${v.replaceAll('.', '_')}`;
}

/**
 * Читает атрибут version у корневого MetaDataObject из Configuration.xml (без полного парсинга XML).
 */
export async function readConfigurationXmlMetaDataVersion(configurationXmlPath: string): Promise<string> {
	const fs = await import('node:fs/promises');
	const fh = await fs.open(configurationXmlPath, 'r');
	try {
		const buf = Buffer.alloc(CONFIG_XML_HEAD_BYTES);
		const { bytesRead } = await fh.read(buf, 0, CONFIG_XML_HEAD_BYTES, 0);
		const head = buf.subarray(0, bytesRead).toString('utf8');
		const m = head.match(META_DATA_OBJECT_VERSION_RE);
		if (!m) {
			throw new Error(
				'В начале Configuration.xml не найден атрибут version у элемента MetaDataObject'
			);
		}
		return m[1].trim();
	} finally {
		await fh.close();
	}
}

/**
 * Значение для передачи в md-sparrow как {@code -v &lt;flag&gt;}.
 */
export async function mdSparrowSchemaFlagFromConfigurationXml(
	configurationXmlPath: string
): Promise<string> {
	// Версия схемы описывает выгрузку конфигуратора; у проекта EDT её место
	// занимает метамодель, которую md-sparrow берёт из своей сборки
	if (formatOfFile(configurationXmlPath) === 'edt') {
		return EDT_SCHEMA_FLAG;
	}
	const ver = await readConfigurationXmlMetaDataVersion(configurationXmlPath);
	return designerXmlVersionToMdSparrowFlag(ver);
}
