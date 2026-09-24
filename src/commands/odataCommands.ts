/**
 * Команды стандартного интерфейса OData: запросы к данным и состав интерфейса.
 *
 * Запрос идёт в публикацию автономного сервера проекта либо в свою публикацию
 * по адресу из параметра url, учётная запись берётся из профиля запуска.
 * Состав интерфейса меняет служебная обработка в Предприятии: он хранится в
 * информационной базе, а не в публикации.
 *
 * @module odataCommands
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { BaseCommand, INFOBASE_BUSY } from './baseCommand';
import { isAgentOptions } from '../shared/agentGate';
import { logger } from '../shared/logger';
import { currentRoot } from '../shared/workspaceProjects';
import { resolveODataEndpoint } from '../shared/odataEndpoint';
import { resolveConfigPath } from '../features/testing/projectTestConfig';
import { callOData, type ODataOutcome } from '../features/odata/odataClient';
import { parseODataMethod, serviceRootFromUrl, ODATA_METHODS, type ODataQueryOptions } from '../features/odata/odataRequest';
import {
	buildCompositionRequest,
	compositionData,
	compositionObjects,
	entitySetName,
	metadataComposition,
	resolveTargets,
	parseCompositionResponse,
	processorSourceFiles,
	processorSourceHash,
	PROCESSOR_NAME,
	REQUEST_FILE,
	RESPONSE_FILE,
	type CompositionObject,
	type CompositionRequest,
	type CompositionResponse,
} from '../features/odata/odataComposition';
import { loadProjectMetadataTree } from '../features/metadata/metadataTreeService';
import type { VRunnerIntent } from '../shared/vrunnerCli';
import type { CommandExecutionOptions, StructuredCommandResult } from '../shared/commandExecutionTypes';

const log = logger.scope('odata');

/** Идентификатор команды запроса к OData. */
export const ODATA_QUERY_COMMAND = '1c-platform-tools.odata.query';

/** Идентификатор команды состава интерфейса OData. */
export const ODATA_SETUP_COMMAND = '1c-platform-tools.odata.setup';

/** Каталог служебной обработки и файлов обмена с ней внутри каталога сборки. */
const WORK_DIR = 'odata';

/**
 * Строка из параметра вызова.
 *
 * @param value - Значение параметра
 */
function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Неотрицательное целое из параметра вызова.
 *
 * @param value - Значение параметра
 */
function optionalCount(value: unknown): number | undefined {
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Список имён из параметра вызова: массив или строка через запятую.
 *
 * @param value - Значение параметра
 */
function nameList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
	}
	if (typeof value === 'string') {
		return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
	}
	return [];
}

/**
 * Результат вызова OData в формате ответа команды.
 *
 * @param outcome - Исход вызова
 */
function outcomeToResult(outcome: ODataOutcome): StructuredCommandResult {
	return {
		success: outcome.success,
		exitCode: outcome.success ? 0 : 1,
		stdout: [outcome.summary, ...outcome.notes].join('\n'),
		stderr: outcome.error ?? '',
		data: outcome.data,
	};
}

/** Подготовленный запуск служебной обработки. */
interface CompositionRun {
	/** Команды vanessa-runner: сборка при необходимости и запуск Предприятия. */
	steps: string[][];
	/** Возврат базы автономному серверу после запуска. */
	restore?: () => Promise<void>;
	/** Замечания планирования (временные параметры профиля). */
	notices: string[];
	epfPath: string;
	hashPath: string;
	hash: string;
	responsePath: string;
}

/**
 * Текст ошибки про имена, которых нет в метаданных.
 *
 * @param names - Имена из запроса
 */
function notFoundMessage(names: readonly string[]): string {
	return (
		`Нет в метаданных: ${names.join(', ')}. Состав не менялся. ` +
		'Имя задаётся полностью (Справочник.Номенклатура) или как набор OData (Catalog_Номенклатура); ' +
		'объекты вне состава вернёт вызов с available: true.'
	);
}

/**
 * Входит ли объект проекта в состав, полученный от обработки.
 *
 * Обработка возвращает полные имена в варианте языка конфигурации, поэтому
 * сравнение идёт по имени набора OData.
 *
 * @param composition - Полные имена из ответа обработки
 * @param object - Объект проекта
 */
function containsObject(composition: readonly string[], object: CompositionObject): boolean {
	return composition.some((name) => entitySetName(name) === object.entitySet);
}

