import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { MetadataTreeDataProvider } from '../../features/metadata/metadataTreeView';
import { registerMetadataPaletteSource } from '../../features/properties/metadataPaletteSource';
import { PropertyPaletteViewProvider } from '../../features/properties/propertyPaletteView';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';

suite('палитра свойств: смена проекта', () => {
	test('смена проекта гасит свойства любого источника', () => {
		const context = createMockExtensionContext();
		const palette = new PropertyPaletteViewProvider(context.extensionUri);
		const selection = new vscode.EventEmitter<vscode.TreeViewSelectionChangeEvent<vscode.TreeItem>>();
		const projectChanges = new vscode.EventEmitter<unknown>();
		const disposables = registerMetadataPaletteSource({
			context,
			metadataTreeProvider: {} as MetadataTreeDataProvider,
			metadataTreeView: { selection: [], onDidChangeSelection: selection.event } as unknown as vscode.TreeView<vscode.TreeItem>,
			propertyPaletteProvider: palette,
			projectChanges: projectChanges.event,
		});
		try {
			palette.show('C:/ws/src/cf/Catalogs/Валюты/Forms/ФормаЭлемента/Ext/Form.xml', { title: 'Наименование', groups: [] });
			assert.ok(palette.owner);

			projectChanges.fire(undefined);

			assert.strictEqual(palette.owner, undefined);
		} finally {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			selection.dispose();
			projectChanges.dispose();
		}
	});

	test('гашение по источнику не трогает чужие свойства', () => {
		const palette = new PropertyPaletteViewProvider(createMockExtensionContext().extensionUri);
		palette.show('форма', { title: 'Наименование', groups: [] });

		palette.clear('metadataTree');
		assert.strictEqual(palette.owner, 'форма');

		palette.reset();
		assert.strictEqual(palette.owner, undefined);
	});
});
