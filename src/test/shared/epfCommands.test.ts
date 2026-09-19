import * as assert from 'node:assert';
import { EPF_COMMANDS } from '../../shared/constants';

suite('обработки vanessa-runner', () => {
	test('загрузка расширения из .cfe обновляет уже установленное', () => {
		assert.strictEqual(
			EPF_COMMANDS.LOAD_EXTENSION('build/out/cfe/Ext.cfe'),
			'Путь=build/out/cfe/Ext.cfe;Перезаписывать;ЗавершитьРаботуСистемы;'
		);
	});
});
