import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Локальный vanessa-runner проекта, отвечающий на запрос версии сразу.
 *
 * @param root - Корень временного проекта
 * @param version - Версия, которую напечатает раннер
 */
export function writeLocalRunner(root: string, version: string): void {
	const bin = path.join(root, 'oscript_modules', 'bin');
	fs.mkdirSync(bin, { recursive: true });
	if (process.platform === 'win32') {
		fs.writeFileSync(path.join(bin, 'vrunner.bat'), `@echo ${version}\r\n`, 'utf8');
		return;
	}
	const runner = path.join(bin, 'vrunner');
	fs.writeFileSync(runner, `#!/bin/sh\necho ${version}\n`, 'utf8');
	fs.chmodSync(runner, 0o755);
}

/**
 * Локальный vanessa-runner, имитирующий нестабильный холодный старт: первые
 * `failCount` запусков (независимо от аргументов — покрывает и `--version`,
 * и `version`) падают с ненулевым кодом и без версии в выводе, дальнейшие
 * запуски отвечают версией сразу.
 *
 * @param root - Корень временного проекта
 * @param version - Версия, которую напечатает раннер после того, как перестанет "падать"
 * @param failCount - Сколько первых запусков должны провалиться
 */
export function writeFlakyRunner(root: string, version: string, failCount: number): void {
	const bin = path.join(root, 'oscript_modules', 'bin');
	fs.mkdirSync(bin, { recursive: true });
	const counterFile = path.join(bin, '.invocations');
	fs.writeFileSync(counterFile, '0', 'utf8');

	if (process.platform === 'win32') {
		const script = [
			'@echo off',
			`set /p N=<"${counterFile}"`,
			'set /a N=N+1',
			`>"${counterFile}" echo %N%`,
			`if %N% leq ${failCount} (`,
			'  echo simulated cold-start failure 1>&2',
			'  exit /b 1',
			')',
			`echo ${version}`
		].join('\r\n');
		fs.writeFileSync(path.join(bin, 'vrunner.bat'), script + '\r\n', 'utf8');
		return;
	}

	const runner = path.join(bin, 'vrunner');
	const script = [
		'#!/bin/sh',
		`COUNT_FILE="${counterFile}"`,
		'N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)',
		'N=$((N + 1))',
		'echo "$N" > "$COUNT_FILE"',
		`if [ "$N" -le ${failCount} ]; then`,
		'  echo "simulated cold-start failure" >&2',
		'  exit 1',
		'fi',
		`echo ${version}`
	].join('\n');
	fs.writeFileSync(runner, script + '\n', 'utf8');
	fs.chmodSync(runner, 0o755);
}
