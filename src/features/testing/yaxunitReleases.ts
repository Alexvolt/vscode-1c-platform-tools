/**
 * Релизы YAxUnit на GitHub: версии, в которых есть файл расширения.
 *
 * @module yaxunitReleases
 */

/** Репозиторий YAxUnit. */
export const YAXUNIT_REPO = { owner: 'bia-technologies', repo: 'yaxunit' } as const;

/** Имя расширения внутри файла: под ним YAxUnit ищут в исходниках и в базе. */
export const YAXUNIT_EXTENSION = 'YAXUNIT';

/** Файл расширения в релизе, например `YAxUnit-25.12.cfe`; рядом лежит `Smoke-*.cfe`, он не нужен. */
const YAXUNIT_ASSET = /^yaxunit[-_.\d]*\.cfe$/i;

/** Сколько последних релизов показывать в выборе версии. */
export const YAXUNIT_RELEASES_PER_PAGE = 30;

/** Релиз YAxUnit с файлом расширения. */
export interface YaxunitRelease {
	readonly tag: string;
	readonly prerelease: boolean;
	readonly assetName: string;
	readonly assetUrl: string;
}

/** Адрес списка релизов в GitHub API. */
export function yaxunitReleasesUrl(): string {
	return `https://api.github.com/repos/${YAXUNIT_REPO.owner}/${YAXUNIT_REPO.repo}/releases?per_page=${YAXUNIT_RELEASES_PER_PAGE}`;
}

/**
 * Релизы из ответа GitHub, в которых есть файл расширения, в том же порядке: новые первыми.
 * Черновики и релизы без файла пропускаются.
 *
 * @param response - Ответ `GET /repos/{owner}/{repo}/releases`
 */
export function parseYaxunitReleases(response: unknown): YaxunitRelease[] {
	if (!Array.isArray(response)) {
		return [];
	}
	const releases: YaxunitRelease[] = [];
	for (const item of response as Array<Record<string, unknown>>) {
		if (item === null || typeof item !== 'object' || item.draft === true || typeof item.tag_name !== 'string') {
			continue;
		}
		const assets = Array.isArray(item.assets) ? (item.assets as Array<Record<string, unknown>>) : [];
		const asset = assets.find(
			(entry) =>
				typeof entry?.name === 'string' &&
				typeof entry.browser_download_url === 'string' &&
				YAXUNIT_ASSET.test(entry.name)
		);
		if (asset) {
			releases.push({
				tag: item.tag_name,
				prerelease: item.prerelease === true,
				assetName: asset.name as string,
				assetUrl: asset.browser_download_url as string,
			});
		}
	}
	return releases;
}

/** Последний стабильный релиз, а без стабильных самый новый. */
export function latestYaxunitRelease(releases: readonly YaxunitRelease[]): YaxunitRelease | undefined {
	return releases.find((release) => !release.prerelease) ?? releases[0];
}
