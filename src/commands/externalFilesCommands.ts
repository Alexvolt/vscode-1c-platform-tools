import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { BaseCommand, type FinishStep, type OutputTarget } from './baseCommand';
import {
	getBuildExternalProcessorCommandName,
	getBuildExternalReportCommandName,
	getDecompileExternalProcessorCommandName,
	getDecompileExternalReportCommandName
} from '../features/tools/commandNames';
import { logger } from '../shared/logger';
import type { CommandExecutionOptions, StructuredCommandResult } from '../shared/commandExecutionTypes';
import { notifyQuiet } from '../shared/notify';
import { BUILD_SUBDIRS } from '../shared/pathDefaults';
import { hasBuildOutput } from '../shared/buildOutput';
import { sameOrUnder } from '../shared/projectLayout';
import type { RelativeExternal } from '../shared/projectPaths';
import type { VRunnerIntent } from '../shared/vrunnerCli';
import { VRUNNER_FEATURES, isAtLeast } from '../shared/vrunnerVersion';
import { readExternalName } from '../features/metadata/sourceProperties';

const log = logger.scope('commands');

/**
 * Переносит файл, в том числе на другой диск.
 *
 * @param from - Откуда
 * @param to - Куда; существующий файл заменяется
 */
async function moveFile(from: string, to: string): Promise<void> {
	try {
		await fs.rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
			throw error;
		}
		await fs.copyFile(from, to);
		await fs.rm(from, { force: true });
	}
}

/**
 * Тип внешнего файла
 */
export type ExternalFileType = 'processor' | 'report';

/**
 * Команды для работы с внешними файлами (обработки и отчеты)
 */
export class ExternalFilesCommands extends BaseCommand {
	constructor(private readonly context: vscode.ExtensionContext) {
		super();
	}

	async compile(
		fileType: ExternalFileType = 'processor',
		opts?: CommandExecutionOptions
	): Promise<StructuredCommandResult | void> {
		const cwd = this.getExecutionCwd(opts);
		if (!cwd) {
			if (opts?.wait === true) {
				return this.executionError(
					'Укажите projectPath или откройте рабочую область с проектом 1С'
				);
			}
			this.ensureWorkspace();
			return;
		}
		if (!(await this.ensureOscriptForExecution(opts))) {
			if (opts?.wait === true) {
				return this.executionError('OneScript (oscript) или opm не найдены');
			}
			return;
		}

		const srcFolder = fileType === 'processor' ? await this.processorsContainer() : await this.reportsContainer();
		const srcPath = path.join(cwd, srcFolder);

		if (opts?.wait === true) {
			try {
				const stats = await fs.stat(srcPath);
				if (!stats.isDirectory()) {
					return this.executionError(`Каталог ${srcFolder} не найден`);
				}
			} catch {
				return this.executionError(`Каталог ${srcFolder} не найден`);
			}
		} else if (!(await this.checkDirectoryExists(srcPath, `Папка ${srcFolder} не является директорией`))) {
			return;
		}

		const commandName = fileType === 'processor'
			? getBuildExternalProcessorCommandName()
			: getBuildExternalReportCommandName();
		if (hasBuildOutput(opts)) {
			return this.compileToOutputs(fileType, cwd, srcFolder, opts, commandName);
		}

		const buildPath = this.vrunner.getOutPath();
		const outputFolder = fileType === 'processor' ? BUILD_SUBDIRS.epf : BUILD_SUBDIRS.erf;
		const outputFullPath = path.join(cwd, buildPath, outputFolder);
		if (!(await this.ensureDirectoryForExecution(
			outputFullPath,
			opts,
			`Ошибка при создании папки ${buildPath}/${outputFolder}`
		))) {
			if (opts?.wait === true) {
				return this.executionError(`Не удалось создать каталог ${buildPath}/${outputFolder}`);
			}
			return;
		}

		const outputPath = path.join(buildPath, outputFolder);
		const ibConnectionParam = await this.vrunner.getIbConnectionParam();
		return this.runIntent(
			{ kind: 'epf.build', src: srcFolder, out: outputPath, common: ibConnectionParam },
			opts, commandName.title, outputPath, commandName.id
		);
	}

