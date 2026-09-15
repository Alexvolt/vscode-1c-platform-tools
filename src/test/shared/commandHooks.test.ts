import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHookPhaseDry } from '../../shared/commandHooks';

suite('хуки команд: кэш файла', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-cache-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});

	test('правка hooks.json мимо редактора хуков действует со следующего вызова', async () => {
		const file = path.join(root, '.1cpt', 'hooks.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const write = (text: string, seconds: number): void => {
			fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { '*': { pre: `echo ${text}` } } }), 'utf8');
			fs.utimesSync(file, seconds, seconds);
		};

		write('hook-one', 1_700_000_000);
		assert.match((await runHookPhaseDry(root, 'команда', 'pre')).output, /hook-one/);

		write('hook-two', 1_700_000_100);
		assert.match((await runHookPhaseDry(root, 'команда', 'pre')).output, /hook-two/);

		fs.rmSync(file);
		assert.strictEqual((await runHookPhaseDry(root, 'команда', 'pre')).output, 'шагов нет');
	});
});
