import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { runWithProject } from '../../shared/workspaceProjects';

const PROJECT = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/designer');

suite('Docker: режим проекта', () => {
	const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('1c-platform-tools');

	teardown(async () => {
		await config().update('docker.enabled', undefined, vscode.ConfigurationTarget.Workspace);
	});

	test('путь файла проекта для раннера в Docker ведёт в /workspace', async () => {
		const vrunner = VRunnerManager.getInstance();
		const report = path.join(PROJECT, 'build', 'test-reports', 'xunit.xml');
		const outside = path.join(path.dirname(PROJECT), 'другой', 'xunit.xml');

		await runWithProject(PROJECT, async () => {
			assert.strictEqual(await vrunner.runnerPath(report), report);
			await config().update('docker.enabled', true, vscode.ConfigurationTarget.Workspace);
			assert.strictEqual(await vrunner.runnerPath(report), '/workspace/build/test-reports/xunit.xml');
			assert.strictEqual(await vrunner.runnerPath(outside), outside);
		});
	});
});