	/**
	 * Сборка в пути, заданные вызовом.
	 *
	 * Раннер называет файл по файлу описания и кладёт все файлы в один каталог:
	 * собранное переезжает из промежуточного каталога.
	 *
	 * @param srcFolder - Каталог внешних объектов относительно проекта
	 */
	private async compileToOutputs(
		fileType: ExternalFileType,
		cwd: string,
		srcFolder: string,
		opts: CommandExecutionOptions | undefined,
		commandName: { title: string; id: string }
	): Promise<StructuredCommandResult | void> {
		const version = await this.vrunner.getVRunnerVersion();
		if (version === undefined || !isAtLeast(version, VRUNNER_FEATURES.cli3)) {
			return this.reportUnavailable(
				'Путь и имя внешних обработок и отчётов задаются только с vanessa-runner 3.x',
				opts
			);
		}

		const paths = await this.paths();
		const externals = [...(paths?.processors ?? []), ...(paths?.reports ?? []), ...(paths?.testProcessors ?? [])]
			.filter((external) => sameOrUnder(path.resolve(cwd, external.dir), path.resolve(cwd, srcFolder)));
		if (externals.length === 0) {
			return this.reportUnavailable(`В каталоге ${srcFolder} нет внешних обработок и отчётов`, opts);
		}

		const typeOf = (external: RelativeExternal) => (external.kind === 'report' ? 'erf' : 'epf');
		const staged = externals.map((external) => `${external.file}.${typeOf(external)}`);
		const repeated = staged.find((name, index) =>
			staged.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== index
		);
		if (repeated !== undefined) {
			return this.reportUnavailable(`Несколько объектов из ${srcFolder} раннер соберёт в один файл ${repeated}`, opts);
		}

		const workspaceRoot = this.vrunner.getWorkspaceRoot() ?? cwd;
		const buildPath = this.vrunner.getOutPath();
		const directory = path.posix.join(buildPath, fileType === 'processor' ? BUILD_SUBDIRS.epf : BUILD_SUBDIRS.erf);
		const outputs = await this.resolveOutputs(
			externals.map((external): OutputTarget => ({
				label: `${external.kind === 'report' ? 'внешнего отчёта' : 'внешней обработки'} «${external.name}»`,
				type: typeOf(external),
				directory,
				name: external.file,
				variables: { folder: path.basename(path.resolve(cwd, external.dir)) },
				unavailable: { version: 'у внешних обработок и отчётов версии нет' },
				lazy: { name: () => readExternalName(this.context, workspaceRoot, external) },
			})),
			opts,
			false
		);
		if (!Array.isArray(outputs)) {
			return outputs;
		}

		const staging = path.posix.join(buildPath, BUILD_SUBDIRS.staging, fileType === 'processor' ? 'epf' : 'erf');
		const stagingFull = path.resolve(cwd, staging);
		try {
			await fs.rm(stagingFull, { recursive: true, force: true });
			await fs.mkdir(stagingFull, { recursive: true });
		} catch (error) {
			return this.reportUnavailable(`Не удалось подготовить каталог ${staging}: ${(error as Error).message}`, opts);
		}

		const finish: FinishStep = async (succeeded) => {
			const artifacts: string[] = [];
			const missing: string[] = [];
			for (const [index, output] of outputs.entries()) {
				try {
					await moveFile(path.join(stagingFull, staged[index]), path.resolve(cwd, output));
					artifacts.push(output);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						return { artifacts, error: `Не удалось перенести ${staged[index]} в ${output}: ${(error as Error).message}` };
					}
					missing.push(staged[index]);
				}
			}
			if (!succeeded) {
				return { artifacts };
			}
			if (missing.length > 0) {
				return { artifacts, error: `Раннер не собрал ${missing.join(', ')}` };
			}
			const unknown = await fs.readdir(stagingFull).catch(() => []);
			if (unknown.length > 0) {
				return { artifacts, error: `Раннер собрал файлы, которых нет в раскладке, они остались в ${staging}: ${unknown.join(', ')}` };
			}
			return { artifacts };
		};

		const ibConnectionParam = await this.vrunner.getIbConnectionParam();
		const intent: VRunnerIntent = { kind: 'epf.build', src: srcFolder, out: staging, common: ibConnectionParam };
		return this.runIntent(intent, opts, commandName.title, undefined, commandName.id, { finish });
	}

	async decompile(
		fileType: ExternalFileType = 'processor',
		opts?: CommandExecutionOptions
	): Promise<StructuredCommandResult | void> {
		const cwd = this.getExecutionCwd(opts);
		if (!cwd) {
			if (opts?.wait === true) {
				return this.executionError(
					'Укажите projectPath или откройте рабочую область с проектом 1С'
				);
			}
			this.ensureWorkspace();
			return;
		}
		if (!(await this.ensureOscriptForExecution(opts))) {
			if (opts?.wait === true) {
				return this.executionError('OneScript (oscript) или opm не найдены');
			}
			return;
		}

		const buildPath = this.vrunner.getOutPath();
		const buildFolder = fileType === 'processor' ? BUILD_SUBDIRS.epf : BUILD_SUBDIRS.erf;
		const inputPath = path.join(buildPath, buildFolder);
		const inputFullPath = path.join(cwd, inputPath);

		if (opts?.wait === true) {
			try {
				const stats = await fs.stat(inputFullPath);
				if (!stats.isDirectory()) {
					return this.executionError(`Каталог ${inputPath} не найден`);
				}
			} catch {
				return this.executionError(`Каталог ${inputPath} не найден`);
			}
		} else if (!(await this.checkDirectoryExists(inputFullPath, `Папка ${inputPath} не является директорией`))) {
			return;
		}

		const outputPath = fileType === 'processor' ? await this.processorsContainer() : await this.reportsContainer();
		const ibConnectionParam = await this.vrunner.getIbConnectionParam();
		const commandName = fileType === 'processor'
			? getDecompileExternalProcessorCommandName()
			: getDecompileExternalReportCommandName();
		return this.runIntent(
			{ kind: 'epf.decompile', input: inputPath, out: outputPath, common: ibConnectionParam },
			opts, commandName.title, undefined, commandName.id
		);
	}

	async clearCache(opts?: CommandExecutionOptions): Promise<StructuredCommandResult | void> {
		const reject = this.rejectIfWait(opts, 'Очистка кэша — файловая операция, не vrunner');
		if (reject) {
			return reject;
		}

		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getOutPath();
		const buildDir = path.dirname(buildPath);
		const cacheFilePath = path.join(workspaceRoot, buildDir, 'cache.json');

		try {
			await fs.unlink(cacheFilePath);
			log.info(`Кэш успешно очищен: ${cacheFilePath}`);
			notifyQuiet('Кэш успешно очищен');
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				log.info(`Файл кэша не найден: ${cacheFilePath}`);
				vscode.window.showInformationMessage('Файл кэша не найден');
			} else {
				log.error(`Ошибка при удалении кэша: ${err.message}. Путь: ${cacheFilePath}`);
				vscode.window.showErrorMessage(`Ошибка при удалении кэша: ${err.message}`);
			}
		}
	}
}
