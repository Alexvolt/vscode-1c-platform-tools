/**
 * Назначение учётных данных администратора информационной базы.
 *
 * Базе назначается сохранённый набор или новый, заведённый тут же. Набор
 * сначала проверяется на самой базе: неподходящий не привязывается.
 */

import * as vscode from 'vscode';
import type { ClusterService } from './clusterService';
import type { ClusterCredentialStore, CredentialSet } from './credentials';
import type { ClusterConnection } from './model';
import type { AccessChoice } from './propertiesPanel';
import type { RacCredentials } from './racArgs';
import type { RacFailure } from './racOutput';

/** База, которой назначается набор. */
export interface InfobaseCredentialsTarget {
	connection: ClusterConnection;
	clusterId: string;
	infobase: { id: string; name: string };
}

/** Зависимости назначения. */
export interface InfobaseCredentialsDeps {
	credentials: ClusterCredentialStore;
	service: ClusterService;
}

/** Итог назначения. */
export type GrantResult =
	| { ok: true; set: CredentialSet }
	| { ok: false; message: string; rejected: boolean };

/** Строка списка: сохранённый набор или создание нового. */
interface SetPick extends vscode.QuickPickItem {
	set?: CredentialSet;
}

/**
 * Относится ли отказ к самой базе.
 *
 * Отказ с ролью кластера или центрального сервера другим набором базы не
 * исправить.
 *
 * @param failure - Разобранная неудача
 * @returns true, если база не приняла пользователя
 */
export function isInfobaseRejection(failure: RacFailure): boolean {
	return failure.kind === 'auth' && failure.role !== 'cluster' && failure.role !== 'agent';
}

/**
 * Проверяет набор на базе и привязывает его.
 *
 * Новый набор сохраняется только после того, как база его приняла.
 *
 * @param deps - Хранилище наборов и сервис кластера
 * @param target - База
 * @param choice - Сохранённый набор или данные нового
 * @returns Привязанный набор или причина отказа
 */
export async function grantInfobaseCredentials(
	deps: InfobaseCredentialsDeps,
	target: InfobaseCredentialsTarget,
	choice: AccessChoice
): Promise<GrantResult> {
	const { credentials, service } = deps;
	const { connection, clusterId, infobase } = target;
	const existing = 'setId' in choice ? credentials.get(choice.setId) : undefined;
	let user: string;
	let password: string;
	let name = '';
	if ('setId' in choice) {
		if (!existing) {
			return { ok: false, message: 'Набор не найден', rejected: false };
		}
		user = existing.user;
		password = (await credentials.password(existing.id)) ?? '';
	} else {
		user = choice.user.trim();
		password = choice.password;
		name = choice.name.trim() || user;
		if (user === '') {
			return { ok: false, message: 'Не задано имя пользователя', rejected: false };
		}
	}
	const auth: RacCredentials = { user, password };
	const check = await service.checkInfobaseAdmin(connection, clusterId, infobase.id, auth);
	if (!check.ok) {
		const rejected = isInfobaseRejection(check.failure);
		return {
			ok: false,
			message: rejected ? `База не приняла пользователя «${user}»` : check.failure.message,
			rejected,
		};
	}
	const set = existing ?? (await credentials.add({ name, user, kind: 'infobase' }, password));
	await credentials.bindInfobase({
		connectionId: connection.id,
		clusterId,
		infobaseId: infobase.id,
		setId: set.id,
		connectionName: connection.name,
		infobaseName: infobase.name,
	});
	return { ok: true, set };
}

/**
 * Собирает строки списка наборов.
 *
 * @param sets - Наборы администраторов баз
 * @returns Наборы и строка создания нового
 */
export function buildSetPicks(sets: CredentialSet[]): SetPick[] {
	const picks: SetPick[] = sets.map((set) => ({ label: set.name, description: set.user, set }));
	if (picks.length > 0) {
		picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	}
	picks.push({ label: '$(add) Новый набор' });
	return picks;
}

/**
 * Спрашивает пользователя, пароль и название нового набора.
 *
 * @param infobaseName - Имя базы для заголовка
 * @returns Данные набора или undefined при отказе
 */
async function promptNewSet(infobaseName: string): Promise<AccessChoice | undefined> {
	const title = `Новый набор для «${infobaseName}»`;
	const required = (value: string) => (value.trim() === '' ? 'Поле не заполнено' : undefined);
	const user = await vscode.window.showInputBox({
		title,
		prompt: 'Имя пользователя информационной базы',
		ignoreFocusOut: true,
		validateInput: required,
	});
	if (user === undefined) {
		return undefined;
	}
	const password = await vscode.window.showInputBox({
		title,
		prompt: `Пароль пользователя «${user.trim()}»`,
		password: true,
		ignoreFocusOut: true,
	});
	if (password === undefined) {
		return undefined;
	}
	const name = await vscode.window.showInputBox({
		title,
		prompt: 'Название набора',
		value: user.trim(),
		ignoreFocusOut: true,
		validateInput: required,
	});
	if (name === undefined) {
		return undefined;
	}
	return { name, user, password };
}

/**
 * Предлагает набор для базы списком и привязывает его.
 *
 * Если база не приняла набор, выбор предлагается снова.
 *
 * @param deps - Хранилище наборов и сервис кластера
 * @param target - База
 * @returns Привязанный набор или undefined, если выбор не состоялся
 */
export async function chooseInfobaseCredentials(
	deps: InfobaseCredentialsDeps,
	target: InfobaseCredentialsTarget
): Promise<CredentialSet | undefined> {
	const { infobase } = target;
	let rejection: string | undefined;
	for (;;) {
		const picked = await vscode.window.showQuickPick(buildSetPicks(deps.credentials.list('infobase')), {
			title: `Учётные данные для «${infobase.name}»`,
			placeHolder: rejection ?? 'Набор администратора информационной базы',
			ignoreFocusOut: true,
		});
		if (!picked) {
			return undefined;
		}
		const choice = picked.set ? { setId: picked.set.id } : await promptNewSet(infobase.name);
		if (!choice) {
			return undefined;
		}
		const granted = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Проверяю набор для «${infobase.name}»` },
			() => grantInfobaseCredentials(deps, target, choice)
		);
		if (granted.ok) {
			return granted.set;
		}
		if (!granted.rejected) {
			void vscode.window.showErrorMessage(granted.message);
			return undefined;
		}
		rejection = `${granted.message}: выберите другой набор`;
	}
}
