/**
 * Запуск команд 1С:EDT через `1cedtcli`.
 *
 * Команды EDT идут долго - импорт большой конфигурации занимает десятки минут, -
 * поэтому выполняются задачей VS Code: с выводом в терминал, отменой и повтором,
 * как команды vanessa-runner.
 *
 * Рабочую область `1cedtcli` занимает монопольно: пока идёт одна команда, вторая
 * в том же каталоге падает с сообщением о занятой рабочей области. Поэтому у
 * проекта своя рабочая область, а команды выстраиваются в очередь.
 *
 * @module edtRunner
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildProcessCommand } from '../../utils/commandUtils';
import { createVRunnerTask, type TaskOutputChain } from '../tasks/vrunnerTask';
import { logger } from '../../shared/logger';
import { findEdtInstallations, pickEdtInstallation, type EdtInstallation } from '../../shared/edtLocator';
import { isEdtProject } from '../../shared/projectLayout';
import { projectConfiguration } from '../../shared/projectConfiguration';
import { currentRoot } from '../../shared/workspaceProjects';

const log = logger.scope('edt');

/** Тип задачи EDT в списке задач. */
const EDT_TASK_TYPE = '1c-edt';

/** Рабочая область по умолчанию: рядом со сборкой проекта. */
const DEFAULT_WORKSPACE_DIR = 'edt-workspace';

/** Идёт ли сейчас команда EDT: рабочую область нельзя делить. */
let running: Promise<number> | undefined;

/** Ответ, когда 1С:EDT на машине не найдена. */
export const EDT_NOT_FOUND_MESSAGE =
	'1С:EDT не найдена. Установите её через 1cedtstart или укажите каталог в настройке «Каталог установки 1С:EDT».';

/** Сколько последнего вывода команды хранится для объяснения ошибки. */
const OUTPUT_TAIL_LIMIT = 64_000;

/** Известные ответы 1cedtcli: русский и английский текст одного и того же отказа. */
const EDT_FAILURES: { pattern: RegExp; explain: (match: RegExpMatchArray) => string }[] = [
	{
		pattern: /рабочая область '[^']*' уже используется другим приложением|workspace .* is currently in use by another application/i,
		explain: () =>
			'Рабочая область 1С:EDT занята: её держит открытая EDT или другой процесс 1cedtcli. Закройте EDT на этой рабочей области и повторите команду.',
	},
	{
		pattern: /Проект с именем (.+?) уже существует в рабочей области|project (?:with name )?'?(.+?)'? already exists in the workspace/i,
		explain: (match) => `Проект ${match[1] ?? match[2]} уже подключён к рабочей области 1С:EDT.`,
	},
	{
		pattern: /Project not found: (.+)|Не найдено проекта с именем (.+?) в рабочей области/i,
		explain: (match) => `Проекта ${(match[1] ?? match[2]).trim()} нет в рабочей области 1С:EDT.`,
	},
];

/**
 * Причина неудачной команды по выводу 1cedtcli.
 *
 * @param output - Вывод команды
 * @returns Объяснение для пользователя либо undefined, если отказ не распознан
 */
export function explainEdtFailure(output: string): string | undefined {
	for (const failure of EDT_FAILURES) {
		const match = output.match(failure.pattern);
		if (match) {
			return failure.explain(match);
		}
	}
	return undefined;
}

/**
 * Определение задачи графической EDT на рабочей области: по нему команды
 * узнают, что редактор держит рабочую область.
 *
 * @param workspaceDir - Каталог рабочей области EDT
 */
export function edtEditorTaskDefinition(workspaceDir: string): vscode.TaskDefinition {
	return { type: EDT_TASK_TYPE, command: 'open', workspace: path.resolve(workspaceDir) };
}

/** Открыта ли графическая EDT на рабочей области командой «Запустить EDT». */
function editorHoldsWorkspace(workspaceDir: string): boolean {
	const wanted = path.resolve(workspaceDir).toLowerCase();
	return vscode.tasks.taskExecutions.some((execution) => {
		const definition = execution.task.definition;
		return (
			definition.type === EDT_TASK_TYPE &&
			definition.command === 'open' &&
			typeof definition.workspace === 'string' &&
			definition.workspace.toLowerCase() === wanted
		);
	});
}

/** Настройки раздела «1С:EDT». */
export interface EdtSettings {
	/** Каталог установки или каталог со списком версий. */
	path: string;
	/** Версия при нескольких установленных. */
	version: string;
	/** Каталог рабочей области. */
	workspace: string;
	/** Таймаут команды в секундах. */
	timeoutSeconds: number;
	/** Дополнительные аргументы JVM. */
	vmargs: string[];
}

