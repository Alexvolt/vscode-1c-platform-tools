/**
 * Подготовка проверки OData на платформе (workflow platform-odata).
 *
 * Не тест: сценарий раскладывает исходники перед загрузкой в базу.
 * - конфигурация из fixtures/platform/odata/cf копируется в каталог сборки,
 *   а в модуль HTTP-сервиса СоставOData дописываются серверные функции
 *   служебной обработки;
 * - исходники самой обработки пишутся для сборки конфигуратором;
 * - конфиг публикации ibsrv строится тем же кодом, что у автономного сервера
 *   расширения: OData и HTTP-сервис СоставOData.
 *
 * Запуск: node out/test/platform/prepareOData.node.js <каталог конфигурации> <каталог исходников обработки>
 *   [<publication.yaml> <каталог базы> <порт>]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { processorSourceFiles, PROCESSOR_NAME } from '../../features/odata/odataComposition';
import { buildServerConfigYaml } from '../../shared/ibsrvPublication';

const SERVER_DIRECTIVE = '&НаСервереБезКонтекста';

/**
 * Серверная часть модуля формы обработки без директив компиляции:
 * в модуле HTTP-сервиса директивы недопустимы.
 *
 * @param formModule - Модуль формы обработки
 */
export function serverFunctions(formModule: string): string {
	const start = formModule.indexOf(SERVER_DIRECTIVE);
	if (start === -1) {
		throw new Error('В модуле формы обработки нет серверных функций');
	}
	return formModule
		.slice(start)
		.split('\n')
		.filter((line) => line.trim() !== SERVER_DIRECTIVE)
		.join('\n');
}

function main(): void {
	const [cfDir, epfDir, publicationPath, dbPath, port] = process.argv.slice(2);
	if (!cfDir || !epfDir) {
		throw new Error('Укажите каталог конфигурации и каталог исходников обработки');
	}
	const fixture = path.resolve(__dirname, '../../../src/test/fixtures/platform/odata/cf');
	fs.rmSync(cfDir, { recursive: true, force: true });
	fs.cpSync(fixture, cfDir, { recursive: true });

	const files = processorSourceFiles();
	const formModule = files[`${PROCESSOR_NAME}/Forms/Форма/Ext/Form/Module.bsl`];
	const serviceModule = path.join(cfDir, 'HTTPServices', 'СоставOData', 'Ext', 'Module.bsl');
	fs.appendFileSync(serviceModule, `\n${serverFunctions(formModule)}`, 'utf8');

	fs.rmSync(epfDir, { recursive: true, force: true });
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(epfDir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, 'utf8');
	}
	if (publicationPath && dbPath) {
		const yaml = buildServerConfigYaml({
			host: 'localhost',
			port: Number(port ?? 8314),
			dbPath: path.resolve(dbPath),
			infobaseName: 'ПроверкаOData',
			distributeLicenses: true,
			base: 'ib',
			publication: {
				odata: true,
				webServices: { publishByDefault: false, services: [] },
				httpServices: { publishByDefault: false, services: [{ name: 'СоставOData', root: 'odata-composition' }] },
			},
		});
		fs.writeFileSync(publicationPath, yaml, 'utf8');
		console.log(`Конфиг публикации: ${publicationPath}\n${yaml}`);
	}
	console.log(`Конфигурация: ${cfDir}`);
	console.log(`Исходники обработки: ${epfDir}`);
}

if (require.main === module) {
	main();
}
