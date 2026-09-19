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
 * @returns Команда и уборка при отмене
 */
export function dockerCommandRun(build: (containerName: string) => string): CommandRun {
	const containerName = dockerContainerName();
	return {
		command: build(containerName),
		onCancel: () => stopDockerContainer(containerName),
		onCancelled: () => removeDockerContainer(containerName),
	};
}

/**
 * Останавливает контейнер запуска.
 *
 * @param containerName - Имя контейнера из {@link dockerContainerName}
 */
export function stopDockerContainer(containerName: string): void {
	log.info(`Отмена: останавливаю контейнер ${containerName}`);
	execFile('docker', ['stop', containerName], { timeout: 30000, windowsHide: true }, (error) => {
		if (error) {
			// Контейнер мог остановиться сам вместе с клиентом: это не ошибка
			log.debug(`docker stop ${containerName}: ${error.message}`);
		}
	});
}

/**
 * Убирает контейнер, который клиент `docker run --rm` оставил после отмены:
 * созданный, но ещё не запущенный, `--rm` не удаляет, а запущенный за миг
 * до завершения клиента продолжает работать.
 *
 * @param containerName - Имя контейнера из {@link dockerContainerName}
 */
export function removeDockerContainer(containerName: string): void {
	execFile('docker', ['rm', '-f', containerName], { timeout: 30000, windowsHide: true }, (error) => {
		if (error) {
			// Контейнер уже удалён вместе с клиентом: это не ошибка
			log.debug(`docker rm ${containerName}: ${error.message}`);
		}
	});
}