/**
 * Читает настройки EDT проекта.
 *
 * @param root - Корень проекта
 */
export function readEdtSettings(root: string | undefined = currentRoot()): EdtSettings {
	const config = projectConfiguration(root);
	return {
		path: config.get<string>('edt.path', ''),
		version: config.get<string>('edt.version', ''),
		workspace: config.get<string>('edt.workspace', ''),
		timeoutSeconds: config.get<number>('edt.timeoutSeconds', 3600),
		vmargs: config.get<string[]>('edt.vmargs', []),
	};
}

/**
 * Установка EDT, которой выполняются команды.
 *
 * @returns Установка или undefined, если EDT не найдена
 */
export function resolveEdt(settings: EdtSettings = readEdtSettings()): EdtInstallation | undefined {
	const { installations } = findEdtInstallations(settings.path);
	return pickEdtInstallation(installations, settings.version);
}

/**
 * Своё место во временном каталоге для проекта EDT, открытого как рабочая область:
 * каталог сборки лежит внутри проекта, а рабочую область и выгрузки внутри проекта
 * EDT не принимает.
 */
function temporaryProjectDir(workspaceRoot: string): string {
	const key = createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 8);
	return path.join(os.tmpdir(), '1c-platform-tools', `${path.basename(workspaceRoot)}-${key}`);
}

/**
 * Корень выгрузок моста: каталог сборки, а у проекта EDT, открытого как рабочая область,
 * временный каталог.
 *
 * @param workspaceRoot - Корень рабочей области VS Code
 * @param buildPath - Каталог сборки проекта
 */
export function edtStagingRoot(workspaceRoot: string, buildPath: string): string {
	return isEdtProject(workspaceRoot) ? temporaryProjectDir(workspaceRoot) : buildPath;
}

/**
 * Каталог рабочей области для команд EDT.
 *
 * @param workspaceRoot - Корень рабочей области VS Code
 * @param buildPath - Каталог сборки проекта
 */
export function edtWorkspaceDir(
	workspaceRoot: string,
	buildPath: string,
	settings: EdtSettings = readEdtSettings(workspaceRoot)
): string {
	const configured = settings.workspace.trim();
	if (configured) {
		return path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured);
	}
	if (isEdtProject(workspaceRoot)) {
		return path.join(temporaryProjectDir(workspaceRoot), DEFAULT_WORKSPACE_DIR);
	}
	return path.join(workspaceRoot, buildPath, DEFAULT_WORKSPACE_DIR);
}

/** Что запускаем. */
export interface EdtCommand {
	/** Имя команды `1cedtcli`: import, export, validate. */
	command: string;
	/** Аргументы команды. */
	args: string[];
	/** Название задачи для панели терминала. */
	title: string;
	/** Каталог рабочей области EDT. */
	workspaceDir: string;
	/** Каталог запуска процесса. */
	cwd: string;
	/** Общий терминал шагов команды: без него задача очищает терминал. */
	output?: TaskOutputChain;
}

/**
 * Собирает аргументы запуска `1cedtcli`.
 *
 * Порядок важен: рабочая область и общие параметры идут до `-command`, всё
 * после него достаётся самой команде.
 */
export function buildEdtArgs(request: EdtCommand, settings: EdtSettings): string[] {
	const args = ['-data', request.workspaceDir, '-timeout', String(settings.timeoutSeconds)];
	for (const vmarg of settings.vmargs) {
		args.push('-vmargs', vmarg);
	}
	args.push('-command', request.command, ...request.args);
	return args;
}

/**
 * Имя проекта EDT.
 *
 * Рабочая область знает проект по имени из `.project`, а оно не обязано
 * совпадать с именем каталога: проект `УчетАрхитектора-02-04` спокойно лежит в
 * каталоге `архидок-edt`. Без файла остаётся имя каталога.
 *
 * @param projectDir - Каталог проекта
 */
export function edtProjectName(projectDir: string): string {
	try {
		const description = fs.readFileSync(path.join(projectDir, '.project'), 'utf-8');
		const name = description.match(/<name>([^<]+)<\/name>/)?.[1]?.trim();
		if (name) {
			return name;
		}
	} catch {
		// Файла нет или он нечитаем: имя каталога - разумное приближение
	}
	return path.basename(projectDir);
}

