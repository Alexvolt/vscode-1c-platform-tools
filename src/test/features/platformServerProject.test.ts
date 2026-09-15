import * as assert from 'node:assert';
import * as path from 'node:path';
import {
	PlatformServerManager,
	serverProjectSwitchQuestion,
	type PublicationSelection,
} from '../../features/launch/platformServerManager';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { projectMemento, SERVER_PUBLICATION_STATE } from '../../shared/projectState';
import { createMockExtensionContext } from '../fixtures/mocks/vscodeMocks';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'workspaceProjects');
const FIRST = path.join(FIXTURES, 'проект');
const SECOND = path.join(FIXTURES, 'две-конфигурации');

suite('автономный сервер в проектах', () => {
	let manager: PlatformServerManager;

	suiteSetup(() => {
		manager = new PlatformServerManager(VRunnerManager.getInstance(), createMockExtensionContext(FIRST));
	});

	suiteTeardown(async () => {
		await projectMemento(FIRST).update(SERVER_PUBLICATION_STATE, undefined);
	});

	test('запуск для другого проекта спрашивает про сервер прежнего', () => {
		assert.strictEqual(
			serverProjectSwitchQuestion('X', 'Y'),
			'Автономный сервер проекта X запущен. Остановить его и запустить для Y?'
		);
	});

	test('выбор публикации у каждого проекта свой', async () => {
		const selection: PublicationSelection = { odata: false, webAll: false, web: ['Обмен'], httpAll: true, http: [] };
		await projectMemento(FIRST).update(SERVER_PUBLICATION_STATE, selection);

		assert.deepStrictEqual(manager.getPublicationSelection(FIRST), selection);
		assert.deepStrictEqual(manager.getPublicationSelection(SECOND), {
			odata: true,
			webAll: true,
			web: [],
			httpAll: true,
			http: [],
		});
	});

	test('остановленный сервер не принадлежит проекту и базу не держит', () => {
		assert.strictEqual(manager.state, 'stopped');
		assert.strictEqual(manager.ownerRoot, undefined);
		assert.strictEqual(manager.infobaseHolder().heldInfobase(), undefined);
	});
});
