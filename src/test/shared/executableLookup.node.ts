/**
 * Поиск программы по PATH так, как её находит оболочка.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { findExecutable } from '../../shared/executableLookup';

const ENGINES = path.resolve(__dirname, '../../../src/test/fixtures/onescriptEngines');
const SCD = path.join(ENGINES, 'scd', 'bin');
const FDD = path.join(ENGINES, 'fdd', 'bin');
const NATIVE = path.join(ENGINES, 'native', 'bin');

const pathOf = (...dirs: string[]) => dirs.join(path.delimiter);
const windows = { skip: process.platform !== 'win32' };
const posix = { skip: process.platform === 'win32' };

describe('findExecutable', () => {
	test('на Windows берётся первый каталог PATH, где есть файл с расширением из PATHEXT', windows, () => {
		const env = { Path: pathOf(FDD, SCD), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
		assert.equal(findExecutable('oscript', env), path.join(FDD, 'oscript.bat'));
		assert.equal(findExecutable('oscript', { ...env, Path: pathOf(SCD, FDD) }), path.join(SCD, 'oscript.exe'));
	});

	test('на Windows сценарий без расширения программой не считается', windows, () => {
		assert.equal(findExecutable('oscript', { PATH: pathOf(FDD, SCD), PATHEXT: '.EXE' }), path.join(SCD, 'oscript.exe'));
	});

	test('на Windows путь без расширения дополняется расширениями', windows, () => {
		assert.equal(findExecutable(path.join(SCD, 'oscript'), { PATHEXT: '.EXE' }), path.join(SCD, 'oscript.exe'));
	});

	test('на POSIX берётся исполняемый файл из первого каталога PATH', posix, () => {
		assert.equal(findExecutable('oscript', { PATH: pathOf(FDD, NATIVE) }), path.join(FDD, 'oscript'));
		assert.equal(findExecutable('oscript', { PATH: pathOf(NATIVE, FDD) }), path.join(NATIVE, 'oscript'));
	});

	test('на POSIX файл без права на исполнение не находится', posix, () => {
		assert.equal(findExecutable('oscript.bat', { PATH: FDD }), undefined);
	});

	test('путь с каталогом берётся от каталога запуска, а не из PATH', () => {
		const name = process.platform === 'win32' ? 'oscript.exe' : 'oscript';
		const dir = process.platform === 'win32' ? SCD : NATIVE;
		assert.equal(findExecutable(path.join('bin', name), { PATH: FDD }, path.dirname(dir)), path.join(dir, name));
	});

	test('программы нет ни в одном каталоге', () => {
		assert.equal(findExecutable('oscript', { PATH: path.join(ENGINES, 'нет') }), undefined);
		assert.equal(findExecutable('oscript', {}), undefined);
	});
});
