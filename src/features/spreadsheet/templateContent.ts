/**
 * Файл содержимого макета на диске.
 *
 * Вид макета решает расширение: у EDT табличный документ — `Template.mxlx`,
 * схема компоновки — `Template.dcs`. У выгрузки конфигуратора содержимое лежит
 * в `Ext/Template.xml`, и вид виден по корню файла.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { objectDirectoryOf } from '../../shared/objectPaths';

const CONTENT_EXTENSIONS = ['.mxlx', '.xml', '.dcs', '.txt', '.html', '.htm', '.bin', '.addin'];

export type TemplateContentKind = 'spreadsheet' | 'dcs' | 'text' | 'binary';

/** Каталог макета: у общего макета это каталог самого объекта. */
export function templateFolderOf(objectFile: string, templateName?: string): string {
	const directory = objectDirectoryOf(objectFile);
	return templateName === undefined ? directory : path.join(directory, 'Templates', templateName);
}

/** Файл содержимого: сначала `Ext`, затем каталог макета. */
export async function findTemplateContent(objectFile: string, templateName?: string): Promise<string | undefined> {
	const folder = templateFolderOf(objectFile, templateName);
	return (await pickContent(path.join(folder, 'Ext'))) ?? pickContent(folder);
}

/** Вид содержимого: куда открывать макет. */
export async function classifyTemplateContent(filePath: string): Promise<TemplateContentKind> {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === '.mxlx') {
		return 'spreadsheet';
	}
	if (extension === '.dcs') {
		return 'dcs';
	}
	if (extension === '.bin' || extension === '.addin') {
		return 'binary';
	}
	if (extension !== '.xml') {
		return 'text';
	}
	return kindFromHead(await readHead(filePath));
}

/** Токен меню: команда только для своего вида макета. */
export function templateMenuToken(objectFile: string, templateName?: string): 'mdSpreadsheet' | 'mdDcs' | undefined {
	try {
		const file = findTemplateContentSync(objectFile, templateName);
		if (!file) {
			return undefined;
		}
		const kind = classifyTemplateContentSync(file);
		if (kind === 'spreadsheet') {
			return 'mdSpreadsheet';
		}
		if (kind === 'dcs') {
			return 'mdDcs';
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function classifyTemplateContentSync(filePath: string): TemplateContentKind {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === '.mxlx') {
		return 'spreadsheet';
	}
	if (extension === '.dcs') {
		return 'dcs';
	}
	if (extension === '.bin' || extension === '.addin') {
		return 'binary';
	}
	if (extension !== '.xml') {
		return 'text';
	}
	const fd = fsSync.openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(8192);
		const bytesRead = fsSync.readSync(fd, buffer, 0, buffer.length, 0);
		return kindFromHead(buffer.subarray(0, bytesRead).toString('utf8'));
	} finally {
		fsSync.closeSync(fd);
	}
}

function findTemplateContentSync(objectFile: string, templateName?: string): string | undefined {
	const folder = templateFolderOf(objectFile, templateName);
	return pickContentSync(path.join(folder, 'Ext')) ?? pickContentSync(folder);
}

function kindFromHead(head: string): TemplateContentKind {
	if (head.includes('8.2/data/spreadsheet')) {
		return 'spreadsheet';
	}
	if (head.includes('DataCompositionSchema') || head.includes('data-composition-system/schema')) {
		return 'dcs';
	}
	return 'text';
}

async function pickContent(directory: string): Promise<string | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch {
		return undefined;
	}
	const files = names.filter((name) => name.toLowerCase().startsWith('template.'));
	files.sort((left, right) => rank(left) - rank(right));
	const chosen = files[0];
	return chosen === undefined ? undefined : path.join(directory, chosen);
}

function pickContentSync(directory: string): string | undefined {
	let names: string[];
	try {
		names = fsSync.readdirSync(directory);
	} catch {
		return undefined;
	}
	const files = names.filter((name) => name.toLowerCase().startsWith('template.'));
	files.sort((left, right) => rank(left) - rank(right));
	const chosen = files[0];
	return chosen === undefined ? undefined : path.join(directory, chosen);
}

function rank(name: string): number {
	const index = CONTENT_EXTENSIONS.indexOf(path.extname(name).toLowerCase());
	return index < 0 ? CONTENT_EXTENSIONS.length : index;
}

async function readHead(filePath: string): Promise<string> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}
