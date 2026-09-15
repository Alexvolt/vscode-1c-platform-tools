import * as assert from 'node:assert';
import * as path from 'node:path';
import { configurationScope } from '../../shared/activeConfiguration';
import { invalidateProjectLayout, setLayoutExclusions } from '../../shared/projectLayout';

const FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures');

/** Две конфигурации в формате EDT в одном корне. */
const EDT_WORKSPACE = path.join(FIXTURES, 'projectLayout', 'edt-workspace');

/** Проекты с подпроектом и лишними конфигурациями. */
const PROJECTS = path.join(FIXTURES, 'workspaceProjects');

suite('область проекта', () => {
	setup(() => {
		setLayoutExclusions(() => []);
		invalidateProjectLayout();
	});

	test('конфигурация проекта первая найденная, расширения все, остальные конфигурации лишние', async () => {
		const scope = await configurationScope(EDT_WORKSPACE);

		assert.strictEqual(scope.configuration?.name, 'БиблиотекаСтандартныхПодсистемДемо');
		assert.deepStrictEqual(scope.extensions.map((root) => root.name), ['_ДемоРасширение', 'РасширениеУчёта']);
		assert.deepStrictEqual(scope.testExtensions.map((root) => root.name), ['Тесты']);
		assert.deepStrictEqual(scope.extraConfigurations.map((root) => root.name), ['УчётДемо']);
	});

	test('из подпроекта в область родителя входят только расширения', async () => {
		const parent = await configurationScope(path.join(PROJECTS, 'проект'));
		const child = await configurationScope(path.join(PROJECTS, 'проект', 'src', 'cfe', 'подпроект'));

		assert.strictEqual(parent.configuration?.name, 'Основная');
		assert.deepStrictEqual(parent.extensions.map((root) => root.name), ['РасширениеПодпроекта']);
		assert.deepStrictEqual(parent.extraConfigurations, []);
		assert.strictEqual(child.configuration?.name, 'Подпроект');
		assert.deepStrictEqual(child.extensions.map((root) => root.name), ['РасширениеПодпроекта']);
	});

	test('репозиторий расширения с packagedef принадлежит проекту, тестовые расширения подпроекта нет', async () => {
		const retail = await configurationScope(path.join(PROJECTS, 'розница'));

		assert.strictEqual(retail.configuration?.name, 'Розница');
		assert.deepStrictEqual(retail.extensions.map((root) => root.name), [
			'Адаптер',
			'Доработки',
			'МенеджерПакетов',
			'КлиентМетрик',
			'ЭкспортМетрик',
		]);
		assert.deepStrictEqual(retail.testExtensions, []);
		assert.deepStrictEqual(retail.extraConfigurations, []);
	});

	test('без исходного кода конфигурации нет', async () => {
		const scope = await configurationScope(path.join(PROJECTS, 'пустая'));

		assert.strictEqual(scope.configuration, undefined);
		assert.deepStrictEqual(scope.extraConfigurations, []);
	});
});
