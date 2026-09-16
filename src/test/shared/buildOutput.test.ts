import * as assert from 'node:assert';
import {
	buildOutputVariables,
	hasBuildOutput,
	resolveBuildOutputs,
	type BuildOutputTarget,
} from '../../shared/buildOutput';

const configuration: BuildOutputTarget = {
	label: 'конфигурации',
	type: 'cf',
	directory: 'build/out',
	name: '1Cv8',
	variables: { name: 'БСП', folder: 'cf', version: '3.1.10.1' },
};

function extension(name: string, folder: string, version?: string): BuildOutputTarget {
	return {
		label: `расширения «${name}»`,
		type: 'cfe',
		directory: 'build/out/cfe',
		name: folder,
		variables: { name, folder, version },
	};
}

function files(targets: BuildOutputTarget[], options: Record<string, unknown>): string[] {
	const resolved = resolveBuildOutputs(targets, options);
	assert.ok('files' in resolved, 'error' in resolved ? resolved.error : '');
	return resolved.files;
}

function error(targets: BuildOutputTarget[], options: Record<string, unknown>): string {
	const resolved = resolveBuildOutputs(targets, options);
	assert.ok('error' in resolved, `ожидалась ошибка, получено ${JSON.stringify(resolved)}`);
	return resolved.error;
}

suite('buildOutput', () => {
	test('hasBuildOutput: пустые строки параметрами не считаются', () => {
		assert.strictEqual(hasBuildOutput(undefined), false);
		assert.strictEqual(hasBuildOutput({}), false);
		assert.strictEqual(hasBuildOutput({ outputDirectory: '  ', outputName: '' }), false);
		assert.strictEqual(hasBuildOutput({ outputName: 'ssl' }), true);
		assert.strictEqual(hasBuildOutput({ outputDirectory: 42 }), true);
	});

	test('без параметров каждый объект получает путь по умолчанию', () => {
		assert.deepStrictEqual(
			files([configuration, extension('Первое', 'first'), extension('Второе', 'second')], {}),
			['build/out/1Cv8.cf', 'build/out/cfe/first.cfe', 'build/out/cfe/second.cfe']
		);
	});

	test('каталог и имя задаются отдельно, расширение файла ставится по типу', () => {
		assert.deepStrictEqual(files([configuration], { outputDirectory: 'build/release', outputName: 'ssl' }), [
			'build/release/ssl.cf',
		]);
		assert.deepStrictEqual(files([configuration], { outputName: 'ssl' }), ['build/out/ssl.cf']);
		assert.deepStrictEqual(files([configuration], { outputDirectory: 'dist' }), ['dist/1Cv8.cf']);
	});

	test('расширение файла в имени не удваивается', () => {
		assert.deepStrictEqual(files([configuration], { outputName: 'ssl.CF' }), ['build/out/ssl.cf']);
		assert.deepStrictEqual(files([extension('Первое', 'first')], { outputName: 'ssl.cf' }), [
			'build/out/cfe/ssl.cf.cfe',
		]);
	});

	test('переменные подставляются в каталог и имя', () => {
		assert.deepStrictEqual(
			files([extension('Первое', 'first', '1.2'), extension('Второе', 'second', '0.5')], {
				outputDirectory: 'build/${version}',
				outputName: '${name}-${folder}',
			}),
			['build/1.2/Первое-first.cfe', 'build/0.5/Второе-second.cfe']
		);
	});

	test('символы значения, ломающие путь, заменяются', () => {
		const target = { ...configuration, variables: { version: '1/2:3' } };
		assert.deepStrictEqual(files([target], { outputName: 'v${version}' }), ['build/out/v1_2_3.cf']);
	});

	test('пути приводятся к прямым разделителям, абсолютные остаются абсолютными', () => {
		assert.deepStrictEqual(files([configuration], { outputDirectory: '.\\build\\release\\' }), [
			'build/release/1Cv8.cf',
		]);
		assert.deepStrictEqual(files([configuration], { outputDirectory: 'C:\\artifacts\\' }), ['C:/artifacts/1Cv8.cf']);
		assert.deepStrictEqual(files([configuration], { outputDirectory: '/srv/artifacts' }), ['/srv/artifacts/1Cv8.cf']);
		assert.deepStrictEqual(files([configuration], { outputDirectory: '../artifacts' }), ['../artifacts/1Cv8.cf']);
	});

	test('одно имя у нескольких объектов - ошибка со списком', () => {
		const message = error([extension('Первое', 'first'), extension('Второе', 'second')], { outputName: 'ext' });
		assert.match(message, /build\/out\/cfe\/ext\.cfe: для расширения «Первое» и расширения «Второе»/);
	});

	test('совпадение путей проверяется без учёта регистра', () => {
		const message = error([extension('A', 'ext'), extension('B', 'EXT')], {});
		assert.match(message, /для расширения «A» и расширения «B»/);
	});

	test('незнакомая переменная - ошибка до подстановки', () => {
		const used = buildOutputVariables({ outputName: '${name}-${build}' });
		assert.ok('error' in used);
		assert.match(used.error, /\$\{build\} в outputName/);
	});

	test('buildOutputVariables возвращает только встреченные переменные', () => {
		const used = buildOutputVariables({ outputDirectory: 'out/${gitBranch}', outputName: '${name}' });
		assert.ok('variables' in used);
		assert.deepStrictEqual([...used.variables].sort(), ['gitBranch', 'name']);
	});

	test('переменная без значения - ошибка с причиной', () => {
		const target: BuildOutputTarget = {
			label: 'внешней обработки «Загрузка»',
			type: 'epf',
			directory: 'build/out/epf',
			name: 'Загрузка',
			variables: { name: 'Загрузка' },
			unavailable: { version: 'у внешних обработок и отчётов версии нет' },
		};
		assert.strictEqual(
			error([target], { outputName: '${name}-${version}' }),
			'Нет значения ${version} для внешней обработки «Загрузка»: у внешних обработок и отчётов версии нет'
		);
	});

	test('имя не содержит каталогов и недопустимых символов', () => {
		assert.match(error([configuration], { outputName: 'release/ssl' }), /каталог передаётся в outputDirectory/);
		assert.match(error([configuration], { outputName: 'ssl?' }), /недопустимые символы/);
		assert.match(error([configuration], { outputName: '.cf' }), /Пустое имя файла/);
	});

	test('параметр не строкой - ошибка', () => {
		assert.strictEqual(error([configuration], { outputDirectory: 42 }), 'Параметр outputDirectory должен быть строкой');
	});
});
