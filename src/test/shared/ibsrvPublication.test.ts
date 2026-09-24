import * as assert from 'node:assert';
import {
	normalizeHttpBase,
	buildServerConfigYaml,
	buildServerUrls,
	buildHttpServiceUrl,
	parseServerConfigParams,
} from '../../shared/ibsrvPublication';

suite('ibsrvPublication', () => {
	test('normalizeHttpBase: снимает слэши', () => {
		assert.strictEqual(normalizeHttpBase('/'), '');
		assert.strictEqual(normalizeHttpBase(''), '');
		assert.strictEqual(normalizeHttpBase(undefined), '');
		assert.strictEqual(normalizeHttpBase('ib'), 'ib');
		assert.strictEqual(normalizeHttpBase('/ib/'), 'ib');
		assert.strictEqual(normalizeHttpBase('  /my/base/  '), 'my/base');
	});

	test('buildServerConfigYaml: полный конфиг, публикация всех (формат 8.5.1)', () => {
		const yaml = buildServerConfigYaml({
			host: 'localhost',
			port: 8314,
			dbPath: 'C:\\proj\\build\\ib',
			infobaseName: 'DefAlias',
			distributeLicenses: true,
			base: 'ib',
			publication: {
				odata: true,
				webServices: { publishByDefault: true, services: [] },
				httpServices: { publishByDefault: true, services: [] },
			},
		});
		assert.strictEqual(
			yaml,
			[
				'server:',
				'  address: localhost',
				'  port: 8314',
				'database:',
				'  path: C:\\proj\\build\\ib',
				'infobase:',
				'  name: DefAlias',
				'  distribute-licenses: yes',
				'http:',
				'  - base: /ib',
				'    odata:',
				'      publish: yes',
				'    web-services:',
				'      publish-by-default: yes',
				'      publish-extensions-by-default: yes',
				'    http-services:',
				'      publish-by-default: yes',
				'      publish-extensions-by-default: yes',
				'',
			].join('\n')
		);
	});

	test('buildServerConfigYaml: точечный список HTTP-сервисов с корневыми URL', () => {
		const yaml = buildServerConfigYaml({
			host: 'localhost',
			port: 8314,
			dbPath: '/srv/ib',
			infobaseName: 'DefAlias',
			distributeLicenses: true,
			base: 'ib',
			publication: {
				odata: false,
				webServices: { publishByDefault: true, services: [] },
				httpServices: {
					publishByDefault: false,
					services: [{ name: 'ОбменДанными', root: 'exchange' }, { name: 'Платежи' }],
				},
			},
		});
		assert.ok(
			yaml.includes(
				'    http-services:\n      publish-by-default: no\n      publish-extensions-by-default: no\n      service:\n'
			)
		);
		assert.ok(yaml.includes('        - name: ОбменДанными\n          root: exchange\n          publish: yes\n'));
		// корневого URL нет: пишется одно имя
		assert.ok(yaml.includes('        - name: Платежи\n          publish: yes\n'));
		// при publishByDefault=true секция service не печатается
		assert.ok(!/web-services:\n {6}publish-by-default: yes\n {6}publish-extensions-by-default: yes\n {6}service:/.test(yaml));
	});

	test('buildServerConfigYaml: выборочное отключение и пустая база → /', () => {
		const yaml = buildServerConfigYaml({
			host: 'any',
			port: 8400,
			dbPath: '/srv/ib',
			infobaseName: 'DefAlias',
			distributeLicenses: false,
			base: '/',
			publication: {
				odata: false,
				webServices: { publishByDefault: true, services: [] },
				httpServices: { publishByDefault: false, services: [] },
			},
		});
		assert.ok(yaml.includes('  distribute-licenses: no'));
		assert.ok(yaml.includes('  - base: /\n'));
		assert.ok(yaml.includes('    odata:\n      publish: no'));
		assert.ok(yaml.includes('    http-services:\n      publish-by-default: no'));
		// пустой список без publish-by-default → секции service нет
		assert.ok(!yaml.includes('service:'));
	});

	test('buildServerUrls: корень и OData с базой', () => {
		const urls = buildServerUrls('localhost', 8314, 'ib');
		assert.strictEqual(urls.root, 'http://localhost:8314/ib/');
		assert.strictEqual(urls.odataMetadata, 'http://localhost:8314/ib/odata/standard.odata/$metadata');
	});

	test('buildServerUrls: пустая база → корень сайта', () => {
		const urls = buildServerUrls('127.0.0.1', 8080, '/');
		assert.strictEqual(urls.root, 'http://127.0.0.1:8080/');
		assert.strictEqual(urls.odataMetadata, 'http://127.0.0.1:8080/odata/standard.odata/$metadata');
	});

	test('buildHttpServiceUrl: hs/<root>', () => {
		const urls = buildServerUrls('localhost', 8314, 'ib');
		assert.strictEqual(buildHttpServiceUrl(urls, 'myservice'), 'http://localhost:8314/ib/hs/myservice');
		assert.strictEqual(buildHttpServiceUrl(urls, '/myservice'), 'http://localhost:8314/ib/hs/myservice');
	});

	test('parseServerConfigParams: читает host/port/base/лицензии из сгенерированного конфига', () => {
		const yaml = buildServerConfigYaml({
			host: 'localhost',
			port: 8314,
			dbPath: 'C:\\proj\\build\\ib',
			infobaseName: 'DefAlias',
			distributeLicenses: true,
			base: 'ib',
			publication: {
				odata: true,
				webServices: { publishByDefault: true, services: [] },
				httpServices: { publishByDefault: true, services: [] },
			},
		});
		assert.deepStrictEqual(parseServerConfigParams(yaml), {
			host: 'localhost',
			port: 8314,
			base: '/ib',
			distributeLicenses: true,
			odata: true,
		});
	});

	test('parseServerConfigParams: публикация OData по конфигу', () => {
		const yaml = 'http:\n  - base: /ib\n    odata:\n      publish: no\n    web-services:\n      publish-by-default: yes\n';
		assert.strictEqual(parseServerConfigParams(yaml).odata, false);
		assert.strictEqual(parseServerConfigParams(yaml.replace('publish: no', 'publish: yes')).odata, true);
	});

	test('parseServerConfigParams: учитывает ручную правку порта', () => {
		const yaml = 'server:\n  address: any\n  port: 9000\ninfobase:\n  distribute-licenses: no\nhttp:\n  - base: /\n';
		const parsed = parseServerConfigParams(yaml);
		assert.strictEqual(parsed.host, 'any');
		assert.strictEqual(parsed.port, 9000);
		assert.strictEqual(parsed.base, '/');
		assert.strictEqual(parsed.distributeLicenses, false);
	});

	test('parseServerConfigParams: пустой ввод → пусто', () => {
		assert.deepStrictEqual(parseServerConfigParams(''), {
			host: undefined,
			port: undefined,
			base: undefined,
			distributeLicenses: undefined,
			odata: undefined,
		});
	});
});
