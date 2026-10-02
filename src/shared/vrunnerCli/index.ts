/**
 * Слой CLI-адаптеров vanessa-runner: выбор адаптера по версии.
 *
 * См. {@link VRunnerIntent} — семантические намерения команд расширения,
 * {@link V2CliAdapter}/{@link V3CliAdapter} — рендер в синтаксис конкретной
 * мажорной версии.
 */

import { VRunnerVersion, isV3Cli } from '../vrunnerVersion';
import { VRunnerCliAdapter } from './intents';
import { V2CliAdapter } from './v2Adapter';
import { V3CliAdapter } from './v3Adapter';

export * from './intents';
export { V2CliAdapter } from './v2Adapter';
export { V3CliAdapter } from './v3Adapter';

const v2Adapter = new V2CliAdapter();
const v3Adapter = new V3CliAdapter();

/**
 * Адаптер CLI для версии vanessa-runner.
 *
 * @param version - Версия vrunner или undefined
 * @returns Адаптер мажорной версии
 */
export function selectCliAdapter(version: VRunnerVersion | undefined): VRunnerCliAdapter {
	return isV3Cli(version) ? v3Adapter : v2Adapter;
}
