import * as assert from 'node:assert';
import { measureLabel } from '../../features/debug/measure';

suite('Замер производительности: подпись строки', () => {
	test('подпись показывает выполнения, время и долю', () => {
		assert.strictEqual(measureLabel({ count: 1250, seconds: 0.3124, serverCall: false }, 1.67), '1250 × 312.4 мс · 18.7 %');
	});

	test('серверный вызов отмечен молнией текстового начертания, а не эмодзи', () => {
		const label = measureLabel({ count: 1, seconds: 1, serverCall: true }, 2);

		assert.ok(label.endsWith('⚡︎'), label);
	});
});