/**
 * Команды стандартного интерфейса OData.
 */
export class ODataCommands extends BaseCommand {

	/**
	 * @param context - Контекст расширения: нужен для чтения метаданных md-sparrow
	 */
	constructor(private readonly context: vscode.ExtensionContext) {
		super();
	}

	/**
	 * Запрос к стандартному интерфейсу OData.
	 *
	 * Агенту возвращается код HTTP, тело ответа и понятная ошибка; пользователь
	 * из палитры вводит ресурс и получает ответ в редакторе (только чтение).
	 *
	 * @param opts - Параметры вызова: method, resource, url, параметры выборки, body
	 * @returns Результат запроса; из палитры ничего не возвращает
	 */
	async query(opts?: CommandExecutionOptions): Promise<StructuredCommandResult | void> {
		if (!isAgentOptions(opts)) {
			return this.queryInteractive();
		}
		const resource = optionalString(opts?.resource);
		if (!resource) {
			return this.executionError(
				'Укажите resource: набор (Catalog_Номенклатура), элемент (Catalog_Номенклатура(guid\'…\')) или $metadata.'
			);
		}
		const method = parseODataMethod(opts?.method);
		if (!method) {
			return this.executionError(`Метод ${String(opts?.method)} не поддерживается: ${ODATA_METHODS.join(', ')}.`);
		}
		const options: ODataQueryOptions = {
			filter: optionalString(opts?.filter),
			select: optionalString(opts?.select),
			expand: optionalString(opts?.expand),
			orderby: optionalString(opts?.orderby),
			top: optionalCount(opts?.top),
			skip: optionalCount(opts?.skip),
		};
		return this.runQuery({ method, resource, options, body: opts?.body, url: optionalString(opts?.url), settingsFile: opts?.settingsFile });
	}

	/**
	 * Выполняет запрос: адрес из url или автономного сервера, учётная запись из профиля.
	 */
	private async runQuery(request: {
		method: NonNullable<ReturnType<typeof parseODataMethod>>;
		resource: string;
		options?: ODataQueryOptions;
		body?: unknown;
		url?: string;
		settingsFile?: string;
	}): Promise<StructuredCommandResult> {
		let serviceRoot: string;
		if (request.url) {
			try {
				serviceRoot = serviceRootFromUrl(request.url);
			} catch (error) {
				return this.executionError((error as Error).message);
			}
		} else {
			const endpoint = resolveODataEndpoint(currentRoot());
			if ('problem' in endpoint) {
				return this.executionError(endpoint.problem);
			}
			serviceRoot = endpoint.serviceRoot;
		}

		const credentials = await this.vrunner.getIbCredentials(optionalString(request.settingsFile));
		log.info(`${request.method} ${serviceRoot}${request.resource}${credentials.user ? `, пользователь ${credentials.user}` : ''}`);
		const outcome = await callOData(
			{ serviceRoot, method: request.method, resource: request.resource, options: request.options, body: request.body, credentials },
			(url, init) => fetch(url, init)
		);
		if (!outcome.success) {
			log.warn(outcome.error ?? outcome.summary);
		}
		return outcomeToResult(outcome);
	}

