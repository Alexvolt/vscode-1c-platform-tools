import * as assert from 'node:assert';
import * as path from 'node:path';
import { findRac, listRacVersions } from '../../features/clusters/racLocator';
import { resolveDebugPlatform } from '../../features/debug/debugConfigurations';
import { findCestart } from '../../features/ibases/cestart';
import { cestartConfigValues, readPlatformText } from '../../shared/infobaseList';
import {
	cestartConfigFiles,
	describePlatformInstallations,
	platformInstallRoots,
	resolvePlatformVersionInRoots,
} from '../../shared/platformBinary';
import { uniquePaths } from '../../shared/installPaths';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'installations');
const WINDOWS = path.join(FIXTURES, 'windows');

/** Окружение Windows, у которого системные каталоги лежат в фикстуре. */
const WINDOWS_ENV: NodeJS.ProcessEnv = {
	ALLUSERSPROFILE: path.join(WINDOWS, 'ProgramData'),
	APPDATA: path.join(WINDOWS, 'Roaming'),
	LOCALAPPDATA: path.join(WINDOWS, 'Local'),
	ProgramFiles: path.join(WINDOWS, 'ProgramFiles'),
};

/** Каталоги установки на машине из фикстуры. */
function windowsRoots(): string[] {
	return platformInstallRoots({ platform: 'win32', arch: 'x64', env: WINDOWS_ENV, home: WINDOWS });
}

suite('каталоги установки платформы', () => {
	test('InstalledLocation читается из обоих файлов стартера, общий первым', () => {
		const files = cestartConfigFiles('win32', WINDOWS_ENV, WINDOWS);
		assert.deepStrictEqual(files, [
			path.join(WINDOWS, 'ProgramData', '1C', '1CEStart', '1cestart.cfg'),
			path.join(WINDOWS, 'Roaming', '1C', '1CEStart', '1cestart.cfg'),
		]);
		const own = readPlatformText(files[1]) ?? '';
		assert.deepStrictEqual(cestartConfigValues(own, 'InstalledLocation'), ['Z:\\1C\\Своя\\1cv8', 'Z:\\1C\\Вторая\\1cv8']);
	});

	test('без настройки: каталоги стартера, затем Program Files и установка для одного пользователя', () => {
		assert.deepStrictEqual(windowsRoots(), [
			'Z:\\1C\\Общая\\1cv8',
			'Z:\\1C\\Своя\\1cv8',
			'Z:\\1C\\Вторая\\1cv8',
			path.join(WINDOWS, 'ProgramFiles', '1cv8'),
			path.join(WINDOWS, 'Local', 'Programs', '1cv8_x64'),
			path.join(WINDOWS, 'Local', 'Programs', '1cv8'),
		]);
	});

	test('заданный каталог единственный', () => {
		const configured = path.join(WINDOWS, 'Local', 'Programs', '1cv8_x64');
		assert.deepStrictEqual(platformInstallRoots({ configured: ` ${configured} `, platform: 'win32', env: WINDOWS_ENV }), [
			configured,
		]);
	});

	test('на Linux каталог из стартера совпадает с каталогом по умолчанию и не повторяется', () => {
		const home = path.join(FIXTURES, 'linux', 'home');
		assert.deepStrictEqual(platformInstallRoots({ platform: 'linux', arch: 'x64', env: {}, home }), [
			'/opt/1cv8/x86_64',
			'/opt/1C/v8.3/x86_64',
		]);
	});

	test('повторы путей Windows не различают регистр, разделитель и завершающий слэш', () => {
		assert.deepStrictEqual(
			uniquePaths(['C:\\Program Files\\1cv8\\', 'c:/program files/1cv8', 'C:\\Program Files (x86)\\1cv8'], 'win32'),
			['C:\\Program Files\\1cv8', 'C:\\Program Files (x86)\\1cv8']
		);
	});
});

suite('платформа, установленная для одного пользователя', () => {
	const perUser = path.join(WINDOWS, 'Local', 'Programs', '1cv8_x64');
	const programFiles = path.join(WINDOWS, 'ProgramFiles', '1cv8');

	test('rac: наибольшая версия выбирается по всем каталогам сразу', () => {
		assert.strictEqual(
			findRac(windowsRoots(), undefined, 'win32').binary,
			path.join(perUser, '8.3.27.2214', 'bin', 'rac.exe')
		);
		assert.strictEqual(
			findRac(windowsRoots(), '8.3.24', 'win32').binary,
			path.join(programFiles, '8.3.24.1691', 'bin', 'rac.exe')
		);
		assert.deepStrictEqual(listRacVersions(windowsRoots(), 'win32'), ['8.3.27.2214', '8.3.24.1691']);
	});

	test('1cestart берётся из common установки для пользователя', () => {
		assert.strictEqual(
			findCestart({ roots: windowsRoots(), platform: 'win32' }).binary,
			path.join(perUser, 'common', '1cestart.exe')
		);
	});

	test('отладчик получает каталог, где лежит выбранная версия', () => {
		assert.deepStrictEqual(resolvePlatformVersionInRoots(windowsRoots()), { root: perUser, version: '8.3.27.2214' });
		assert.deepStrictEqual(resolvePlatformVersionInRoots(windowsRoots(), '8.3.24'), {
			root: programFiles,
			version: '8.3.24.1691',
		});
		assert.strictEqual(resolvePlatformVersionInRoots(windowsRoots(), '8.5'), undefined);

		const launch = { type: '1c-platform-tools', name: 'Отладка', request: 'launch' };
		assert.deepStrictEqual(resolveDebugPlatform(launch, '8.3', windowsRoots()), {
			platformPath: perUser,
			platformVersion: '8.3.27.2214',
		});
		assert.deepStrictEqual(resolveDebugPlatform({ ...launch, platformPath: programFiles }, undefined, windowsRoots()), {
			platformPath: programFiles,
			platformVersion: '8.3.24.1691',
		});
		assert.deepStrictEqual(resolveDebugPlatform(launch, '8.5', windowsRoots()), { platformVersion: '8.5' });
	});

	test('сводка перечисляет установки с версиями и пропускает пустые каталоги', () => {
		assert.deepStrictEqual(describePlatformInstallations(windowsRoots(), 'win32'), [
			{ root: programFiles, versions: ['8.3.24.1691'] },
			{ root: perUser, versions: ['8.3.27.2214'] },
		]);
	});
});
