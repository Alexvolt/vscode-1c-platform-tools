import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	MetadataSourceTreeItem,
	MetadataTreeDataProvider,
	metadataCommandRoot,
	metadataCommandTarget,
} from '../../features/metadata/metadataTreeView';
import { MetadataFilterViewProvider, type FilterSelection } from '../../features/metadata/metadataFilterView';
import type { ProjectMetadataTreeDto } from '../../features/metadata/metadataTreeService';
import { CONVENTIONAL_PATHS } from '../../shared/projectPaths';
import { currentRoot, runWithProject } from '../../shared/workspaceProjects';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';

const FIRST = path.join(os.tmpdir(), 'metadata-project-switch', 'учёт');
const SECOND = path.join(os.tmpdir(), 'metadata-project-switch', 'склад');

interface ProviderInternals {
	_workspaceRoot: string | undefined;
	_dto: ProjectMetadataTreeDto | undefined;
	_sourceItems: MetadataSourceTreeItem[];
	refresh: () => Promise<void>;
}

function treeOf(root: string): ProjectMetadataTreeDto {
	return { projectRoot: root, mainSchemaVersion: '2.20', mainSchemaVersionFlag: 'V2_20', sources: [] };
}

/** Дерево, прочитанное из первого проекта, с основной конфигурацией в выгрузке. */
function providerShowingFirst(): { provider: MetadataTreeDataProvider; internals: ProviderInternals } {
	const provider = new MetadataTreeDataProvider(createMockExtensionContext());
	const internals = provider as unknown as ProviderInternals;
	internals._workspaceRoot = FIRST;
	internals._dto = treeOf(FIRST);
	internals._sourceItems = [
		new MetadataSourceTreeItem(
			'cf',
			'Учёт',
			'main',
			path.join(FIRST, 'src', 'cf', 'Configuration.xml'),
			path.join(FIRST, 'src', 'cf')
		),
	];
	return { provider, internals };
}

suite('метаданные: смена проекта', () => {
	test('смена проекта снимает отбор по подсистемам и сразу убирает прежний состав', async () => {
		const { provider, internals } = providerShowingFirst();
		provider.setSubsystemFilter('Продажи', new Set(['Номенклатура']));
		let refreshed = 0;
		internals.refresh = async () => {
			refreshed++;
		};
		let changes = 0;
		provider.onDidChangeTreeData(() => changes++);

		await provider.refreshForCurrentProject();

		assert.strictEqual(provider.getSubsystemFilterName(), undefined);
		assert.strictEqual(refreshed, 1);
		assert.strictEqual(changes, 1, 'дерево перерисовано до окончания чтения');
	});

	test('прочитанное дерево отдаётся только своему проекту', () => {
		const { provider } = providerShowingFirst();

		assert.strictEqual(provider.cachedTreeOf(FIRST)?.projectRoot, FIRST);
		assert.strictEqual(provider.cachedTreeOf(SECOND), undefined);
		assert.strictEqual(provider.cachedTreeOf(undefined), undefined);
		if (process.platform === 'win32') {
			assert.strictEqual(provider.cachedTreeOf(FIRST.toUpperCase())?.projectRoot, FIRST);
		}
	});

	test('описание конфигурации берётся из дерева только в проекте дерева', () => {
		const { provider } = providerShowingFirst();

		assert.strictEqual(
			runWithProject(FIRST, () => provider.configurationXml),
			path.join(FIRST, 'src', 'cf', 'Configuration.xml')
		);
		const second = runWithProject(SECOND, () => currentRoot()) ?? SECOND;
		assert.strictEqual(
			runWithProject(SECOND, () => provider.configurationXml),
			path.join(path.normalize(path.join(second, CONVENTIONAL_PATHS.cf)), 'Configuration.xml')
		);
	});

	test('команда узнаёт файл узла дерева', () => {
		const configurationXml = path.join(FIRST, 'src', 'cf', 'Configuration.xml');
		const source = new MetadataSourceTreeItem('cf', 'Учёт', 'main', configurationXml, path.join(FIRST, 'src', 'cf'));
		const uri = vscode.Uri.file(path.join(FIRST, 'src', 'cf', 'Catalogs', 'Валюты.xml'));
		const plain = new vscode.TreeItem('файл');
		plain.resourceUri = uri;

		assert.strictEqual(metadataCommandTarget(source), configurationXml);
		assert.strictEqual(metadataCommandTarget(uri), uri);
		assert.strictEqual(metadataCommandTarget(plain), uri);
		assert.strictEqual(metadataCommandTarget('src/cf'), undefined);
		assert.strictEqual(metadataCommandTarget(undefined), undefined);
	});

	test('команда над узлом дерева выполняется в проекте дерева, над файлом в проекте файла', () => {
		const subProject = path.join(FIRST, 'src', 'cfe', 'подпроект');
		const extension = path.join(subProject, 'src', 'cfe', 'Расширение');
		const node = new MetadataSourceTreeItem('cfe', 'Расширение', 'extension', path.join(extension, 'Configuration.xml'), extension);
		const file = vscode.Uri.file(path.join(extension, 'Catalogs', 'Товары.xml'));
		const projectOfFile = () => subProject;

		assert.strictEqual(metadataCommandRoot([node], FIRST, projectOfFile), FIRST);
		assert.strictEqual(metadataCommandRoot([undefined, node], FIRST, projectOfFile), FIRST);
		assert.strictEqual(metadataCommandRoot([file], FIRST, projectOfFile), subProject);
		assert.strictEqual(metadataCommandRoot([node], undefined, projectOfFile), subProject);
		assert.strictEqual(metadataCommandRoot(['src/cf'], FIRST, projectOfFile), undefined);
	});

	test('файл расширения подпроекта находится в дереве родителя, конфигурация подпроекта нет', async () => {
		const { provider, internals } = providerShowingFirst();
		const subProject = path.join(FIRST, 'src', 'cfe', 'подпроект');
		const extensionXml = path.join(subProject, 'src', 'cfe', 'Расширение', 'Configuration.xml');
		const source = new MetadataSourceTreeItem('cfe', 'Расширение', 'extension', extensionXml, path.dirname(extensionXml));
		internals._sourceItems = [...internals._sourceItems, source];

		const found = await provider.locateFile(extensionXml, subProject);
		assert.ok(found && 'node' in found);
		assert.strictEqual(found.node, source);
		assert.deepStrictEqual(await provider.locateFile(path.join(subProject, 'src', 'cf', 'Configuration.xml'), subProject), {
			otherProject: subProject,
		});
		assert.strictEqual(await provider.locateFile(path.join(FIRST, 'src', 'cf', 'Catalogs', 'Нет.xml'), FIRST), undefined);
	});

	test('сброс отбора при смене проекта применяется сразу и отменяет отложенное применение', async () => {
		const selections: FilterSelection[] = [];
		const filter = new MetadataFilterViewProvider(
			createMockExtensionContext(),
			{} as MetadataTreeDataProvider,
			(selection) => selections.push(selection)
		);
		(filter as unknown as { onMessage(message: unknown): void }).onMessage({
			type: 'toggle',
			key: path.join(FIRST, 'src', 'cf', 'Subsystems', 'Продажи.xml'),
			checked: true,
		});

		filter.resetForProject();

		assert.strictEqual(selections.length, 1);
		assert.strictEqual(selections[0].checkedPaths.size, 0);
		assert.deepStrictEqual(filter.roots, []);
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.strictEqual(selections.length, 1, 'флажок прежнего проекта не применился после сброса');
	});
});
