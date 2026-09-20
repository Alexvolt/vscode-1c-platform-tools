import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runCancellableCommand } from '../../shared/cancellableProcess';

/** Команда, которая живёт дольше теста: её завершает только отмена. */
const SLEEP = 'node -e "setTimeout(() => {}, 20000)"';

suite('отменяемый процесс', () => {
	test('отменённый заранее запуск не стартует и уборку не вызывает', async () => {
		const cts = new vscode.CancellationTokenSource();
		cts.cancel();
		const calls: string[] = [];
		const startedAt = Date.now();

		const result = await runCancellableCommand(SLEEP, {
			token: cts.token,
			onCancel: () => calls.push('cancel'),
			onCancelled: () => calls.push('cancelled'),
		});

		assert.deepStrictEqual(result, { success: false, stdout: '', stderr: '', exitCode: -1, cancelled: true });
		assert.deepStrictEqual(calls, []);
		assert.ok(Date.now() - startedAt < 1000, 'отменённый запуск не ждёт процесс');
	});

	test('отмена по ходу: уборка при отмене, потом уборка после выхода процесса', async function () {
		this.timeout(15000);
		const cts = new vscode.CancellationTokenSource();
		const calls: string[] = [];
		const running = runCancellableCommand(SLEEP, {
			token: cts.token,
			onCancel: () => calls.push('cancel'),
			onCancelled: () => calls.push('cancelled'),
		});
		setTimeout(() => cts.cancel(), 300);

		const result = await running;

		assert.strictEqual(result.cancelled, true);
		assert.strictEqual(result.success, false);
		assert.deepStrictEqual(calls, ['cancel', 'cancelled']);
	});

	test('без отмены уборка не вызывается', async function () {
		this.timeout(15000);
		const calls: string[] = [];

		const result = await runCancellableCommand('node -e "process.exit(3)"', {
			token: new vscode.CancellationTokenSource().token,
			onCancel: () => calls.push('cancel'),
			onCancelled: () => calls.push('cancelled'),
		});

		assert.strictEqual(result.exitCode, 3);
		assert.strictEqual(result.cancelled, false);
		assert.deepStrictEqual(calls, []);
	});
});

suite('отменяемый процесс: программа с аргументами', () => {
	/** Программа, которая печатает свои аргументы через «|». */
	const echoArgs = (...args: string[]) => ({
		file: process.execPath,
		args: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', ...args],
	});

	test('аргументы доходят как есть: оболочка их не разбирает и не подставляет', async function () {
		this.timeout(15000);
		const args = ['a b', 'в"г', '%PATH%', '$HOME', 'x&y', ''];

		const result = await runCancellableCommand(echoArgs(...args));

		assert.strictEqual(result.exitCode, 0);
		assert.strictEqual(result.stdout, args.join('|'));
	});

	test('код возврата программы', async function () {
		this.timeout(15000);
		const result = await runCancellableCommand({ file: process.execPath, args: ['-e', 'process.exit(3)'] });

		assert.strictEqual(result.exitCode, 3);
		assert.strictEqual(result.success, false);
	});

	test('отмена по ходу: уборка при отмене, потом уборка после выхода процесса', async function () {
		this.timeout(15000);
		const cts = new vscode.CancellationTokenSource();
		const calls: string[] = [];
		const running = runCancellableCommand(
			{ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'] },
			{
				token: cts.token,
				onCancel: () => calls.push('cancel'),
				onCancelled: () => calls.push('cancelled'),
			}
		);
		setTimeout(() => cts.cancel(), 300);

		const result = await running;

		assert.strictEqual(result.cancelled, true);
		assert.deepStrictEqual(calls, ['cancel', 'cancelled']);
	});

	test('отменённый заранее запуск не стартует', async () => {
		const cts = new vscode.CancellationTokenSource();
		cts.cancel();

		const result = await runCancellableCommand(echoArgs('x'), { token: cts.token });

		assert.deepStrictEqual(result, { success: false, stdout: '', stderr: '', exitCode: -1, cancelled: true });
	});

	test('ненайденная программа даёт ошибку запуска, а не исключение', async () => {
		const result = await runCancellableCommand({ file: path.join(os.tmpdir(), 'нет-такой-программы'), args: [] });

		assert.strictEqual(result.exitCode, -1);
		assert.strictEqual(result.success, false);
		assert.notStrictEqual(result.stderr, '');
	});

	test('уборка по окончании: при выходе, после отмены и когда процесс не стартовал', async function () {
		this.timeout(15000);
		const calls: string[] = [];
		const track = (label: string) => ({
			onCancelled: () => calls.push(`${label}: после отмены`),
			onExit: () => calls.push(`${label}: по окончании`),
		});

		await runCancellableCommand(echoArgs('x'), track('выход'));
		const cts = new vscode.CancellationTokenSource();
		const running = runCancellableCommand(
			{ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'] },
			{ token: cts.token, ...track('отмена') }
		);
		setTimeout(() => cts.cancel(), 300);
		await running;
		await runCancellableCommand({ file: path.join(os.tmpdir(), 'нет-такой-программы'), args: [] }, track('не стартовал'));
		const cancelledBefore = new vscode.CancellationTokenSource();
		cancelledBefore.cancel();
		await runCancellableCommand(echoArgs('x'), { token: cancelledBefore.token, ...track('отменён заранее') });

		assert.deepStrictEqual(calls, [
			'выход: по окончании',
			'отмена: после отмены',
			'отмена: по окончании',
			'не стартовал: по окончании',
			'отменён заранее: по окончании',
		]);
	});

	test('пакетный файл Windows без оболочки не запускается, промис не отклоняется', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const result = await runCancellableCommand({ file: path.join(os.tmpdir(), 'обёртка.bat'), args: [] });

		assert.strictEqual(result.exitCode, -1);
		assert.match(result.stderr, /EINVAL/);
	});
});
