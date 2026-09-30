/**
 * Остановка контейнера, запущенного командой расширения.
 *
 * Клиент `docker run` живёт на хосте, а контейнер в демоне: завершение дерева
 * процессов его не снимает.
 *
 * @module dockerRun
 */

import { execFile } from 'node:child_process';
import type { CommandRun } from './cancellableProcess';
import { logger } from './logger';

const log = logger.scope('vrunner');

/** Сколько секунд контейнер закрывается после SIGTERM, прежде чем демон пошлёт SIGKILL. */
export const DOCKER_STOP_TIMEOUT_SECONDS = 30;

/**
 * Вызов программы `docker`. Промис не отклоняется: остановка и уборка
 * контейнера, которого уже нет, ошибкой не считаются.
 */
export type DockerCli = (args: readonly string[], timeoutMs: number) => Promise<void>;

const dockerCli: DockerCli = (args, timeoutMs) =>
	new Promise((resolve) => {
		execFile('docker', args, { timeout: timeoutMs, windowsHide: true }, (error) => {
			if (error) {
				log.debug(`docker ${args.join(' ')}: ${error.message}`);
			}
			resolve();
		});
	});

/**
 * Имя контейнера для одного запуска.
 *
 * @returns Уникальное имя вида `1cpt-run-<метка>`
 */
export function dockerContainerName(): string {
	return `1cpt-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Запуск в контейнере с новым именем: отмена останавливает контейнер по нему,
 * а после выхода клиента убирает его.
 *
 * Имя берётся на каждый вызов: демон отказывает запуску с именем контейнера,
 * который ещё останавливается после прошлой отмены.
 *
 * @param build - Строит команду `docker run` с заданным именем контейнера
 * @param docker - Вызов программы `docker`
 * @returns Команда и уборка при отмене
 */
export function dockerCommandRun(build: (containerName: string) => string, docker: DockerCli = dockerCli): CommandRun {
	const containerName = dockerContainerName();
	let stopped: Promise<void> = Promise.resolve();
	return {
		command: build(containerName),
		onCancel: () => {
			stopped = stopDockerContainer(containerName, docker);
			return stopped;
		},
		onCancelled: () => {
			void stopped.then(() => removeDockerContainer(containerName, docker));
		},
	};
}

/**
 * Останавливает контейнер запуска: процессы получают SIGTERM и время закрыться.
 *
 * @param containerName - Имя контейнера из {@link dockerContainerName}
 * @param docker - Вызов программы `docker`
 * @returns Промис, который разрешается, когда контейнер остановлен
 */
export function stopDockerContainer(containerName: string, docker: DockerCli = dockerCli): Promise<void> {
	log.info(`Отмена: останавливаю контейнер ${containerName}`);
	return docker(['stop', '-t', String(DOCKER_STOP_TIMEOUT_SECONDS), containerName], (DOCKER_STOP_TIMEOUT_SECONDS + 30) * 1000);
}

/**
 * Убирает контейнер, который клиент `docker run --rm` оставил после отмены:
 * созданный, но ещё не запущенный, `--rm` не удаляет, а запущенный за миг
 * до завершения клиента продолжает работать.
 *
 * @param containerName - Имя контейнера из {@link dockerContainerName}
 * @param docker - Вызов программы `docker`
 * @returns Промис, который разрешается после вызова
 */
export function removeDockerContainer(containerName: string, docker: DockerCli = dockerCli): Promise<void> {
	return docker(['rm', '-f', containerName], 30000);
}
