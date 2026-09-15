import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildEdtArgs,
	edtStagingRoot,
	edtWorkspaceDir,
	explainEdtFailure,
	type EdtSettings,
} from '../../features/edt/edtRunner';

/** Настройки по умолчанию для сборки вызова. */
function settings(overrides: Partial<EdtSettings> = {}): EdtSettings {
	return { path: '', version: '', workspace: '', timeoutSeconds: 3600, vmargs: [], ...overrides };
}

suite('запуск команд EDT', () => {
	test('рабочая область и общие параметры идут до -command', () => {
		const args = buildEdtArgs(
			{
				command: 'validate',
				args: ['--project-list', 'ssl31'],
				title: 'Проверить проект EDT',
				workspaceDir: 'C:/проект/build/edt-workspace',
				cwd: 'C:/проект',
			},
			settings()
		);

		assert.deepStrictEqual(args, [
			'-data',
			'C:/проект/build/edt-workspace',
			'-timeout',
			'3600',
			'-command',
			'validate',
			'--project-list',
			'ssl31',
		]);
	});

	test('каждый аргумент JVM передаётся своим -vmargs', () => {
		const args = buildEdtArgs(
			{ command: 'build', args: [], title: 'Сборка', workspaceDir: 'ws', cwd: '.' },
			settings({ vmargs: ['-Xmx8g', '-Dfile.encoding=UTF-8'] })
		);

		assert.deepStrictEqual(args.slice(4, 8), ['-vmargs', '-Xmx8g', '-vmargs', '-Dfile.encoding=UTF-8']);
		assert.strictEqual(args[8], '-command');
	});

	test('таймаут берётся из настроек', () => {
		const args = buildEdtArgs(
			{ command: 'export', args: [], title: 'Выгрузка', workspaceDir: 'ws', cwd: '.' },
			settings({ timeoutSeconds: 7200 })
		);

		assert.strictEqual(args[args.indexOf('-timeout') + 1], '7200');
	});

	test('рабочая область по умолчанию лежит в каталоге сборки', () => {
		const dir = edtWorkspaceDir('C:/проект', 'build', settings());

		assert.strictEqual(dir, path.join('C:/проект', 'build', 'edt-workspace'));
	});

	test('у проекта EDT, открытого как рабочая область, рабочая область во временном каталоге', () => {
		const project = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/edt-workspace/ssl31');

		const dir = edtWorkspaceDir(project, 'build', settings());

		assert.ok(dir.startsWith(os.tmpdir()), dir);
		assert.ok(!dir.startsWith(project), dir);
		assert.strictEqual(path.basename(dir), 'edt-workspace');
		assert.ok(path.basename(path.dirname(dir)).startsWith('ssl31-'), dir);
		assert.strictEqual(edtStagingRoot(project, 'build'), path.dirname(dir));
		assert.strictEqual(edtStagingRoot('C:/проект', 'build'), 'build');
	});

	test('настроенная рабочая область может быть относительной и абсолютной', () => {
		// Абсолютный путь берётся от корня текущей системы: на Linux «D:/ws» не абсолютен
		const absolute = path.join(path.parse(process.cwd()).root, 'едт-рабочая-область');

		assert.strictEqual(
			edtWorkspaceDir('C:/проект', 'build', settings({ workspace: 'едт' })),
			path.join('C:/проект', 'едт')
		);
		assert.strictEqual(edtWorkspaceDir('C:/проект', 'build', settings({ workspace: absolute })), absolute);
	});
});

suite('причина неудачной команды 1cedtcli', () => {
	// Строки вывода 1С:EDT 2026.1
	test('занятая рабочая область', () => {
		const output =
			"Не удалось запустить 1C:EDT CLI по причине того, что рабочая область 'C:\\проект\\build\\edt-workspace' уже используется другим приложением.";

		assert.ok(explainEdtFailure(output)?.includes('Рабочая область 1С:EDT занята'));
		assert.ok(
			explainEdtFailure(
				"Could not launch 1C:EDT CLI because the associated workspace 'C:\\ws' is currently in use by another application."
			)?.includes('занята')
		);
	});

	test('проект уже подключён или его нет', () => {
		assert.strictEqual(
			explainEdtFailure('edtsh: Проект с именем ext-edt уже существует в рабочей области'),
			'Проект ext-edt уже подключён к рабочей области 1С:EDT.'
		);
		assert.strictEqual(
			explainEdtFailure('Project not found: НетТакогоПроекта\n'),
			'Проекта НетТакогоПроекта нет в рабочей области 1С:EDT.'
		);
	});

	test('нераспознанный вывод не объясняется', () => {
		assert.strictEqual(explainEdtFailure('java.lang.OutOfMemoryError: Java heap space'), undefined);
	});
});
