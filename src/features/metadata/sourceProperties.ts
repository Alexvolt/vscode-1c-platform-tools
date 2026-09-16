/**
 * Свойства исходного кода, которые подставляются в пути собранных файлов.
 *
 * @module sourceProperties
 */

import * as path from 'node:path';
import type * as vscode from 'vscode';
import { configurationDescriptorFile, externalDescriptorFile } from '../../shared/objectPaths';
import type { ExternalKind, SourceFormat } from '../../shared/projectLayout';
import { ensureMdSparrowRuntime } from './mdSparrowBootstrap';
import { runMdSparrowParamsRead, type MdSparrowParams } from './mdSparrowParams';
import { mdSparrowSchemaFlagFromConfigurationXml } from './mdSparrowSchemaVersion';

/** Строковое свойство из ответа md-sparrow либо текст ошибки. */
async function readProperty(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	params: MdSparrowParams,
	descriptor: string,
	property: 'version' | 'name'
): Promise<{ value: string } | { error: string }> {
	try {
		const runtime = await ensureMdSparrowRuntime(context, workspaceRoot);
		const result = await runMdSparrowParamsRead(
			runtime,
			{ ...params, schemaVersion: await mdSparrowSchemaFlagFromConfigurationXml(descriptor) },
			{ cwd: workspaceRoot }
		);
		if (result.exitCode !== 0) {
			return { error: (result.stderr.trim() || result.stdout.trim() || `код ${result.exitCode}`).slice(0, 400) };
		}
		const dto = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
		const value = dto[property];
		return { value: typeof value === 'string' ? value.trim() : '' };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/**
 * Читает имя или версию конфигурации или расширения.
 *
 * @param context - Контекст расширения: из него берётся md-sparrow
 * @param workspaceRoot - Корень проекта
 * @param root - Каталог исходного кода относительно проекта и его формат
 * @param property - Свойство
 * @returns Значение, пустая строка, если оно не задано, либо текст ошибки
 */
export async function readSourceProperty(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	root: { dir: string; format: SourceFormat },
	property: 'name' | 'version'
): Promise<{ value: string } | { error: string }> {
	const descriptor = configurationDescriptorFile({
		dir: path.resolve(workspaceRoot, root.dir),
		format: root.format,
		name: '',
		isExtension: false,
	});
	return readProperty(
		context,
		workspaceRoot,
		{ op: 'cf-configuration-properties-get', configurationXml: descriptor },
		descriptor,
		property
	);
}

/**
 * Читает имя внешней обработки или отчёта из метаданных.
 *
 * @param context - Контекст расширения: из него берётся md-sparrow
 * @param workspaceRoot - Корень проекта
 * @param root - Каталог объекта относительно проекта, формат, вид и имя описания
 * @returns Имя либо текст ошибки
 */
export async function readExternalName(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
	root: { dir: string; format: SourceFormat; kind: ExternalKind; file: string }
): Promise<{ value: string } | { error: string }> {
	const descriptor = externalDescriptorFile({ ...root, dir: path.resolve(workspaceRoot, root.dir) });
	return readProperty(
		context,
		workspaceRoot,
		{ op: 'external-artifact-properties-get', objectXml: descriptor },
		descriptor,
		'name'
	);
}
