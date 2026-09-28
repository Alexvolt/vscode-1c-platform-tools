/**
 * Релизы YAxUnit: выбор файла расширения и версии.
 * Запуск: npm run compile && node --test out/test/testing/yaxunitReleases.node.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { latestYaxunitRelease, parseYaxunitReleases } from '../../features/testing/yaxunitReleases';

/** Релиз в виде ответа GitHub API. */
function release(tag: string, assets: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: tag,
		prerelease: false,
		draft: false,
		assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${tag}/${name}` })),
		...extra,
	};
}

describe('релизы YAxUnit', () => {
	test('из релиза берётся YAxUnit, а не Smoke', () => {
		const [found] = parseYaxunitReleases([release('25.12', ['Smoke-25.12.cfe', 'YAxUnit-25.12.cfe'])]);

		assert.equal(found.tag, '25.12');
		assert.equal(found.assetName, 'YAxUnit-25.12.cfe');
		assert.equal(found.assetUrl, 'https://example.test/25.12/YAxUnit-25.12.cfe');
	});

	test('старое имя файла без версии тоже подходит', () => {
		const [found] = parseYaxunitReleases([release('22.11', ['yaxunit.cfe'])]);

		assert.equal(found.assetName, 'yaxunit.cfe');
	});

	test('черновики, релизы без файла и чужие данные пропускаются', () => {
		const found = parseYaxunitReleases([
			release('26.01', ['YAxUnit-26.01.cfe'], { draft: true }),
			release('25.13', ['sources.zip']),
			null,
			{ tag_name: 1 },
			release('25.12', ['YAxUnit-25.12.cfe']),
		]);

		assert.deepEqual(found.map((item) => item.tag), ['25.12']);
		assert.deepEqual(parseYaxunitReleases({ message: 'API rate limit exceeded' }), []);
	});

	test('по умолчанию последний стабильный, а без стабильных самый новый', () => {
		const releases = parseYaxunitReleases([
			release('26.01', ['YAxUnit-26.01.cfe'], { prerelease: true }),
			release('25.12', ['YAxUnit-25.12.cfe']),
			release('25.04', ['YAxUnit-25.04.cfe']),
		]);

		assert.equal(latestYaxunitRelease(releases)?.tag, '25.12');
		assert.equal(latestYaxunitRelease(releases.slice(0, 1))?.tag, '26.01');
		assert.equal(latestYaxunitRelease([]), undefined);
	});
});
