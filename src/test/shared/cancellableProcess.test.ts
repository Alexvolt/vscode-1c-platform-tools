import * as assert from 'node:assert';
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
