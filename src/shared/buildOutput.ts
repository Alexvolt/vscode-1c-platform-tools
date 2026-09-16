/**
 * Каталог и имя собранного файла, заданные вызовом команды.
 *
 * Агент и шаг цепочки передают `outputDirectory` и `outputName`. В обоих можно
 * подставить сведения об объекте: `${name}`, `${folder}`, `${version}`,
 * `${gitBranch}`. Значения переменных собирает команда, модуль их только
 * подставляет и проверяет результат.
 *
 * @module buildOutput
 */

import * as path from 'node:path';

/** Тип собираемого файла: он же расширение файла. */
export type BuildFileType = 'cf' | 'cfe' | 'epf' | 'erf';

/** Переменные шаблона. */
export const BUILD_OUTPUT_VARIABLES = ['name', 'folder', 'version', 'gitBranch'] as const;

export type BuildOutputVariable = (typeof BUILD_OUTPUT_VARIABLES)[number];

/** Параметры вызова, которые задают путь результата. */
export interface BuildOutputOptions {
	/** Каталог результата: относительно корня проекта либо абсолютный. */
	outputDirectory?: unknown;
	/** Имя файла без расширения. */
	outputName?: unknown;
}

/** Собираемый объект. */
export interface BuildOutputTarget {
	/** Объект в родительном падеже для сообщений: «расширения «МоёРасширение»». */
	label: string;
	type: BuildFileType;
	/** Каталог по умолчанию относительно корня проекта. */
	directory: string;
	/** Имя файла по умолчанию без расширения. */
	name: string;
	/** Значения переменных; переменной без значения у объекта нет. */
	variables: Partial<Record<BuildOutputVariable, string>>;
	/** Почему у объекта нет значения переменной. */
	unavailable?: Partial<Record<BuildOutputVariable, string>>;
}

type Field = keyof BuildOutputOptions;

const VARIABLE_RE = /\$\{([^}]*)\}/g;

/** Символы, недопустимые в имени файла Windows. */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Строка параметра без пробелов по краям; пустая строка равна отсутствию. */
function readField(options: BuildOutputOptions, field: Field): { value?: string } | { error: string } {
	const raw = options[field];
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== 'string') {
		return { error: `Параметр ${field} должен быть строкой` };
	}
	const value = raw.trim();
	return value.length > 0 ? { value } : {};
}

/**
 * Задан ли путь результата.
 *
 * @param options - Параметры вызова
 */
export function hasBuildOutput(options: BuildOutputOptions | undefined): boolean {
	if (!options) {
		return false;
	}
	return (['outputDirectory', 'outputName'] as const).some((field) => {
		const read = readField(options, field);
		return 'error' in read || read.value !== undefined;
	});
}

/**
 * Переменные, которые встречаются в параметрах.
 *
 * Команда читает дорогие значения, например версию, только когда они нужны.
 *
 * @param options - Параметры вызова
 * @returns Переменные либо ошибка про незнакомую переменную или тип параметра
 */
export function buildOutputVariables(
	options: BuildOutputOptions
): { variables: Set<BuildOutputVariable> } | { error: string } {
	const variables = new Set<BuildOutputVariable>();
	for (const field of ['outputDirectory', 'outputName'] as const) {
		const read = readField(options, field);
		if ('error' in read) {
			return read;
		}
		for (const match of (read.value ?? '').matchAll(VARIABLE_RE)) {
			const variable = BUILD_OUTPUT_VARIABLES.find((name) => name === match[1]);
			if (variable === undefined) {
				const known = BUILD_OUTPUT_VARIABLES.map((name) => `\${${name}}`).join(', ');
				return { error: `Неизвестная переменная \${${match[1]}} в ${field}, доступны ${known}` };
			}
			variables.add(variable);
		}
	}
	return { variables };
}

