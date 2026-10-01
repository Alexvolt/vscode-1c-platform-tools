import * as assert from 'node:assert';
import { AUTUMN_DEFAULTS, DEFAULT_PLATFORM, ENV_DEFAULTS } from '../../features/serviceFiles/envDefaults';
import { DUMP_FORMATS } from '../../features/metadata/mdSparrowSchemaVersion';

suite('envDefaults: версия платформы', () => {
	test('новые служебные файлы получают платформу самого свежего формата выгрузки', () => {
		// Новый формат без новой платформы здесь - забытое обновление служебных файлов
		const [major, minor] = DUMP_FORMATS[0].platform.split('.');
		assert.strictEqual(DEFAULT_PLATFORM, `${major}.${minor}`);
		assert.strictEqual(ENV_DEFAULTS.default['--v8version'], DEFAULT_PLATFORM);
		assert.strictEqual(AUTUMN_DEFAULTS.vrunner.v8version, DEFAULT_PLATFORM);
	});
});
