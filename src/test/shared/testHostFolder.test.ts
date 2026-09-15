import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isExcludedFromLayout, setLayoutExclusions } from '../../shared/projectLayout';
import { parseSettingsJson } from '../../shared/settingsJson';

suite('папка хоста vscode-test', () => {
	const repository = path.resolve(__dirname, '../../..');

	teardown(() => {
		setLayoutExclusions(() => []);
	});

	test('каталоги фикстур с packagedef исключены из обхода папки хоста', () => {
		const settings = parseSettingsJson(fs.readFileSync(path.join(repository, '.vscode', 'settings.json'), 'utf8')) as Record<string, unknown>;
		const exclude = settings['1c-platform-tools.artifacts.exclude'];
		assert.ok(Array.isArray(exclude));
		setLayoutExclusions(() => exclude as string[]);

		const fixtures = path.join(repository, 'src', 'test', 'fixtures');
		const projects = fs
			.readdirSync(fixtures, { recursive: true, encoding: 'utf8' })
			.filter((entry) => path.basename(entry) === 'packagedef')
			.map((entry) => path.dirname(path.join(fixtures, entry)));

		assert.ok(projects.length > 0);
		assert.deepStrictEqual(projects.filter((dir) => !isExcludedFromLayout(repository, dir)), []);
	});
});