/** Подставляет переменные объекта; символы значения, которые ломают путь, заменяются. */
function substitute(template: string, target: BuildOutputTarget): { value: string } | { error: string } {
	let missing: BuildOutputVariable | undefined;
	const value = template.replace(VARIABLE_RE, (_, name: string) => {
		const variable = name as BuildOutputVariable;
		const substituted = target.variables[variable]?.replace(FORBIDDEN_NAME_CHARS, '_').trim();
		if (!substituted) {
			missing ??= variable;
			return '';
		}
		return substituted;
	});
	if (missing === undefined) {
		return { value };
	}
	const reason = target.unavailable?.[missing];
	return { error: `Нет значения \${${missing}} для ${target.label}${reason ? `: ${reason}` : ''}` };
}

/** Каталог через прямые разделители, без хвостового. */
function normalizeDirectory(value: string): string {
	const slashed = value.replaceAll('\\', '/');
	if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) {
		return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
	}
	return path.posix.normalize(slashed).replace(/\/+$/, '') || '.';
}

/** Имя файла по шаблону без расширения. */
function resolveName(template: string, target: BuildOutputTarget): { name: string } | { error: string } {
	if (/[/\\]/.test(template)) {
		return { error: 'outputName задаёт только имя файла, каталог передаётся в outputDirectory' };
	}
	const substituted = substitute(template, target);
	if ('error' in substituted) {
		return substituted;
	}
	let name = substituted.value.trim();
	const extension = `.${target.type}`;
	if (name.toLowerCase().endsWith(extension)) {
		name = name.slice(0, -extension.length);
	}
	if (new RegExp(FORBIDDEN_NAME_CHARS.source).test(name)) {
		return { error: `В имени файла «${name}» есть недопустимые символы` };
	}
	if (name === '' || name === '.' || name === '..') {
		return { error: `Пустое имя файла для ${target.label}` };
	}
	return { name };
}

/** Путь файла одного объекта. */
function resolveTarget(
	target: BuildOutputTarget,
	directoryTemplate: string | undefined,
	nameTemplate: string | undefined
): { file: string } | { error: string } {
	let directory = target.directory;
	if (directoryTemplate !== undefined) {
		const substituted = substitute(directoryTemplate, target);
		if ('error' in substituted) {
			return substituted;
		}
		directory = substituted.value;
	}
	let name = target.name;
	if (nameTemplate !== undefined) {
		const resolved = resolveName(nameTemplate, target);
		if ('error' in resolved) {
			return resolved;
		}
		name = resolved.name;
	}
	return { file: path.posix.join(normalizeDirectory(directory), `${name}.${target.type}`) };
}

/**
 * Пути собранных файлов в порядке объектов.
 *
 * Без параметров каждый объект получает свой путь по умолчанию. Одинаковые пути
 * у разных объектов - ошибка: файл одного затёр бы файл другого.
 *
 * @param targets - Собираемые объекты
 * @param options - Параметры вызова
 * @returns Пути относительно корня проекта или абсолютные либо ошибка
 */
export function resolveBuildOutputs(
	targets: readonly BuildOutputTarget[],
	options: BuildOutputOptions
): { files: string[] } | { error: string } {
	const directory = readField(options, 'outputDirectory');
	if ('error' in directory) {
		return directory;
	}
	const name = readField(options, 'outputName');
	if ('error' in name) {
		return name;
	}

	const files: string[] = [];
	const owners = new Map<string, { file: string; labels: string[] }>();
	for (const target of targets) {
		const resolved = resolveTarget(target, directory.value, name.value);
		if ('error' in resolved) {
			return resolved;
		}
		files.push(resolved.file);
		const key = resolved.file.toLowerCase();
		const owner = owners.get(key) ?? { file: resolved.file, labels: [] };
		owner.labels.push(target.label);
		owners.set(key, owner);
	}

	const conflicts = [...owners.values()]
		.filter((owner) => owner.labels.length > 1)
		.map((owner) => `${owner.file}: для ${owner.labels.join(' и ')}`);
	if (conflicts.length > 0) {
		return { error: `Несколько объектов получают один файл\n${conflicts.join('\n')}` };
	}
	return { files };
}