/**
 * Подключён ли проект к рабочей области EDT.
 *
 * Рабочая область помнит подключённые проекты в служебном каталоге: имя
 * проекта там совпадает с именем каталога проекта.
 *
 * @param workspaceDir - Каталог рабочей области EDT
 * @param projectName - Имя проекта
 */
export function isProjectRegistered(workspaceDir: string, projectName: string): boolean {
	return fs.existsSync(
		path.join(workspaceDir, '.metadata', '.plugins', 'org.eclipse.core.resources', '.projects', projectName)
	);
}

/**
 * Отключает проект от рабочей области, файлы на диске остаются: выгрузку EDT
 * импортирует только в проект, которого в рабочей области ещё нет.
 *
 * @param projectDir - Каталог проекта EDT
 * @param workspaceDir - Каталог рабочей области
 * @param cwd - Каталог запуска
 * @param output - Общий терминал шагов команды
 * @returns Код возврата; ноль, если проекта в рабочей области не было
 */
export async function detachProject(
	projectDir: string,
	workspaceDir: string,
	cwd: string,
	output?: TaskOutputChain
): Promise<number> {
	if (!fs.existsSync(path.join(projectDir, '.project'))) {
		return 0;
	}
	const projectName = edtProjectName(projectDir);
	if (!isProjectRegistered(workspaceDir, projectName)) {
		return 0;
	}
	return runEdtCommand({
		command: 'delete',
		args: ['-y', 'true', projectName],
		title: `EDT: отключение ${projectName}`,
		workspaceDir,
		cwd,
		output,
	});
}

/**
 * Подключает проект к рабочей области, если он ещё не подключён.
 *
 * Команды над проектом обращаются к нему по имени, а имя знает только рабочая
 * область: на свежей области любая из них не нашла бы проект.
 *
 * @param projectDir - Каталог проекта EDT
 * @param workspaceDir - Каталог рабочей области
 * @param cwd - Каталог запуска
 * @param output - Общий терминал шагов команды
 * @returns Код возврата подключения; ноль, если проект уже был подключён
 */
export async function ensureProjectRegistered(
	projectDir: string,
	workspaceDir: string,
	cwd: string,
	output?: TaskOutputChain
): Promise<number> {
	const projectName = edtProjectName(projectDir);
	if (isProjectRegistered(workspaceDir, projectName)) {
		return 0;
	}

	return runEdtCommand({
		command: 'import',
		args: ['--project', projectDir],
		title: `EDT: подключение проекта ${projectName}`,
		workspaceDir,
		cwd,
		output,
	});
}

/**
 * Выполняет команду EDT задачей VS Code.
 *
 * Пока идёт одна команда, вторая ждёт: `1cedtcli` не делит рабочую область.
 *
 * @param request - Команда и её аргументы
 * @returns Код возврата процесса
 */
export async function runEdtCommand(request: EdtCommand): Promise<number> {
	const settings = readEdtSettings();
	const installation = resolveEdt(settings);
	if (!installation) {
		void vscode.window.showErrorMessage(EDT_NOT_FOUND_MESSAGE);
		return 1;
	}

	// Рабочую область 1cedtcli не делит: следующая команда ждёт, пока закончится текущая
	while (running) {
		await running.catch(() => undefined);
	}

	if (editorHoldsWorkspace(request.workspaceDir)) {
		void vscode.window.showErrorMessage(
			'1С:EDT открыта на рабочей области проекта, а 1cedtcli с занятой рабочей областью не работает. Закройте EDT и повторите команду.'
		);
		return 1;
	}

	const args = buildEdtArgs(request, settings);
	// Задача исполняет команду процессом, а не терминалом пользователя: экранирование по оболочке процесса
	const command = buildProcessCommand(installation.cli, args);
	log.info(`EDT ${installation.version}: ${request.command}`);

	let output = '';
	running = new Promise<number>((resolve) => {
		const task = createVRunnerTask({
			name: request.title,
			command,
			cwd: request.cwd,
			definition: { type: EDT_TASK_TYPE, command: request.command },
			exitCallback: resolve,
			appendOutput: request.output?.append(),
			onOutput: (chunk) => {
				output = (output + chunk).slice(-OUTPUT_TAIL_LIMIT);
			},
		});
		void vscode.tasks.executeTask(task);
	});

	try {
		const exitCode = await running;
		if (exitCode !== 0) {
			const reason = explainEdtFailure(output);
			log.warn(`EDT ${request.command}: код возврата ${exitCode}${reason ? `: ${reason}` : ''}`);
			if (reason) {
				void vscode.window.showErrorMessage(reason);
			}
		}
		return exitCode;
	} finally {
		running = undefined;
	}
}
