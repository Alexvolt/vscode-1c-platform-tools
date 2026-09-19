import * as assert from 'node:assert';
import { overlaySettings, parseSettingsJson } from '../../shared/settingsJson';

suite('settingsJson: разбор файлов настроек', () => {
	test('BOM, комментарии и висячая запятая не мешают', () => {
		const text = '﻿{\n\t// профиль\n\t"vrunner": { "ibconnection": "/F./build/ib", },\n}\n';
		assert.deepStrictEqual(parseSettingsJson(text), { vrunner: { ibconnection: '/F./build/ib' } });
	});

	test('обычный JSON разбирается как есть', () => {
		assert.deepStrictEqual(parseSettingsJson('{"default": {"--v8version": "8.3"}}'), {
			default: { '--v8version': '8.3' },
		});
	});

	test('ошибка называет причину и строку', () => {
		assert.throws(() => parseSettingsJson('{\n\t"vrunner": {\n\t\t"ibconnection": "/F./build/ib"\n'), /строка 4/);
		assert.throws(() => parseSettingsJson('{ "a": }'), /ожидалось значение, строка 1/);
	});
});

suite('settingsJson: наложение файлов vanessa-runner 3', () => {
	test('важный файл дополняется общим по ключам, списки складываются', () => {
		const profile = {
			vrunner: {
				v8version: '8.3.27',
				'db-user': null,
				validate: { 'syntax-check': { 'report-format': ['junit'], 'report-path': 'build/out/sc' } },
			},
		};
		const project = {
			vrunner: {
				ibconnection: '/F./build/ib',
				v8version: '8.3.23',
				'db-user': 'admin',
				validate: { 'syntax-check': { 'report-format': ['allure'], groupbymetadata: true } },
			},
			logos: { logger: { vrunner: 'INFO' } },
		};
		assert.deepStrictEqual(overlaySettings([profile, project]), {
			vrunner: {
				v8version: '8.3.27',
				'db-user': 'admin',
				ibconnection: '/F./build/ib',
				validate: {
					'syntax-check': { 'report-format': ['junit', 'allure'], 'report-path': 'build/out/sc', groupbymetadata: true },
				},
			},
			logos: { logger: { vrunner: 'INFO' } },
		});
		assert.deepStrictEqual(profile.vrunner.validate['syntax-check']['report-format'], ['junit']);
	});

	test('значение другого вида из общего файла отбрасывается, неразобранный файл пропускается', () => {
		assert.deepStrictEqual(
			overlaySettings([{ vrunner: { 'report-format': 'junit', test: 'x' } }, undefined, { vrunner: { 'report-format': ['allure'], test: { xunit: {} } } }]),
			{ vrunner: { 'report-format': 'junit', test: 'x' } }
		);
	});
});
