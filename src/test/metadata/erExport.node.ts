/**
 * Экспорт ER-диаграммы в SVG.
 * Запуск: npm run compile && node --test out/test/metadata/erExport.node.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { boxExit } from '../../webviews/metadataErCanvas/geometry';

describe('ER: концы связи в экспорте SVG', () => {
	const box = { x: 0, y: 0, width: 100, height: 40 };

	test('связь выходит из узла на его краю, а не из центра', () => {
		// Стрелка в центре цели пряталась под прямоугольником узла
		assert.deepEqual(boxExit(box, { x: 300, y: 20 }), { x: 100, y: 20 });
		assert.deepEqual(boxExit(box, { x: 50, y: -100 }), { x: 50, y: 0 });
	});

	test('наклонная связь упирается в ближний край', () => {
		const point = boxExit(box, { x: 150, y: 70 });

		assert.equal(point.y, 40);
		assert.ok(point.x > 50 && point.x < 100, String(point.x));
	});

	test('точка внутри узла и совпадающий центр не выносят конец за узел', () => {
		assert.deepEqual(boxExit(box, { x: 60, y: 22 }), { x: 60, y: 22 });
		assert.deepEqual(boxExit(box, { x: 50, y: 20 }), { x: 50, y: 20 });
	});
});
