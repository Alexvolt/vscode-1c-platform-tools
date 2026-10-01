/**
 * Выбор версии формата новой конфигурации: список форматов даёт md-sparrow.
 * @module dumpFormatPick
 */

import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { ensureMdSparrowRuntime } from './mdSparrowBootstrap';
import { runMdSparrowParamsRead } from './mdSparrowParams';
import { designerXmlVersionToMdSparrowFlag } from './mdSparrowSchemaVersion';

const log = logger.scope('metadata');

/** Формат выгрузки и линейка платформы, которая его пишет: ответ md-sparrow `cf-format-versions`. */
interface DumpFormat {
	readonly version: string;
	readonly platform: string;
}

/**
 * Спрашивает версию формата новой конфигурации.
 *
 * @param context - Контекст расширения: нужен для запуска md-sparrow
 * @param title - Заголовок выбора
 * @returns Флаг md-sparrow, например `V2_21`; undefined, если выбор отменён или список не получен
 */
export async function pickDumpFormat(context: vscode.ExtensionContext, title: string): Promise<string | undefined> {
	let formats: DumpFormat[];
	try {
		const res = await runMdSparrowParamsRead(await ensureMdSparrowRuntime(context), { op: 'cf-format-versions' });
		if (res.exitCode !== 0) {
			throw new Error(res.stderr.trim() || res.stdout.trim() || `код ${res.exitCode}`);
		}
		formats = JSON.parse(res.stdout) as DumpFormat[];
	} catch (e) {
		log.error(`версии формата выгрузки: ${e instanceof Error ? e.message : String(e)}`);
		void vscode.window.showErrorMessage('Не удалось получить версии формата выгрузки.');
		return undefined;
	}
	// md-sparrow перечисляет форматы от старого к новому, а выбирают обычно новый
	const pick = await vscode.window.showQuickPick(
		[...formats].reverse().map((format) => ({ label: format.version, description: `платформа ${format.platform}` })),
		{ title }
	);
	return pick && designerXmlVersionToMdSparrowFlag(pick.label);
}
