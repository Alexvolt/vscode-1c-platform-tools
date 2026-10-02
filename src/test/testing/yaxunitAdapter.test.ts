import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { VRunnerManager } from '../../shared/vrunnerManager';
import { YaxunitAdapter, extractModuleName, procedureCase } from '../../features/testing/adapters/yaxunitAdapter';
import { parseJUnitXml, type JUnitCase } from '../../features/testing/parsers/junitParser';
import { fixturePath } from '../fixtures/helpers/fixturePath';

import { invalidateProjectLayout } from '../../shared/projectLayout';

/** Рабочие области с исходным кодом в обоих форматах. */
const FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/projectLayout');
const DESIGNER_WORKSPACE = path.join(FIXTURES, 'designer');
const EDT_WORKSPACE = path.join(FIXTURES, 'edt-workspace');

/** Раннер, знающий только корень рабочей области: остальное адаптер берёт из раскладки. */
function vrunnerAt(workspaceRoot: string): VRunnerManager {
	return {
		getWorkspaceRoot: () => workspaceRoot,
		readActiveSettings: async () => ({ settings: {}, schema: 'v2' }),
		planIntent: async () => [['run', 'enterprise']],
		runnerPath: async (hostPath: string) => hostPath,
	} as unknown as VRunnerManager;
}

/** Положение модуля в дереве по пути внутри рабочей области. */
function locate(adapter: YaxunitAdapter, workspaceRoot: string, ...segments: string[]) {
	return adapter.describeFileLocation(vscode.Uri.file(path.join(workspaceRoot, ...segments)), workspaceRoot);
}

