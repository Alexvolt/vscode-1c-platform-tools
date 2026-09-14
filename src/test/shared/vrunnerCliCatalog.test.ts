import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V3CliAdapter } from '../../shared/vrunnerCli/v3Adapter';
import type { VRunnerIntent } from '../../shared/vrunnerCli';

interface CatalogOption {
	key: string;
	type: string;
}

interface Catalog {
	sets: Record<string, CatalogOption[]>;
	commands: { path: string; options: CatalogOption[]; sets?: string[] }[];
}

const CATALOG_PATH = path.resolve(__dirname, '..', '..', '..', 'resources', 'schemas', 'vrunner-options.v3.json');

/** Короткие имена опций, которые адаптер передаёт вместо длинных. */
const SHORT_OPTIONS: Record<string, string> = { s: 'src', R: 'recursive' };

const filter = { filter: 'appid=Designer|name=Иванов', filterMode: 'EXCEPT' };

/** Каждый вид интента со всеми необязательными полями. */
const INTENTS: VRunnerIntent[] = [
	{ kind: 'infobase.init', src: 'src/cf' },
	{ kind: 'infobase.updateDb' },
	{ kind: 'infobase.updateExtension', extensionName: 'Ext' },
	{ kind: 'infobase.dumpDt', out: 'build/ib.dt' },
	{ kind: 'infobase.restoreDt', file: 'build/ib.dt' },
	{ kind: 'infobase.listExtensions', json: true },
	{ kind: 'cf.build', src: 'src/cf', out: 'build/1Cv8.cf' },
	{ kind: 'cf.decompileFile', file: 'build/1Cv8.cf', out: 'src/cf' },
	{ kind: 'cf.dumpIbToSrc', out: 'src/cf' },
	{ kind: 'cf.unloadIbToCf', out: 'build/1Cv8.cf' },
	{ kind: 'cf.makeDist', out: 'build/dist/1Cv8.cf' },
	{ kind: 'cf.loadFromSrc', src: 'src/cf', increment: true, listFile: 'build/list.txt', updateDb: false },
	{ kind: 'cf.loadFileToIb', file: 'build/1Cv8.cf', updateDb: false },
	{ kind: 'cfe.buildCfe', src: 'src/cfe/Ext', out: 'build/Ext.cfe', extensionName: 'Ext' },
	{ kind: 'cfe.loadFromSrc', src: 'src/cfe/Ext', extensionName: 'Ext', updateDb: false },
	{ kind: 'cfe.loadFromCfeFile', file: 'build/Ext.cfe', extensionName: 'Ext' },
	{ kind: 'cfe.dumpIbToSrc', extensionName: 'Ext', out: 'src/cfe/Ext' },
	{ kind: 'cfe.unloadIbToCfe', extensionName: 'Ext', out: 'build/Ext.cfe' },
	{ kind: 'cfe.decompileCfeFile', file: 'build/Ext.cfe', extensionName: 'Ext', out: 'src/cfe/Ext' },
	{ kind: 'epf.build', src: 'src/epf', out: 'build/epf' },
	{ kind: 'epf.decompile', input: 'build/epf', out: 'src/epf' },
	{ kind: 'run.enterprise', command: 'ЗавершитьРаботуСистемы', execute: 'tools/close.epf', noWait: true },
	{ kind: 'run.designer', additional: '/CheckModules', noWait: true },
	{ kind: 'test.xunit', testsPath: 'tests', reportsXunit: 'ГенераторОтчетаJUnitXML{build/junit.xml}' },
	{ kind: 'test.vanessa', featurePath: 'features', vanessaSettings: 'tools/VAParams.json' },
	{
		kind: 'test.yaxunit',
		configPath: 'tools/yaxunit.json',
		filter: { extensions: ['Tests'], modules: ['Модуль'], tests: ['Модуль.Тест'] },
		report: 'build/yaxunit.xml',
		ordinaryApp: '0',
		exitCodePath: 'build/exitcode.txt',
		additional: '/DisplayAllFunctions',
		noWait: true,
	},
	{ kind: 'validate.syntaxCheck' },
	{ kind: 'validate.edt', src: 'ssl31', junitPath: 'build/edt.xml' },
	{ kind: 'session.lock', deniedMessage: 'Обновление', accessCode: '123' },
	{ kind: 'session.unlock', accessCode: '123' },
	{ kind: 'session.kill', ...filter, withoutLock: true, timeoutSeconds: 30 },
	{ kind: 'session.kill', retry: 3 },
	{ kind: 'session.closed', ...filter, timeoutSeconds: 30 },
	{ kind: 'session.list', ...filter, connections: true },
	{ kind: 'jobs.lock' },
	{ kind: 'jobs.unlock' },
];

const normalize = (commandPath: string): string => commandPath.replace(/-/g, '');

/** Команда каталога по началу строки запуска: самая длинная цепочка слов до опций. */
function findCommand(catalog: Catalog, argv: string[]): { command: Catalog['commands'][number]; words: number } {
	const words = argv.findIndex((token) => token.startsWith('-'));
	const limit = words === -1 ? argv.length : words;
	for (let count = Math.min(limit, 3); count > 0; count--) {
		const candidate = [argv[0], argv.slice(1, count).join('-')].filter(Boolean).join('.');
		const command = catalog.commands.find((entry) => normalize(entry.path) === normalize(candidate));
		if (command) {
			return { command, words: count };
		}
	}
	throw new Error(`Команды нет в каталоге: ${argv.join(' ')}`);
}

suite('vrunnerCli: адаптер v3 и каталог опций', () => {
	const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as Catalog;
	const adapter = new V3CliAdapter();

	test('опции каждой команды есть у этой команды в vanessa-runner', () => {
		const unknown: string[] = [];
		for (const intent of INTENTS) {
			for (const argv of adapter.plan(intent)) {
				const { command, words } = findCommand(catalog, argv);
				const options = [...command.options, ...(command.sets ?? []).flatMap((set) => catalog.sets[set] ?? [])];
				for (let index = words; index < argv.length; index++) {
					const token = argv[index];
					if (!token.startsWith('-')) {
						continue;
					}
					const name = token.replace(/^-+/, '');
					const option = options.find((entry) => entry.key === (SHORT_OPTIONS[name] ?? name));
					if (!option) {
						unknown.push(`${command.path}: ${token}`);
						continue;
					}
					if (option.type !== 'boolean') {
						index++;
					}
				}
			}
		}
		assert.deepStrictEqual(unknown, []);
	});
});
