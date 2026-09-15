import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { rememberTaskProject } from '../../features/tasks/terminalProjects';
import { VRUNNER_TASK_SOURCE } from '../../features/tasks/vrunnerTask';
import {
	SourceTerminalLinkProvider,
	findTerminalLinkMatches,
	resolveMetadataInRoots,
	resolveTerminalLinkTarget,
} from '../../features/tools/terminalLinks';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { runWithProject, sameProjectRoot } from '../../shared/workspaceProjects';

suite('terminalLinks', () => {
	test('OneScript: путь модуля и номер строки из одного сообщения', () => {
		// Строка из живого прогона vanessa-runner 3
		const line = String.raw`ОШИБКА - {Модуль C:\vr3\src\cli\ПодкомандаValidateSyntaxcheck.os / Ошибка в строке: 188 / Обнаружены ошибки}`;

		const matches = findTerminalLinkMatches(line);

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'file',
			file: String.raw`C:\vr3\src\cli\ПодкомандаValidateSyntaxcheck.os`,
			line: 188,
		});
		assert.strictEqual(line.substr(matches[0].startIndex, matches[0].length).endsWith('.os'), true);
	});

	test('замечание синтаксического контроля: путь по метаданным', () => {
		// Строка из живого прогона: путь и текст замечания идут через пробел
		const line = 'ПРЕДУПРЕЖДЕНИЕ -   HTTPСервис.Биллинг.Модуль Возможно ошибочный метод: "УдалитьЗапись"';

		const matches = findTerminalLinkMatches(line);

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'metadata',
			metadataPath: 'HTTPСервис.Биллинг.Модуль',
			line: undefined,
		});
	});

	test('путь по метаданным с номером строки', () => {
		const matches = findTerminalLinkMatches('Ошибка в ОбщийМодуль.РаботаСФайлами.Модуль(42): переменная не определена');

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'metadata',
			metadataPath: 'ОбщийМодуль.РаботаСФайлами.Модуль',
			line: 42,
		});
	});

	test('форма объекта: пять сегментов пути', () => {
		const matches = findTerminalLinkMatches('Справочник.Валюты.Форма.ФормаЭлемента.Форма проверена');

		assert.strictEqual(matches.length, 1);
		assert.strictEqual(
			(matches[0].target as { metadataPath: string }).metadataPath,
			'Справочник.Валюты.Форма.ФормаЭлемента.Форма'
		);
	});

	test('относительный путь без ./ берётся целиком, а не от внутреннего слэша', () => {
		const line = 'src/cf/CommonModules/Имя/Ext/Module.bsl:12 предупреждение';

		const matches = findTerminalLinkMatches(line);

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'file',
			file: 'src/cf/CommonModules/Имя/Ext/Module.bsl',
			line: 12,
		});
		assert.strictEqual(matches[0].startIndex, 0, 'ссылка начинается с начала пути');
	});

	test('относительный путь к фиче', () => {
		const matches = findTerminalLinkMatches('Выполняю ./features/Справочники/Валюты.feature');

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'file',
			file: './features/Справочники/Валюты.feature',
			line: undefined,
		});
	});

	test('абсолютный путь с номером строки в скобках', () => {
		const line = String.raw`D:\проект\src\cf\CommonModules\Имя\Ext\Module.bsl(7)`;

		const matches = findTerminalLinkMatches(line);

		assert.strictEqual(matches.length, 1);
		assert.deepStrictEqual(matches[0].target, {
			kind: 'file',
			file: String.raw`D:\проект\src\cf\CommonModules\Имя\Ext\Module.bsl`,
			line: 7,
		});
	});

	test('путь внутри записи OneScript не удваивается', () => {
		const line = String.raw`{Модуль C:\lib\cmdline.os / Ошибка в строке: 441 / Неизвестный параметр}`;

		const matches = findTerminalLinkMatches(line);

		assert.strictEqual(matches.length, 1, 'общий разбор путей не должен добавить второй фрагмент');
	});

	test('строка без путей не даёт ссылок', () => {
		assert.deepStrictEqual(findTerminalLinkMatches('ИНФОРМАЦИЯ - Тестирование поведения завершено'), []);
	});
});

suite('terminalLinks: поиск модуля по метаданным', () => {
	const fixtures = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout');
	const designer = { dir: path.join(fixtures, 'designer', 'src', 'cf'), format: 'designer' as const };
	const edt = { dir: path.join(fixtures, 'edt-workspace', 'ssl31'), format: 'edt' as const };

	test('выгрузка конфигуратора: модуль лежит в Ext', async () => {
		const found = await resolveMetadataInRoots('ОбщийМодуль.ОбщийТест.Модуль', [designer]);

		assert.strictEqual(found, path.join(designer.dir, 'CommonModules', 'ОбщийТест', 'Ext', 'Module.bsl'));
	});

	test('EDT: модуль лежит в src без Ext', async () => {
		const found = await resolveMetadataInRoots('ОбщийМодуль.ОбщийТест.Модуль', [edt]);

		assert.strictEqual(found, path.join(edt.dir, 'src', 'CommonModules', 'ОбщийТест', 'Module.bsl'));
	});

	test('EDT: модуль формы объекта', async () => {
		const found = await resolveMetadataInRoots('Справочник.Валюты.Форма.ФормаСписка.Форма', [edt]);

		assert.strictEqual(
			found,
			path.join(edt.dir, 'src', 'Catalogs', 'Валюты', 'Forms', 'ФормаСписка', 'Module.bsl')
		);
	});

	test('две раскладки рядом: берётся тот корень, где файл есть', async () => {
		const found = await resolveMetadataInRoots('Справочник.Валюты.Форма.ФормаСписка.Форма', [designer, edt]);

		assert.strictEqual(found?.startsWith(edt.dir), true, 'в выгрузке конфигуратора такого файла нет');
	});

	test('несуществующий объект не даёт пути', async () => {
		assert.strictEqual(await resolveMetadataInRoots('ОбщийМодуль.НетТакого.Модуль', [designer, edt]), undefined);
	});
});

suite('terminalLinks: проект команды', () => {
	const designer = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout/designer');

	test('ссылка открывает модуль проекта задачи, напечатавшей строку, а не текущего проекта', async () => {
		const provider = new SourceTerminalLinkProvider(VRunnerManager.getInstance());
		const terminal = { name: 'Синтаксический контроль проекта' } as vscode.Terminal;
		rememberTaskProject({ name: terminal.name, source: VRUNNER_TASK_SOURCE }, designer);

		const links = runWithProject(path.resolve('/w/другой'), () =>
			provider.provideTerminalLinks({ line: 'ОбщийМодуль.ОбщийТест.Модуль(3)', terminal })
		);

		assert.strictEqual(links.length, 1);
		assert.strictEqual(links[0].root, designer);
		assert.strictEqual(
			await resolveTerminalLinkTarget(links[0].target, links[0].root),
			path.join(designer, 'src', 'cf', 'CommonModules', 'ОбщийТест', 'Ext', 'Module.bsl')
		);
	});

	test('в терминале без команд расширения ссылка берёт текущий проект', () => {
		const provider = new SourceTerminalLinkProvider(VRunnerManager.getInstance());
		const root = path.resolve('/w/текущий');

		const links = runWithProject(root, () =>
			provider.provideTerminalLinks({ line: 'src/cf/Module.bsl:3', terminal: { name: 'оболочка пользователя' } as vscode.Terminal })
		);

		assert.strictEqual(links.length, 1);
		assert.ok(links[0].root !== undefined && sameProjectRoot(links[0].root, root));
	});
});
