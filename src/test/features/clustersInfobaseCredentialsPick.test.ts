import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
	buildSetPicks,
	isInfobaseRejection,
} from '../../features/clusters/infobaseCredentialsPick';
import { describeRacFailure } from '../../features/clusters/racOutput';

suite('выбор набора для базы', () => {
	test('сохранённые наборы идут первыми, создание нового — после разделителя', () => {
		const picks = buildSetPicks([
			{ id: 'set-1', name: 'Бухгалтерия', user: 'Админ', kind: 'infobase' },
			{ id: 'set-2', name: 'Склад', user: 'Кладовщик', kind: 'infobase' },
		]);

		assert.deepStrictEqual(
			picks.map((pick) => [pick.label, pick.description, pick.set?.id]),
			[
				['Бухгалтерия', 'Админ', 'set-1'],
				['Склад', 'Кладовщик', 'set-2'],
				['', undefined, undefined],
				['$(add) Новый набор', undefined, undefined],
			]
		);
		assert.strictEqual(picks[2].kind, vscode.QuickPickItemKind.Separator);
	});

	test('без наборов остаётся только создание нового', () => {
		assert.deepStrictEqual(
			buildSetPicks([]).map((pick) => pick.label),
			['$(add) Новый набор']
		);
	});

	test('повторный выбор предлагается только на отказ самой базы', () => {
		assert.strictEqual(
			isInfobaseRejection(describeRacFailure(1, '', 'Недостаточно прав пользователя на информационную базу')),
			true
		);
		assert.strictEqual(
			isInfobaseRejection(describeRacFailure(1, '', 'Администратор кластера не аутентифицирован')),
			false
		);
		assert.strictEqual(
			isInfobaseRejection(describeRacFailure(1, '', 'Ошибка соединения с сервером администрирования')),
			false
		);
	});
});
