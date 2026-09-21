/**
 * Показ табличного документа из ответа md-sparrow.
 * Запуск: npm run compile && node --test out/test/spreadsheet/spreadsheetHtml.node.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSpreadsheetHtml, type SpreadsheetDto } from '../../features/spreadsheet/spreadsheetHtml';

const webviewDir = path.resolve(__dirname, '../../../resources/webview');
const sheet = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, '../../../src/test/spreadsheet/sheet.json'), 'utf8')
) as SpreadsheetDto;

describe('табличный документ', () => {
	test('показывает текст, параметр и область', () => {
		const html = renderSpreadsheetHtml(sheet, 'Накладная', 'nonce', webviewDir);
		assert.match(html, /Накладная/);
		assert.match(html, /class="param"[^>]*>&#60;Организация&#62;/);
		assert.match(html, /<nav class="areas">/);
		assert.match(html, /<nav class="areas-top">/);
		assert.match(html, /Заголовок/);
		assert.match(html, /Колонка/);
		assert.match(html, /border-bottom:1px solid #222/);
		assert.match(html, /border-right:1px solid #222/);
		assert.doesNotMatch(html, /<h1>/);
		assert.equal(html.split('<thead>').length - 1, 1);
		assert.match(html, /nonce-nonce/);
	});
});