	/**
	 * Запрос из палитры: чтение ресурса и показ ответа в редакторе.
	 */
	private async queryInteractive(): Promise<void> {
		const resource = await vscode.window.showInputBox({
			title: 'Запрос к OData',
			prompt: 'Ресурс относительно odata/standard.odata/: набор, элемент или $metadata. Выполняется GET.',
			placeHolder: 'Catalog_Номенклатура?$top=10',
			value: '$metadata',
			ignoreFocusOut: true,
		});
		if (!resource?.trim()) {
			return;
		}
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Запрос к OData…' },
			() => this.runQuery({ method: 'GET', resource: resource.trim() })
		);
		if (!result.success) {
			void vscode.window.showErrorMessage(result.stderr);
			return;
		}
		const content = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, null, 2);
		const language = typeof result.data === 'string' && result.data.trimStart().startsWith('<') ? 'xml' : 'json';
		const document = await vscode.workspace.openTextDocument({ content, language });
		await vscode.window.showTextDocument(document, { preview: false });
	}

	/**
	 * Показывает или меняет состав стандартного интерфейса OData базы профиля.
	 *
	 * Без include и exclude возвращается текущий состав: из `$metadata` запущенного
	 * автономного сервера, иначе служебной обработкой. Перечисленные объекты
	 * включаются и исключаются точечно, остальной состав не меняется.
	 *
	 * @param opts - Параметры вызова: include, exclude, available, settingsFile, ibConnection
	 * @returns Состав после вызова; из палитры ничего не возвращает
	 */
	async setup(opts?: CommandExecutionOptions): Promise<StructuredCommandResult | void> {
		if (!isAgentOptions(opts)) {
			return this.setupInteractive();
		}
		const include = nameList(opts?.include);
		const exclude = nameList(opts?.exclude);
		const root = this.getExecutionCwd(opts);
		const objects = opts?.available === true && root ? await this.projectObjects(root) : undefined;

		if (include.length === 0 && exclude.length === 0 && root && !('problem' in resolveODataEndpoint(root))) {
			const fromServer = await this.compositionFromServer(root, objects ?? (await this.projectObjects(root)));
			if (fromServer) {
				return this.readResult(fromServer, objects, 'Состав прочитан из $metadata автономного сервера.');
			}
		}

		// Неизвестные имена и изменения, которые уже в силе, видны без запуска Предприятия
		if ((include.length > 0 || exclude.length > 0) && root) {
			const known = objects ?? (await this.projectObjects(root));
			const early = known ? await this.checkWithoutRun(root, include, exclude, known, objects) : undefined;
			if (early) {
				return early;
			}
		}

		const run = await this.prepareComposition(buildCompositionRequest(include, exclude), { ...opts, wait: true });
		if ('failure' in run) {
			return this.executionError(run.failure);
		}
		const vrunnerResult = await this.runVRunnerSequential(
			run.steps, { ...opts, wait: true }, 'Состав OData', ODATA_SETUP_COMMAND, true, run.restore
		);
		const outcome = await this.finishComposition(run, vrunnerResult?.success ?? false);
		if ('error' in outcome) {
			return {
				success: false,
				exitCode: vrunnerResult && vrunnerResult.exitCode !== 0 ? vrunnerResult.exitCode : 1,
				stdout: vrunnerResult?.stdout ?? '',
				stderr: [outcome.error, vrunnerResult?.stderr].filter(Boolean).join('\n'),
			};
		}
		const changes = include.length > 0 || exclude.length > 0;
		const notices = changes ? run.notices : ['Состав прочитан служебной обработкой в Предприятии.', ...run.notices];
		return this.compositionResult(outcome.response, changes, notices, objects);
	}

	/**
	 * Ответ без запуска Предприятия: имени нет в проекте или состав уже такой, как просят.
	 *
	 * Запуск обработки стоит полминуты и остановки сервера, а оба случая видны
	 * по метаданным проекта и `$metadata` запущенного сервера.
	 *
	 * @returns Готовый ответ либо undefined, если без обработки не обойтись
	 */
	private async checkWithoutRun(
		root: string,
		include: readonly string[],
		exclude: readonly string[],
		known: readonly CompositionObject[],
		objects: readonly CompositionObject[] | undefined
	): Promise<StructuredCommandResult | undefined> {
		const targets = resolveTargets([...include, ...exclude], known);
		if (targets.notFound.length > 0) {
			return {
				success: false,
				exitCode: 1,
				stdout: 'Проверено по метаданным проекта, Предприятие не запускалось.',
				stderr: notFoundMessage(targets.notFound),
				data: { notFound: targets.notFound },
			};
		}
		if ('problem' in resolveODataEndpoint(root)) {
			return undefined;
		}
		const current = await this.compositionFromServer(root, known);
		if (!current) {
			return undefined;
		}
		const sets = new Set(current.map((object) => object.entitySet));
		const pick = (names: readonly string[]) => names.map((name) => targets.found.get(name)).filter((object): object is CompositionObject => object !== undefined);
		const includeObjects = pick(include);
		const excludeObjects = pick(exclude);
		const pending = includeObjects.some((object) => !sets.has(object.entitySet)) || excludeObjects.some((object) => sets.has(object.entitySet));
		if (pending) {
			return undefined;
		}
		const { data, notes } = compositionData([...sets], objects);
		return {
			success: true,
			exitCode: 0,
			stdout: [
				`Состав стандартного интерфейса OData: объектов ${current.length}.`,
				'Состав не менялся: объекты уже были в нужном состоянии.',
				'Проверено по $metadata автономного сервера, Предприятие не запускалось.',
				...notes,
			].join('\n'),
			stderr: '',
			data: { ...data, added: [], removed: [] },
		};
	}

	/**
	 * Состав из палитры и меню сервера: отметки по объектам проекта, запись задачей VS Code.
	 *
	 * Объекты берутся из метаданных проекта (md-sparrow). Текущий состав читается
	 * из `$metadata` запущенного сервера, а без него - служебной обработкой той же
	 * задачей, после которой открывается выбор.
	 */
	private async setupInteractive(): Promise<void> {
		const root = this.ensureWorkspace();
		if (!root) {
			return;
		}
		const objects = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Чтение объектов из метаданных…' },
			() => this.projectObjects(root)
		);
		if (!objects || objects.length === 0) {
			void vscode.window.showErrorMessage(
				'В метаданных проекта нет объектов, которые входят в стандартный интерфейс OData, или метаданные не прочитаны.'
			);
			return;
		}

		const fromServer = await this.compositionFromServer(root, objects);
		if (fromServer) {
			await this.pickAndWrite(objects, new Set(fromServer.map((object) => object.name)));
			return;
		}

		// Сервер не отдаёт состав: читаем его обработкой, выбор откроется по завершении задачи
		await this.runCompositionTask(buildCompositionRequest([], []), (response) => {
			const current = new Set(objects.filter((object) => containsObject(response.composition, object)).map((object) => object.name));
			void this.pickAndWrite(objects, current);
			return undefined;
		});
	}

	/**
	 * Выбор объектов и запись изменений состава задачей VS Code.
	 *
	 * @param objects - Объекты проекта
	 * @param current - Полные имена объектов текущего состава
	 */
	private async pickAndWrite(objects: readonly CompositionObject[], current: ReadonlySet<string>): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			objects.map((object) => ({ label: object.name, description: object.entitySet, picked: current.has(object.name) })),
			{
				title: 'Состав OData',
				placeHolder: 'Отметьте объекты, доступные через OData',
				canPickMany: true,
				matchOnDescription: true,
				ignoreFocusOut: true,
			}
		);
		if (!picked) {
			return;
		}
		const pickedNames = new Set(picked.map((item) => item.label));
		const include = [...pickedNames].filter((name) => !current.has(name));
		const exclude = [...current].filter((name) => !pickedNames.has(name));
		if (include.length === 0 && exclude.length === 0) {
			return;
		}
		await this.runCompositionTask(buildCompositionRequest(include, exclude), (response) => {
			const result = this.compositionResult(response, true, []);
			if (!result.success) {
				return result.stderr;
			}
			void vscode.window.showInformationMessage(result.stdout.split('\n').filter(Boolean).join(' '));
			return undefined;
		});
	}

	/**
	 * Запуск служебной обработки задачей VS Code, как у остальных команд панели:
	 * вывод в терминале задачи, хуки команды, возврат базы автономному серверу.
	 *
	 * @param request - Запрос к обработке
	 * @param onResponse - Что сделать с ответом; строка - ошибка для показа
	 */
	private async runCompositionTask(
		request: CompositionRequest,
		onResponse: (response: CompositionResponse) => string | undefined
	): Promise<void> {
		const run = await this.prepareComposition(request, undefined);
		if ('failure' in run) {
			if (run.failure !== '') {
				void vscode.window.showErrorMessage(run.failure);
			}
			return;
		}
		const finish = async (succeeded: boolean): Promise<{ error?: string }> => {
			const outcome = await this.finishComposition(run, succeeded);
			return 'error' in outcome ? { error: outcome.error } : { error: onResponse(outcome.response) };
		};
		await this.runVRunnerSequential(run.steps, undefined, 'Состав OData', ODATA_SETUP_COMMAND, true, run.restore, undefined, finish);
	}

	/**
	 * Объекты проекта, которые могут входить в состав, по метаданным md-sparrow.
	 *
	 * @param root - Корень проекта
	 * @returns Объекты или undefined, если метаданные не прочитаны
	 */
	private async projectObjects(root: string): Promise<CompositionObject[] | undefined> {
		try {
			return compositionObjects(await loadProjectMetadataTree(this.context, root));
		} catch (error) {
			log.warn(`Метаданные проекта не прочитаны: ${(error as Error).message}`);
			return undefined;
		}
	}

	/**
	 * Текущий состав из `$metadata` автономного сервера проекта.
	 *
	 * Наборы OData сопоставляются с объектами проекта: у табличных частей и
	 * записей регистров свои наборы, по одним именам наборов объект не восстановить.
	 *
	 * @param root - Корень проекта
	 * @param objects - Объекты проекта
	 * @returns Объекты состава или undefined, если сервер не запущен с OData
	 */
	private async compositionFromServer(
		root: string | undefined,
		objects: readonly CompositionObject[] | undefined
	): Promise<CompositionObject[] | undefined> {
		if (!objects) {
			return undefined;
		}
		const endpoint = resolveODataEndpoint(root);
		if ('problem' in endpoint) {
			return undefined;
		}
		const outcome = await callOData(
			{ serviceRoot: endpoint.serviceRoot, method: 'GET', resource: '$metadata', credentials: await this.vrunner.getIbCredentials(), fullBody: true },
			(url, init) => fetch(url, init)
		);
		if (!outcome.success || typeof outcome.data !== 'string') {
			log.warn(`Состав из $metadata не прочитан: ${outcome.error ?? outcome.summary}`);
			return undefined;
		}
		const sets = metadataComposition(outcome.data);
		return objects.filter((object) => sets.has(object.entitySet));
	}

	/**
	 * Ответ агенту по составу, прочитанному без обработки.
	 */
	private readResult(
		composition: readonly CompositionObject[],
		objects: readonly CompositionObject[] | undefined,
		source: string
	): StructuredCommandResult {
		const { data, notes } = compositionData(composition.map((object) => object.entitySet), objects);
		return {
			success: true,
			exitCode: 0,
			stdout: [`Состав стандартного интерфейса OData: объектов ${composition.length}.`, source, ...notes].join('\n'),
			stderr: '',
			data,
		};
	}

	/**
	 * Готовит запуск служебной обработки: исходники, сборку при необходимости,
	 * файл запроса и освобождение базы.
	 *
	 * Обработка собирается в каталоге сборки проекта один раз и пересобирается
	 * при смене исходников. Пока Предприятие работает с файловой базой, автономный
	 * сервер этой базы останавливается и после запуска поднимается снова.
	 *
	 * @param request - Запрос к обработке
	 * @param opts - Параметры вызова
	 * @returns План запуска или причина отказа (пустая, если сообщение уже показано)
	 */
	private async prepareComposition(
		request: CompositionRequest,
		opts: CommandExecutionOptions | undefined
	): Promise<CompositionRun | { failure: string }> {
		const root = this.getExecutionCwd(opts);
		if (!root) {
			return { failure: 'Укажите projectPath или откройте рабочую область с проектом 1С' };
		}
		const gate = await this.settingsGate(opts);
		if (gate) {
			return { failure: gate === 'blocked' ? '' : gate.stderr };
		}

		const workDir = path.join(resolveConfigPath(this.vrunner.getOutPath(), root), WORK_DIR);
		const epfPath = path.join(workDir, `${PROCESSOR_NAME}.epf`);
		const hashPath = path.join(workDir, `${PROCESSOR_NAME}.sha256`);
		const responsePath = path.join(workDir, RESPONSE_FILE);
		const hash = processorSourceHash();

		const intents: VRunnerIntent[] = [];
		try {
			await fs.mkdir(workDir, { recursive: true });
			if (!(await this.processorIsBuilt(epfPath, hashPath, hash))) {
				const sourceDir = path.join(workDir, 'src');
				await fs.rm(sourceDir, { recursive: true, force: true });
				await fs.rm(epfPath, { force: true });
				for (const [file, content] of Object.entries(processorSourceFiles())) {
					const target = path.join(sourceDir, file);
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.writeFile(target, content, 'utf8');
				}
				intents.push({ kind: 'epf.build', src: sourceDir, out: workDir });
			}
			await fs.writeFile(path.join(workDir, REQUEST_FILE), JSON.stringify(request), 'utf8');
			await fs.rm(responsePath, { force: true });
		} catch (error) {
			return { failure: `Не удалось подготовить каталог ${workDir}: ${(error as Error).message}` };
		}

		const connectionArgs = await this.vrunner.getIbConnectionParam(opts?.ibConnection);
		intents.push({ kind: 'run.enterprise', execute: epfPath, command: workDir, common: connectionArgs });

		const window = await this.openInfobaseWindow(intents, opts);
		if (window === 'blocked') {
			return { failure: INFOBASE_BUSY };
		}
		const steps = await this.vrunner.planIntents(intents, opts?.settingsFile, opts?.ibConnection);
		return { steps, restore: window.restore, notices: this.vrunner.consumePlanNotices(), epfPath, hashPath, hash, responsePath };
	}

	/**
	 * Разбирает ответ обработки после запуска и запоминает собранную обработку.
	 *
	 * @param run - План запуска
	 * @param succeeded - vanessa-runner завершился успешно
	 * @returns Ответ обработки или текст ошибки
	 */
	private async finishComposition(
		run: CompositionRun,
		succeeded: boolean
	): Promise<{ response: CompositionResponse } | { error: string }> {
		if (await fileExists(run.epfPath)) {
			await fs.writeFile(run.hashPath, run.hash, 'utf8').catch(() => undefined);
		}
		try {
			return { response: parseCompositionResponse(await fs.readFile(run.responsePath, 'utf8')) };
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
			const reason = missing
				? succeeded
					? 'Служебная обработка не вернула результат: Предприятие завершилось, но обработка не открылась.'
					: 'Служебная обработка не вернула результат: сборка или запуск Предприятия завершились ошибкой, подробности в выводе.'
				: `Ответ служебной обработки не прочитан: ${(error as Error).message}.`;
			return {
				error:
					`${reason} Проверьте строку подключения и учётную запись профиля, а также что у пользователя ` +
					'отключена защита от опасных действий: иначе Предприятие ждёт подтверждения открытия внешней обработки.',
			};
		}
	}

	/**
	 * Собрана ли обработка из текущих исходников.
	 *
	 * @param epfPath - Собранная обработка
	 * @param hashPath - Файл с отпечатком исходников сборки
	 * @param hash - Отпечаток текущих исходников
	 */
	private async processorIsBuilt(epfPath: string, hashPath: string, hash: string): Promise<boolean> {
		if (!(await fileExists(epfPath))) {
			return false;
		}
		try {
			return (await fs.readFile(hashPath, 'utf8')).trim() === hash;
		} catch {
			return false;
		}
	}

	/**
	 * Ответ команды по ответу служебной обработки.
	 *
	 * @param response - Ответ обработки
	 * @param changes - В запросе были объекты для включения или исключения
	 * @param notices - Замечания планирования (временные параметры профиля)
	 */
	private compositionResult(
		response: CompositionResponse,
		changes: boolean,
		notices: string[],
		objects?: readonly CompositionObject[]
	): StructuredCommandResult {
		// Ошибка платформы приходит без состава: число объектов тогда ничего не значит
		const lines = response.error === undefined
			? [`Состав стандартного интерфейса OData: объектов ${response.composition.length}.`]
			: [];
		// Обработка возвращает полные имена в варианте языка конфигурации: в ответ идут имена наборов
		const setNames = (names: readonly string[]) => names.map((name) => entitySetName(name) ?? name);
		const added = setNames(response.added);
		const removed = setNames(response.removed);
		if (added.length > 0) {
			lines.push(`Включены: ${added.join(', ')}.`);
		}
		if (removed.length > 0) {
			lines.push(`Исключены: ${removed.join(', ')}.`);
		}
		if (changes && response.success && response.error === undefined && response.added.length === 0 && response.removed.length === 0) {
			lines.push('Состав не менялся: объекты уже были в нужном состоянии.');
		}
		const composition = compositionData(setNames(response.composition), objects);
		lines.push(...notices, ...composition.notes);

		const errors: string[] = [];
		if (response.notFound.length > 0) {
			errors.push(notFoundMessage(response.notFound));
		}
		if (response.error) {
			errors.push(response.error);
		}

		return {
			success: response.success && errors.length === 0,
			exitCode: response.success && errors.length === 0 ? 0 : 1,
			stdout: lines.join('\n'),
			stderr: errors.join('\n'),
			data: {
				...composition.data,
				...(changes ? { added, removed } : {}),
				...(response.notFound.length > 0 ? { notFound: response.notFound } : {}),
			},
		};
	}
}

/**
 * Есть ли файл.
 *
 * @param filePath - Путь к файлу
 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}