suite('yaxunitAdapter', () => {
	test('isTestFile: служебный модуль фреймворка (без зарегистрированных тестов) отсекается', async () => {
		const adapter = new YaxunitAdapter(VRunnerManager.getInstance());
		// Похоже на ЮТТестыСлужебный: есть ИсполняемыеСценарии и текст «ДобавитьТест(»,
		// но нет ни одной регистрации .ДобавитьТест("Имя") — это плумбинг, не тесты
		const serviceModule = [
			'Процедура ДобавитьТест(Знач НаборТестов, Знач ИмяТеста) Экспорт',
			'\tНаборТестов.Тесты.Добавить(ИмяТеста);',
			'КонецПроцедуры',
			'',
			'Функция ИсполняемыеСценарии() Экспорт',
			'\tВозврат Неопределено;',
			'КонецФункции'
		].join('\n');
		assert.strictEqual(adapter.isTestFile(serviceModule), false);
	});

	test('isTestFile: модуль с .ДобавитьТест("...") распознаётся тестовым', async () => {
		const adapter = new YaxunitAdapter(VRunnerManager.getInstance());
		const testModule = [
			'Процедура ИсполняемыеСценарии() Экспорт',
			'\tЮТТесты.ДобавитьТест("ПроверитьЗапись");',
			'КонецПроцедуры',
			'',
			'Процедура ПроверитьЗапись() Экспорт',
			'КонецПроцедуры'
		].join('\n');
		assert.strictEqual(adapter.isTestFile(testModule), true);
	});

	test('extractModuleName извлекает имя модуля из пути', () => {
		assert.strictEqual(
			extractModuleName('C:\\proj\\src\\cfe\\Тесты\\CommonModules\\ОМ_ПроверкаЗаписи\\Module.bsl'),
			'ОМ_ПроверкаЗаписи'
		);
		assert.strictEqual(
			extractModuleName('/proj/src/cfe/Tests/CommonModules/ТестыСложения/Module.bsl'),
			'ТестыСложения'
		);
	});

	test('без готового конфига на 3.x отчёт прогона уходит в report-path', async () => {
		invalidateProjectLayout();
		const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaxunit-report-'));
		const ownReport = path.join(reportDir, 'report.xml');
		const fileUri = vscode.Uri.file(
			path.join(DESIGNER_WORKSPACE, 'tests', 'cfe', 'Тесты', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl')
		);
		let report: string | undefined;
		const vrunner = {
			getWorkspaceRoot: () => DESIGNER_WORKSPACE,
			readActiveSettings: async () => ({
				settings: {
					vrunner: { test: { yaxunit: { 'report-path': 'build/out/yaxunit/junit.xml' } } },
				},
				schema: 'v3' as const,
			}),
			planIntent: async (intent: { report?: string }) => {
				report = intent.report;
				return [['test', 'yaxunit']];
			},
			runnerPath: async (hostPath: string) => hostPath,
		} as unknown as VRunnerManager;
		const adapter = new YaxunitAdapter(vrunner);
		try {
			const plan = await adapter.buildRunPlan({ fileUri }, reportDir);
			assert.strictEqual(report, ownReport);
			assert.strictEqual(plan.reportTarget?.path, ownReport);
		} finally {
			await fs.rm(reportDir, { recursive: true, force: true });
		}
	});

	test('buildRunPlan: весь модуль — filter.modules, подмножество — filter.tests', async () => {
		const adapter = new YaxunitAdapter(VRunnerManager.getInstance());
		const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaxunit-test-'));
		const fileUri = vscode.Uri.file('C:\\proj\\src\\cfe\\T\\CommonModules\\ОМ_Тесты\\Module.bsl');

		try {
			const fullPlan = await adapter.buildRunPlan({ fileUri }, reportDir);
			assert.strictEqual(fullPlan.tool, 'vrunner');
			assert.strictEqual(fullPlan.args[0], 'test');
			assert.strictEqual(fullPlan.args[1], 'yaxunit');
			assert.strictEqual(fullPlan.args[fullPlan.args.indexOf('--modules') + 1], 'ОМ_Тесты');
			assert.ok(fullPlan.reportTarget, 'Должна быть цель отчёта');
			assert.strictEqual(fullPlan.reportTarget.format, 'junit');

			const subsetPlan = await adapter.buildRunPlan(
				{ fileUri, caseNames: ['ПроверитьЗапись'] },
				reportDir
			);
			assert.strictEqual(
				subsetPlan.args[subsetPlan.args.indexOf('--tests') + 1],
				'ОМ_Тесты.ПроверитьЗапись'
			);
			assert.strictEqual(subsetPlan.args.includes('--modules'), false);
		} finally {
			await fs.rm(reportDir, { recursive: true, force: true });
		}
	});


	test('buildRunPlan: фильтр по имени расширения из раскладки, а не по списку из конфига проекта', async () => {
		invalidateProjectLayout();
		const adapter = new YaxunitAdapter(vrunnerAt(DESIGNER_WORKSPACE));
		const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaxunit-ext-'));
		// имя расширения в метаданных отличается от имени каталога
		const fileUri = vscode.Uri.file(
			path.join(DESIGNER_WORKSPACE, 'tests', 'cfe', 'Тесты', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl')
		);

		try {
			await adapter.buildRunPlan({ fileUri }, reportDir);
			const config = JSON.parse(await fs.readFile(path.join(reportDir, 'yaxunit-config.json'), 'utf8'));
			// без этого прогон модуля из другого расширения отфильтровался бы
			// списком extensions из tools/yaxunit.json и дал пустой отчёт
			assert.deepStrictEqual(config.filter.extensions, ['Тесты']);
			assert.deepStrictEqual(config.filter.modules, ['ОМ_Тест']);
		} finally {
			await fs.rm(reportDir, { recursive: true, force: true });
		}
	});

	test('buildRunPlan: у проекта EDT имя расширения берётся из проекта, а не из каталога src', async () => {
		invalidateProjectLayout();
		const adapter = new YaxunitAdapter(vrunnerAt(EDT_WORKSPACE));
		const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaxunit-edt-'));
		const fileUri = vscode.Uri.file(
			path.join(EDT_WORKSPACE, 'tests', 'cfe', 'yaxunit-test', 'src', 'CommonModules', 'ОМ_Тест', 'Module.bsl')
		);

		try {
			await adapter.buildRunPlan({ fileUri }, reportDir);
			const config = JSON.parse(await fs.readFile(path.join(reportDir, 'yaxunit-config.json'), 'utf8'));
			assert.deepStrictEqual(config.filter.extensions, ['Тесты']);
		} finally {
			await fs.rm(reportDir, { recursive: true, force: true });
		}
	});

	test('поиск идёт и по расширениям решения, и по тестовым', async () => {
		invalidateProjectLayout();
		const adapter = new YaxunitAdapter(vrunnerAt(DESIGNER_WORKSPACE));

		const globs = await adapter.getIncludeGlobs();

		// расширение с тестами держат отдельно от поставки: без второго корня
		// панель тестирования перестала бы видеть тесты после переноса
		assert.deepStrictEqual(globs, [
			'src/cfe/МоёРасширение/CommonModules/*/Ext/Module.bsl',
			'src/cfe/подмодуль/src/cfe/Вложенное/CommonModules/*/Ext/Module.bsl',
			'tests/cfe/Тесты/CommonModules/*/Ext/Module.bsl',
		]);
	});
});

suite('yaxunitAdapter: раскладка EDT', () => {
	setup(() => {
		invalidateProjectLayout();
	});

	test('модули ищутся в проекте конфигурации, в расширениях проекта и в тестовых проектах', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(EDT_WORKSPACE));

		const globs = await adapter.getIncludeGlobs();

		assert.deepStrictEqual(globs, [
			'ssl31/src/CommonModules/*/Module.bsl',
			'ssl31._ДемоРасширение/src/CommonModules/*/Module.bsl',
			'учёт.РасширениеУчёта/src/CommonModules/*/Module.bsl',
			'tests/cfe/yaxunit-test/src/CommonModules/*/Module.bsl',
		]);
	});

	test('в дереве модули группируются по проекту, а не по каталогу src', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(EDT_WORKSPACE));
		await adapter.getIncludeGlobs();

		assert.deepStrictEqual(locate(adapter, EDT_WORKSPACE, 'ssl31', 'src', 'CommonModules', 'ОбщийТест', 'Module.bsl'), {
			segments: ['БиблиотекаСтандартныхПодсистемДемо'],
			label: 'ОбщийТест',
		});
		assert.deepStrictEqual(
			locate(adapter, EDT_WORKSPACE, 'ssl31._ДемоРасширение', 'src', 'CommonModules', 'ОМ_Тест', 'Module.bsl').segments,
			['_ДемоРасширение']
		);
		assert.deepStrictEqual(
			locate(adapter, EDT_WORKSPACE, 'tests', 'cfe', 'yaxunit-test', 'src', 'CommonModules', 'ОМ_Тест', 'Module.bsl').segments,
			['Тесты']
		);
	});

	test('у выгрузки конфигуратора группа тоже имя расширения из метаданных', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(DESIGNER_WORKSPACE));
		await adapter.getIncludeGlobs();

		// имя расширения в метаданных отличается от имени каталога
		assert.deepStrictEqual(
			locate(adapter, DESIGNER_WORKSPACE, 'src', 'cfe', 'МоёРасширение', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl').segments,
			['Расширение']
		);
		assert.deepStrictEqual(
			locate(adapter, DESIGNER_WORKSPACE, 'tests', 'cfe', 'Тесты', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl').segments,
			['Тесты']
		);
	});

	test('модуль вне корней раскладки группируется по каталогу перед CommonModules', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(DESIGNER_WORKSPACE));
		await adapter.getIncludeGlobs();

		assert.deepStrictEqual(
			locate(adapter, DESIGNER_WORKSPACE, 'чужое', 'Другое', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl').segments,
			['Другое']
		);
	});

	test('модуль назван для отчёта с расширением из метаданных', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(DESIGNER_WORKSPACE));
		await adapter.getIncludeGlobs();
		const content = await fs.readFile(fixturePath('yaxunit', 'TestPresentation.bsl'), 'utf8');
		const label = (...segments: string[]) =>
			adapter.parseFile(content, vscode.Uri.file(path.join(DESIGNER_WORKSPACE, ...segments)))?.label;

		assert.strictEqual(label('tests', 'cfe', 'Тесты', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl'), 'Тесты.ОМ_Тест');
		// имя расширения в метаданных отличается от имени каталога
		assert.strictEqual(
			label('src', 'cfe', 'МоёРасширение', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl'),
			'Расширение.ОМ_Тест'
		);
		assert.strictEqual(label('чужое', 'Другое', 'CommonModules', 'ОМ_Тест', 'Ext', 'Module.bsl'), 'ОМ_Тест');
	});

	test('у проекта EDT модуль назван с расширением проекта, у конфигурации - без расширения', async () => {
		const adapter = new YaxunitAdapter(vrunnerAt(EDT_WORKSPACE));
		await adapter.getIncludeGlobs();
		const content = await fs.readFile(fixturePath('yaxunit', 'TestPresentation.bsl'), 'utf8');
		const label = (...segments: string[]) =>
			adapter.parseFile(content, vscode.Uri.file(path.join(EDT_WORKSPACE, ...segments)))?.label;

		assert.strictEqual(label('tests', 'cfe', 'yaxunit-test', 'src', 'CommonModules', 'ОМ_Тест', 'Module.bsl'), 'Тесты.ОМ_Тест');
		assert.strictEqual(label('ssl31', 'src', 'CommonModules', 'ОбщийТест', 'Module.bsl'), 'ОбщийТест');
	});
});

