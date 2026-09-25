import * as assert from 'node:assert';
import { attachesToServer } from '../../features/launch/serverDebugSessions';
import { DEBUG_TYPE } from '../../features/debug/debugConstants';

suite('отладка через автономный сервер', () => {
	const attach = { type: DEBUG_TYPE, request: 'attach', name: 'a', debugServerHost: '127.0.0.1', debugServerPort: 1550 };

	test('подключение к порту отладки сервера относится к серверу', () => {
		assert.ok(attachesToServer(attach, 1550));
		assert.ok(attachesToServer({ ...attach, debugServerHost: 'localhost' }, 1550));
	});

	test('сервер отладки на другой машине с тем же портом к серверу не относится', () => {
		assert.ok(!attachesToServer({ ...attach, debugServerHost: 'srv-1c' }, 1550));
	});

	test('сервер без отладки сессий не держит', () => {
		assert.ok(!attachesToServer(attach, undefined));
	});

	test('запуск клиента и другой порт к серверу не относятся', () => {
		assert.ok(!attachesToServer({ ...attach, request: 'launch' }, 1550));
		assert.ok(!attachesToServer({ ...attach, debugServerPort: 1650 }, 1550));
		assert.ok(!attachesToServer({ ...attach, type: 'node' }, 1550));
	});
});
