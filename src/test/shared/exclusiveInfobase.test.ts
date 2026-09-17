import * as assert from 'node:assert';
import * as path from 'node:path';
import {
	anyNeedsExclusiveInfobase,
	exclusiveInfobaseLogLine,
	infobaseHolder,
	keepsInfobaseAfterRun,
	needsExclusiveInfobase,
	registerInfobaseHolder,
	type InfobaseHolder,
} from '../../shared/exclusiveInfobase';

/** Держатель, который занимает указанную базу. */
function holderOf(label: string, infobase: string | undefined): InfobaseHolder {
	return {
		label,
		heldInfobase: () => infobase,
		release: async () => true,
		restore: async () => undefined,
	};
}

suite('монопольный доступ к информационной базе', () => {
	const registrations: { dispose(): void }[] = [];

	teardown(() => {
		for (const registration of registrations.splice(0)) {
			registration.dispose();
		}
	});

	const runs = [
		{ cli3: false, connectionSet: false },
		{ cli3: false, connectionSet: true },
		{ cli3: true, connectionSet: false },
		{ cli3: true, connectionSet: true },
	];
	const cli3 = { cli3: true, connectionSet: true };

	test('база нужна командам, которые её открывают', () => {
		const kinds = [
			'cf.loadFromSrc', 'cf.dumpIbToSrc', 'cfe.loadFromSrc', 'infobase.updateDb',
			'infobase.listExtensions', 'run.designer', 'run.enterprise', 'test.vanessa', 'test.xunit',
			'validate.syntaxCheck',
		] as const;
		for (const kind of kinds) {
			for (const run of runs) {
				assert.ok(needsExclusiveInfobase(kind, run), `${kind} должен требовать базу: ${JSON.stringify(run)}`);
			}
		}
	});

	test('сборка и разборка файлов берут базу, только когда задана строка подключения', () => {
		const kinds = ['cf.build', 'cf.decompileFile', 'cfe.buildCfe', 'cfe.decompileCfeFile', 'epf.build', 'epf.decompile'] as const;
		for (const kind of kinds) {
			assert.ok(needsExclusiveInfobase(kind, { cli3: true, connectionSet: true }), `${kind} в заданной базе`);
			assert.ok(!needsExclusiveInfobase(kind, { cli3: true, connectionSet: false }), `${kind} во временной базе`);
		}
	});

	test('CLI 2.x собирает cf и cfe во временной базе, а cfe-файл разбирает через базу проекта', () => {
		for (const connectionSet of [false, true]) {
			for (const kind of ['cf.build', 'cf.decompileFile', 'cfe.buildCfe'] as const) {
				assert.ok(!needsExclusiveInfobase(kind, { cli3: false, connectionSet }), `${kind} во временной базе`);
			}
			assert.ok(needsExclusiveInfobase('cfe.decompileCfeFile', { cli3: false, connectionSet }));
			assert.strictEqual(needsExclusiveInfobase('epf.build', { cli3: false, connectionSet }), connectionSet);
		}
	});

	test('командам кластера файловая база не нужна', () => {
		for (const kind of ['session.lock', 'session.kill', 'jobs.lock'] as const) {
			for (const run of runs) {
				assert.ok(!needsExclusiveInfobase(kind, run), `${kind} обходится без базы`);
			}
		}
	});

	test('запуск без ожидания оставляет базу занятой', () => {
		assert.ok(keepsInfobaseAfterRun([{ kind: 'run.designer', noWait: true }]));
		assert.ok(!keepsInfobaseAfterRun([{ kind: 'run.designer', additional: '/DumpIB' }]));
		assert.ok(!keepsInfobaseAfterRun([{ kind: 'infobase.updateDb' }]));
	});

	test('цепочка требует базу, если её требует хоть один шаг', () => {
		assert.ok(anyNeedsExclusiveInfobase([{ kind: 'session.lock' }, { kind: 'infobase.updateDb' }], cli3));
		assert.ok(!anyNeedsExclusiveInfobase([{ kind: 'session.lock' }, { kind: 'jobs.lock' }], cli3));
	});

	test('держатель находится по абсолютному пути своей базы', () => {
		const first = path.resolve('/w/первый/build/ib');
		const second = path.resolve('/w/второй/build/ib');
		const server = holderOf('Сервер первого', first);
		registrations.push(registerInfobaseHolder(server));

		assert.strictEqual(infobaseHolder(first), server);
		assert.strictEqual(infobaseHolder(path.join(first, '.')), server);
		assert.strictEqual(infobaseHolder(second), undefined, 'база другого проекта не занята');
	});

	test('на Windows путь базы сравнивается без учёта регистра', function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const infobase = path.resolve('/w/Проект/build/ib');
		const server = holderOf('Сервер', infobase);
		registrations.push(registerInfobaseHolder(server));

		assert.strictEqual(infobaseHolder(infobase.toUpperCase()), server);
	});

	test('держатель без базы и снятый с регистрации базу не держит', () => {
		const infobase = path.resolve('/w/проект/build/ib');
		registrations.push(registerInfobaseHolder(holderOf('Остановлен', undefined)));
		const registration = registerInfobaseHolder(holderOf('Запущен', infobase));

		assert.strictEqual(infobaseHolder(infobase)?.label, 'Запущен');
		registration.dispose();
		assert.strictEqual(infobaseHolder(infobase), undefined);
	});

	test('строка журнала называет проект, профиль и базу', () => {
		assert.strictEqual(
			exclusiveInfobaseLogLine('X', 'env.json', '/F./build/ib'),
			'Проект: X, профиль: env.json, база: /F./build/ib'
		);
	});
});
