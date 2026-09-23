import * as assert from 'node:assert';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { OnecDebugConfigurationProvoider } from '../../features/debug/debugConfigurations';
import { DEBUG_TYPE } from '../../features/debug/debugConstants';
import type { VRunnerManager } from '../../shared/vrunnerManager';
import { runWithProject } from '../../shared/workspaceProjects';

const EXTENSION_ROOT = path.resolve(__dirname, '../../..');
const PROJECT = path.join(EXTENSION_ROOT, 'src', 'test', 'fixtures', 'workspaceScan', 'проект');

/**
 * Профиль, файл которого выбирается по версии vrunner: пока версия не определена,
 * настройки читаются как у vrunner 2 (env.json), после — как у vrunner 3.
 */
function vrunnerWithLateVersion(): VRunnerManager {
	let detected = false;
	return {
		getVRunnerVersion: async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			detected = true;
			return undefined;
		},
		readActiveProfileSettingSync: (option: string) =>
			option === 'ibconnection' ? (detected ? '/Slocalhost\\ib' : '/F./build/ib') : undefined,
		getActiveV8Version: async () => undefined,
	} as unknown as VRunnerManager;
}

suite('отладка: профиль запуска', () => {
	test('строка подключения читается после определения версии vrunner', async () => {
		const provider = new OnecDebugConfigurationProvoider(vrunnerWithLateVersion());
		const config: vscode.DebugConfiguration = { type: DEBUG_TYPE, request: 'attach', name: 'Отладка' };

		const resolved = await runWithProject(PROJECT, () => provider.resolveDebugConfiguration(undefined, config));

		assert.strictEqual(resolved?.connectionString, '/Slocalhost\\ib');
	});
});
