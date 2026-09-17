import * as vscode from 'vscode';
import { logger } from '../shared/logger';
import { stopMdSparrowResidents } from '../features/metadata/mdSparrowRunner';
import { bootstrapApp } from './bootstrapApp';

const log = logger.scope('app');

export async function activate(context: vscode.ExtensionContext) {
	const startedAt = Date.now();
	const version = (context.extension.packageJSON as { version?: string }).version ?? '?';
	log.info(`активация 1C: Platform Tools v${version}…`);
	try {
		await bootstrapApp(context);
	} catch (err) {
		log.error(`ошибка активации: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
	log.info(`активация завершена за ${Date.now() - startedAt} мс`);
}

export async function deactivate() {
	// Запись, которая в работе, дописывается до выхода процесса
	await stopMdSparrowResidents('now');
	logger.dispose();
}
