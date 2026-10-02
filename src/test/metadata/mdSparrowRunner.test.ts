import * as assert from 'node:assert';
import { MD_SPARROW_JAVA } from '../../features/metadata/mdSparrowConstants';
import { javaTooOldMessage } from '../../features/metadata/mdSparrowRunner';

suite('запуск md-sparrow на старой java', () => {
	// Вывод Java 21 при запуске jar, собранного под Java 25
	const JAVA_21 = [
		'Error: LinkageError occurred while loading main class io.github.yellowhammer.designerxml.cli.DesignerXmlCli',
		'\tjava.lang.UnsupportedClassVersionError: io/github/yellowhammer/designerxml/cli/DesignerXmlCli has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0',
		'',
	].join('\r\n');

	test('отказ старой java объясняется версией и настройками', () => {
		const message = javaTooOldMessage(JAVA_21) ?? '';

		assert.ok(message.includes(`Java ${MD_SPARROW_JAVA} или новее`), message);
		assert.ok(message.includes('components.path.java'), message);
		assert.ok(message.includes('components.autoload.java'), message);
	});

	test('другие отказы остаются как есть', () => {
		assert.strictEqual(javaTooOldMessage('Каталог cwd должен быть абсолютным путём к существующему каталогу'), undefined);
		assert.strictEqual(javaTooOldMessage(''), undefined);
	});
});
