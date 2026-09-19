import * as assert from 'node:assert';
import type { ProjectArtifacts } from '../../features/artifacts/artifactsScanner';
import { ProjectArtifactsTreeDataProvider } from '../../features/artifacts/projectArtifactsView';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';

suite('артефакты: панель', () => {
	test('скрытая панель не сканирует, показанная сканирует при запросе узлов', async () => {
		let scans = 0;
		const scan = async (): Promise<ProjectArtifacts[]> => {
			scans += 1;
			return [];
		};
		const view = { visible: false };
		const provider = new ProjectArtifactsTreeDataProvider(createMockExtensionContext(), scan);
		provider.setTreeView(view);
		let changes = 0;
		provider.onDidChangeTreeData(() => {
			changes += 1;
		});

		await provider.refresh();
		assert.strictEqual(scans, 0);
		assert.strictEqual(changes, 1);

		await provider.getChildren();
		assert.strictEqual(scans, 1);

		view.visible = true;
		await provider.refresh();
		assert.strictEqual(scans, 2);

		view.visible = false;
		await provider.refresh();
		await provider.getChildren();
		assert.strictEqual(scans, 3);
	});
});
