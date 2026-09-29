/**
 * Виды проектов для списков «Избранное», «Все проекты» и окна выбора проекта.
 *
 * У проекта окна вид берётся из обнаружения. Каталог вне окна проверяется в фоне
 * по одному, раз за сессию; найденное запоминается между сессиями, поэтому
 * список сразу показывает прошлый вид, а новый приходит событием.
 * @module projects/projectKinds
 */

import * as vscode from 'vscode';
import { detectProjectKind, PROJECT_KINDS, type ProjectKind } from '../../shared/projectKind';
import { projectByRoot, projectRootKey } from '../../shared/workspaceProjects';

/** Ключ globalState: вид по ключу корня. */
const KINDS_STATE_KEY = '1c-platform-tools.projects.kinds';

/** Виды проектов по каталогам. */
export class ProjectKinds implements vscode.Disposable {
	private readonly known = new Map<string, ProjectKind>();
	private readonly checked = new Set<string>();
	private readonly queue = new Map<string, string>();
	private draining: Promise<void> | undefined;
	private disposed = false;
	private readonly changed = new vscode.EventEmitter<void>();
	/** Вид какого-то каталога стал известен или сменился. */
	readonly onDidChange = this.changed.event;

	/**
	 * @param memento - Хранилище между сессиями
	 * @param detect - Определение вида каталога
	 * @param windowKind - Вид проекта окна
	 */
	constructor(
		private readonly memento: vscode.Memento | undefined,
		private readonly detect: (root: string) => Promise<ProjectKind | undefined> = detectProjectKind,
		private readonly windowKind: (root: string) => ProjectKind | undefined = (root) => projectByRoot(root)?.kind
	) {
		const saved = memento?.get<Record<string, unknown>>(KINDS_STATE_KEY) ?? {};
		for (const [key, kind] of Object.entries(saved)) {
			if (PROJECT_KINDS.includes(kind as ProjectKind)) {
				this.known.set(key, kind as ProjectKind);
			}
		}
	}

	/**
	 * Известный вид проекта; каталог, не проверенный в этой сессии, проверяется в фоне.
	 *
	 * @param root - Каталог проекта
	 */
	kindOf(root: string): ProjectKind | undefined {
		const inWindow = this.windowKind(root);
		if (inWindow) {
			return inWindow;
		}
		const key = projectRootKey(root);
		if (!this.checked.has(key) && !this.queue.has(key)) {
			this.queue.set(key, root);
			this.draining ??= this.drain().finally(() => {
				this.draining = undefined;
			});
		}
		return this.known.get(key);
	}

	/** Дождаться проверки поставленных каталогов. */
	settled(): Promise<void> {
		return this.draining ?? Promise.resolve();
	}

	dispose(): void {
		this.disposed = true;
		this.queue.clear();
		this.changed.dispose();
	}

	private async drain(): Promise<void> {
		let changed = false;
		for (let next = this.queue.entries().next(); !next.done && !this.disposed; next = this.queue.entries().next()) {
			const [key, root] = next.value;
			this.queue.delete(key);
			this.checked.add(key);
			const kind = await this.detect(root).catch(() => undefined);
			if (kind === this.known.get(key)) {
				continue;
			}
			changed = true;
			if (kind) {
				this.known.set(key, kind);
			} else {
				this.known.delete(key);
			}
		}
		if (changed && !this.disposed) {
			await this.memento?.update(KINDS_STATE_KEY, Object.fromEntries(this.known));
			this.changed.fire();
		}
	}
}