suite('yaxunitAdapter: testcase отчёта', () => {
	/** testcase отчёта из фикстуры. */
	async function reportCases(name: string): Promise<JUnitCase[]> {
		return parseJUnitXml(await fs.readFile(fixturePath('yaxunit', 'reports', name), 'utf8'));
	}

	test('тест с описанием назван процедурой из classname, модуль - с расширением', async () => {
		const cases = (await reportCases('test-presentation.xml')).map(procedureCase);
		assert.deepStrictEqual(cases.map((testCase) => [testCase.className, testCase.name]), [
			['YAXUNIT.Док_АктыВыполненныхРабот', 'АктВыполненныхРабот_Корректный'],
			['YAXUNIT.Док_АктыВыполненныхРабот', 'АктВыполненныхРабот_ОшибкаПроведения'],
		]);
	});

	test('у теста без описания меняется только модуль, подробности падения сохраняются', async () => {
		const failed = (await reportCases('ssl31.xml')).find((testCase) => testCase.status === 'failed');
		assert.ok(failed);
		assert.deepStrictEqual(procedureCase(failed), { ...failed, className: 'Тесты.ОМ_Тест_ПримерыПадений' });
	});

	test('без package модуль остаётся без расширения', async () => {
		const [testCase] = await reportCases('test-presentation.xml');
		assert.strictEqual(procedureCase({ ...testCase, suitePackage: undefined }).className, 'Док_АктыВыполненныхРабот');
	});

	test('classname без процедуры не меняется', async () => {
		const [testCase] = await reportCases('test-presentation.xml');
		const moduleOnly = { ...testCase, className: 'Док_АктыВыполненныхРабот' };
		assert.strictEqual(procedureCase(moduleOnly), moduleOnly);
	});
});
