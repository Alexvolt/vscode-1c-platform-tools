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

	test('база нужна командам, которые её открывают', () => {
		const kinds = [
			'cf.loadFromSrc', 'cf.dumpIbToSrc', 'cfe.loadFromSrc', 'infobase.updateDb',
			'infobase.listExtensions', 'cfe.decompileCfeFile', 'epf.build', 'epf.decompile',
			'run.designer', 'run.enterprise', 'test.vanessa', 'test.xunit', 'validate.syntaxCheck',
		] as const;
		for (const kind of kinds) {
			assert.ok(needsExclusiveInfobase(kind), `${kind} должен требовать базу`);
		}
	});

	test('сборке и разбору файлов база не нужна', () => {
		for (const kind of ['cf.build', 'cf.decompileFile', 'cfe.buildCfe', 'session.lock'] as const) {
			assert.ok(!needsExclusiveInfobase(kind), `${kind} обходится без базы`);
		}
	});

	test('запуск без ожидания оставляет базу занятой', () => {
		assert.ok(keepsInfobaseAfterRun([{ kind: 'run.designer', noWait: true }]));
		assert.ok(!keepsInfobaseAfterRun([{ kind: 'run.designer', additional: '/DumpIB' }]));
		assert.ok(!keepsInfobaseAfterRun([{ kind: 'infobase.updateDb' }]));
	});

	test('цепочка требует базу, если её требует хоть один шаг', () => {
		assert.ok(anyNeedsExclusiveInfobase([{ kind: 'cf.build', src: 'src/cf', out: 'build' }, { kind: 'infobase.updateDb' }]));
		assert.ok(!anyNeedsExclusiveInfobase([{ kind: 'cf.build', src: 'src/cf', out: 'build' }]));
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
