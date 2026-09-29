import * as assert from 'node:assert';
import { showsLaunchStatus } from '../../features/launch/launchStatusScope';

suite('строка состояния: профиль и сервер', () => {
	test('видны у проекта 1С, пока открытый файл не лежит вне проектов или в проекте OneScript', () => {
		const onec = { kind: 'designer' as const };
		const onescript = { kind: 'onescript' as const };

		assert.strictEqual(showsLaunchStatus(onec, false, 'none'), true);
		assert.strictEqual(showsLaunchStatus({ kind: 'onec' }, false, 'none'), true);
		assert.strictEqual(showsLaunchStatus(onec, false, { kind: 'edt' }), true);
		assert.strictEqual(showsLaunchStatus(onec, false, {}), true);
		assert.strictEqual(showsLaunchStatus(onec, true, 'outside'), false);
		assert.strictEqual(showsLaunchStatus(onec, true, onescript), false);
		assert.strictEqual(showsLaunchStatus(onescript, true, 'none'), false);
		assert.strictEqual(showsLaunchStatus(undefined, true, 'none'), false);
	});

	test('пока вид проекта не известен, решает файл настроек', () => {
		assert.strictEqual(showsLaunchStatus({}, true, 'none'), true);
		assert.strictEqual(showsLaunchStatus({}, false, 'none'), false);
	});
});
