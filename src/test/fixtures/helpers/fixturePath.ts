import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Путь внутри src/test/fixtures.
 *
 * Тесты бандлятся в out/, поэтому корень проекта ищется по package.json, а не от __dirname.
 *
 * @param segments - Путь внутри каталога фикстур
 * @returns Абсолютный путь
 */
export function fixturePath(...segments: string[]): string {
	let dir = __dirname;
	while (!fs.existsSync(path.join(dir, 'package.json'))) {
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(`Не найден корень проекта для фикстуры ${segments.join('/')}`);
		}
		dir = parent;
	}
	return path.join(dir, 'src', 'test', 'fixtures', ...segments);
}
