/**
 * Извлечение публикуемых сервисов (HTTP- и Web-) из дерева метаданных md-sparrow.
 *
 * Дерево даёт имена сервисов и путь к описанию каждого; корневой URL HTTP-сервиса
 * читается свойствами объекта, когда сервис выбран для публикации.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureMdSparrowRuntime } from '../metadata/mdSparrowBootstrap';
import { runMdSparrowParamsRead } from '../metadata/mdSparrowParams';
import { mdSparrowSchemaFlagFromConfigurationXml } from '../metadata/mdSparrowSchemaVersion';
import { logger } from '../../shared/logger';
import type { ProjectMetadataTreeDto, MetadataItemDto, MetadataSourceDto } from '../../features/metadata/metadataTreeService';

const log = logger.scope('server');

/** objectType HTTP-сервиса в дереве метаданных. */
const HTTP_SERVICE_TYPE = 'HTTPService';
/** objectType Web-сервиса в дереве метаданных. */
const WEB_SERVICE_TYPE = 'WebService';

/** Сервис проекта и место его описания: пути от корня проекта. */
export interface PublishableService {
	/** Имя объекта метаданных. */
	readonly name: string;
	/** XML объекта. */
	readonly objectXml: string;
	/** Каталог метаданных источника: рабочий каталог чтения свойств. */
	readonly metadataRoot: string;
	/** Configuration.xml источника: по нему известна версия выгрузки. */
	readonly configurationXml: string;
}

/** Публикуемые сервисы по категориям. */
export interface PublishableServices {
	/** Web-сервисы (SOAP). */
	web: PublishableService[];
	/** HTTP-сервисы. */
	http: PublishableService[];
}

/**
 * Собирает HTTP- и Web-сервисы из дерева метаданных.
 *
 * Обходит все источники, группы, подгруппы и их элементы; сервисы сортируются по
 * имени и дедуплицируются (на случай нескольких источников — основная конфигурация
 * и расширения).
 *
 * @param tree - Дерево метаданных проекта (md-sparrow)
 * @returns Сервисы по категориям
 */
export function extractPublishableServices(tree: ProjectMetadataTreeDto): PublishableServices {
	const web = new Map<string, PublishableService>();
	const http = new Map<string, PublishableService>();

	const visitItems = (source: MetadataSourceDto, items: readonly MetadataItemDto[] | undefined): void => {
		if (!items) {
			return;
		}
		for (const item of items) {
			const target = item.objectType === WEB_SERVICE_TYPE ? web : item.objectType === HTTP_SERVICE_TYPE ? http : undefined;
			if (!target || target.has(item.name)) {
				continue;
			}
			target.set(item.name, {
				name: item.name,
				objectXml: item.relativePath,
				metadataRoot: source.metadataRootRelativePath,
				configurationXml: source.configurationXmlRelativePath,
			});
		}
	};

	for (const source of tree.sources ?? []) {
		for (const group of source.groups ?? []) {
			visitItems(source, group.items);
			for (const subgroup of group.subgroups ?? []) {
				visitItems(source, subgroup.items);
			}
		}
	}

	const sorted = (services: Map<string, PublishableService>): PublishableService[] =>
		[...services.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	return { web: sorted(web), http: sorted(http) };
}

/**
 * Читает корневые URL HTTP-сервисов: клиент ходит на `/hs/<корневой URL>`, и
 * именно его ждёт ibsrv в конфиге публикации.
 *
 * @param context - Контекст расширения (нужен md-sparrow)
 * @param projectRoot - Корень проекта
 * @param services - Сервисы, чьи свойства читаются
 * @returns Корневые URL по именам сервисов; сервис без прочитанного URL в карту не попадает
 */
export async function readHttpServiceRoots(
	context: vscode.ExtensionContext,
	projectRoot: string,
	services: readonly PublishableService[]
): Promise<Map<string, string>> {
	const roots = new Map<string, string>();
	if (services.length === 0) {
		return roots;
	}
	const runtime = await ensureMdSparrowRuntime(context, projectRoot);
	const schemas = new Map<string, string>();
	for (const service of services) {
		try {
			let schema = schemas.get(service.configurationXml);
			if (schema === undefined) {
				schema = await mdSparrowSchemaFlagFromConfigurationXml(path.join(projectRoot, service.configurationXml));
				schemas.set(service.configurationXml, schema);
			}
			const res = await runMdSparrowParamsRead(
				runtime,
				{ op: 'cf-md-object-get', objectXml: path.join(projectRoot, service.objectXml), schemaVersion: schema },
				{ cwd: path.join(projectRoot, service.metadataRoot) }
			);
			if (res.exitCode !== 0) {
				log.warn(`Корневой URL сервиса ${service.name} не прочитан: ${res.stderr.trim() || `код ${res.exitCode}`}`);
				continue;
			}
			const root = httpServiceRoot(res.stdout);
			if (root) {
				roots.set(service.name, root);
			}
		} catch (error) {
			log.warn(`Корневой URL сервиса ${service.name} не прочитан: ${(error as Error).message}`);
		}
	}
	return roots;
}

/**
 * Корневой URL из ответа md-sparrow о свойствах объекта.
 *
 * @param json - Ответ `cf-md-object-get`
 * @returns Корневой URL или undefined, если его нет
 */
export function httpServiceRoot(json: string): string | undefined {
	let dto: unknown;
	try {
		dto = JSON.parse(json.trim());
	} catch {
		return undefined;
	}
	const scalars = (dto as { scalars?: Record<string, unknown> } | null)?.scalars;
	const value = scalars?.RootURL;
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
